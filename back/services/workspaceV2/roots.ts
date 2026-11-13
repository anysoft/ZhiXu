import fs from 'fs/promises';
import { constants, Stats } from 'fs';
import path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { observeChildProcess } from '../../shared/childProcess';
import { inheritedLeaseFds } from '../backup/inheritedLeases';
import config from '../../config';
import {
  privateDirectory,
  privateJson,
  readJson,
  syncDirectory,
} from '../backup/files';
import { fail, WorkspaceFoundationError } from './errors';
import { OWNER_MARKER } from './inventory';
import type { FaultHook, WorkspaceRow } from './types';

export { OWNER_MARKER } from './inventory';

export interface WorkspaceRootMarker {
  version: 1;
  workspace_id: number;
  type: WorkspaceRow['type'];
  root_key: string;
  owner_token: string;
  dev: number;
  ino: number;
}

export interface OwnedWorkspaceRoot {
  root: string;
  dev: number;
  ino: number;
  marker: WorkspaceRootMarker;
  stat: Stats;
  identity: { dev: number; ino: number; owner_token: string };
}

interface StageProof extends WorkspaceRootMarker {
  operation_id: string;
}

async function newPrivateJson(file: string, value: object) {
  const handle = await fs.open(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

export async function renameWorkspaceExclusive(
  source: string,
  destination: string,
) {
  const child = spawn(
    '/usr/bin/python3',
    [
      '-I',
      '-S',
      path.join(config.rootPath, 'shell/workspace_rename.py'),
      source,
      destination,
    ],
    { stdio: ['pipe', 'pipe', 'pipe', ...inheritedLeaseFds()] },
  ) as ChildProcessWithoutNullStreams;
  child.stdin.end();
  const result = await observeChildProcess(child).completed;
  if (result.error || result.code !== 0)
    fail(
      result.code === 17
        ? 'WORKSPACE_DESTINATION_EXISTS'
        : 'WORKSPACE_RECOVERY_REQUIRED',
    );
}

function isMarker(value: unknown): value is WorkspaceRootMarker {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    row.version === 1 &&
    Number.isSafeInteger(row.workspace_id) &&
    Number(row.workspace_id) > 0 &&
    (row.type === 'LOCAL' || row.type === 'GIT') &&
    typeof row.root_key === 'string' &&
    typeof row.owner_token === 'string' &&
    row.owner_token.length > 0 &&
    Number.isSafeInteger(row.dev) &&
    Number(row.dev) >= 0 &&
    Number.isSafeInteger(row.ino) &&
    Number(row.ino) > 0
  );
}

/** Only explicit v2 data roots; no configuration or database default is accepted. */
export class WorkspaceRootResolver {
  readonly dataRoot: string;
  constructor(dataRoot: string, private readonly fault?: FaultHook) {
    if (
      !path.isAbsolute(dataRoot) ||
      path.resolve(dataRoot) === path.parse(dataRoot).root
    )
      fail('WORKSPACE_PATH_INVALID', 400);
    this.dataRoot = path.resolve(dataRoot);
  }

  async root() {
    return privateDirectory(this.dataRoot);
  }

  path(row: Pick<WorkspaceRow, 'id' | 'type' | 'root_key'>): string {
    if (
      !Number.isSafeInteger(row.id) ||
      row.id <= 0 ||
      !['LOCAL', 'GIT'].includes(row.type)
    )
      fail('WORKSPACE_PATH_INVALID', 400);
    const key = `workspaces/${row.type.toLowerCase()}/ws-${row.id}`;
    if (row.root_key !== key) fail('WORKSPACE_PATH_INVALID', 400);
    return path.join(this.dataRoot, key);
  }

  async directory(relative: string, create = false): Promise<string> {
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            /[\\\x00-\x1f\x7f]/.test(part),
        )
    )
      fail('WORKSPACE_PATH_INVALID', 400);
    let current = await this.root();
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if (create) {
        await fs
          .mkdir(current, { mode: 0o700 })
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          });
      }
      const stat = await fs.lstat(current);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (process.getuid && stat.uid !== process.getuid()) ||
        stat.mode & 0o077
      )
        fail('WORKSPACE_PATH_FORBIDDEN', 403);
    }
    return current;
  }

  private checkMarker(row: WorkspaceRow, marker: WorkspaceRootMarker) {
    this.path(row);
    if (
      marker.workspace_id !== row.id ||
      marker.type !== row.type ||
      marker.root_key !== row.root_key ||
      (row.root_owner_token !== null &&
        marker.owner_token !== row.root_owner_token)
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
  }

  private async safeRootLocation(root: string): Promise<Stats> {
    const base = await this.root();
    const relative = path.relative(base, root);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith('../') ||
      path.isAbsolute(relative)
    )
      fail('WORKSPACE_PATH_INVALID', 400);
    await this.directory(path.dirname(relative).split(path.sep).join('/'));
    const stat = await fs.lstat(root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid()) ||
      stat.mode & 0o077 ||
      (await fs.realpath(root)) !== root
    )
      fail('WORKSPACE_PATH_FORBIDDEN', 403);
    return stat;
  }

  async verifyAt(
    row: WorkspaceRow,
    root: string,
    checkInode = true,
  ): Promise<OwnedWorkspaceRoot> {
    try {
      const stat = await this.safeRootLocation(root);
      const value: unknown = await readJson(path.join(root, OWNER_MARKER));
      if (!isMarker(value)) fail('WORKSPACE_RECOVERY_REQUIRED');
      this.checkMarker(row, value);
      if (
        checkInode &&
        (value.dev !== stat.dev ||
          value.ino !== stat.ino ||
          (row.root_device !== null && row.root_device !== stat.dev) ||
          (row.root_inode !== null && row.root_inode !== stat.ino))
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
      return {
        root,
        dev: stat.dev,
        ino: stat.ino,
        marker: value,
        stat,
        identity: {
          dev: stat.dev,
          ino: stat.ino,
          owner_token: value.owner_token,
        },
      };
    } catch (error: unknown) {
      if (error instanceof WorkspaceFoundationError) throw error;
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        fail('SOURCE_MISSING');
      fail('WORKSPACE_RECOVERY_REQUIRED');
    }
  }

  async requireOwned(row: WorkspaceRow, overrideRoot?: string) {
    return this.verifyAt(row, overrideRoot ?? this.path(row));
  }

  async requireReady(
    row: WorkspaceRow,
    lease: { workspaceId: number; assertHeld(): Promise<void> },
    readOnly = false,
  ) {
    if (lease.workspaceId !== row.id) fail('WORKSPACE_BUSY');
    await lease.assertHeld();
    if (!readOnly && row.lifecycle_state === 'ARCHIVED')
      fail('WORKSPACE_ARCHIVED');
    if (
      row.storage_state !== 'PRESENT' ||
      !(
        row.lifecycle_state === 'READY' ||
        (readOnly && row.lifecycle_state === 'ARCHIVED')
      )
    )
      fail(
        row.lifecycle_state === 'RECOVERY_REQUIRED'
          ? 'WORKSPACE_RECOVERY_REQUIRED'
          : 'WORKSPACE_NOT_READY',
      );
    return this.requireOwned(row);
  }

  async createOwned(
    row: WorkspaceRow,
    ownerToken: string,
    operationId: string,
    populate?: (stagingRoot: string) => Promise<void>,
    recoverPopulate?: (stagingRoot: string) => Promise<void>,
  ): Promise<OwnedWorkspaceRoot> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId) || !ownerToken)
      fail('WORKSPACE_PATH_INVALID', 400);
    if (
      row.lifecycle_state !== 'CREATING' ||
      row.storage_state !== 'PROVISIONING'
    )
      fail('WORKSPACE_NOT_READY');
    const root = this.path(row);
    await this.directory(path.dirname(row.root_key), true);
    const stageParent = await this.directory('tmp/workspace-v2/staging', true);
    const staging = path.join(stageParent, operationId);
    const proofFile = path.join(stageParent, `.stage-${operationId}.json`);
    try {
      await fs.lstat(root);
      const current = await this.verifyAt(row, root);
      if (current.marker.owner_token !== ownerToken)
        fail('WORKSPACE_RECOVERY_REQUIRED');
      const retained = await fs
        .lstat(proofFile)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
      if (retained) {
        const proof: unknown = await readJson(proofFile);
        if (
          !isMarker(proof) ||
          !('operation_id' in proof) ||
          proof.operation_id !== operationId ||
          proof.owner_token !== ownerToken ||
          proof.dev !== current.dev ||
          proof.ino !== current.ino
        )
          fail('WORKSPACE_RECOVERY_REQUIRED');
        this.checkMarker(row, proof);
        await fs.unlink(proofFile);
        await syncDirectory(stageParent);
      }
      return current;
    } catch (error: unknown) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      )
        throw error;
    }
    let stageStat: Stats;
    try {
      // A sidecar without its stage is unknown data, never a file to overwrite.
      const previousProof = await fs
        .lstat(proofFile)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
      if (previousProof) {
        const existingStage = await fs
          .lstat(staging)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
        if (!existingStage) fail('WORKSPACE_RECOVERY_REQUIRED');
      }
      await fs.mkdir(staging, { mode: 0o700 });
      stageStat = await fs.lstat(staging);
      const proof: StageProof = {
        version: 1,
        workspace_id: row.id,
        type: row.type,
        root_key: row.root_key,
        owner_token: ownerToken,
        dev: stageStat.dev,
        ino: stageStat.ino,
        operation_id: operationId,
      };
      await newPrivateJson(proofFile, proof);
      await this.fault?.('ROOT_STAGE_OWNED', {
        workspace_id: row.id,
        operation_id: operationId,
      });
      await populate?.(staging);
    } catch (error: unknown) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'EEXIST'
        )
      )
        throw error;
      stageStat = await this.safeRootLocation(staging);
      const proof: unknown = await readJson(proofFile);
      if (
        !isMarker(proof) ||
        !('operation_id' in proof) ||
        proof.operation_id !== operationId ||
        proof.owner_token !== ownerToken ||
        proof.dev !== stageStat.dev ||
        proof.ino !== stageStat.ino
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
      this.checkMarker(row, proof);
      // A recovered stage must already have its complete final marker. Unknown
      // partially populated data stays intact for explicit operation recovery.
      const names = await fs.readdir(staging);
      if (row.type === 'LOCAL' && names.length === 0) {
        // Strong adjacent stage proof + unchanged directory identity establishes ownership.
      } else if (
        row.type === 'GIT' &&
        !names.includes(OWNER_MARKER) &&
        recoverPopulate
      ) {
        // The Git adapter explicitly verifies registration, private branch,
        // pinned commit and cleanliness before resuming a proven owned stage.
        await recoverPopulate(staging);
      } else {
        await this.verifyAt(row, staging);
      }
    }
    const marker: WorkspaceRootMarker = {
      version: 1,
      workspace_id: row.id,
      type: row.type,
      root_key: row.root_key,
      owner_token: ownerToken,
      dev: stageStat.dev,
      ino: stageStat.ino,
    };
    const markerFile = path.join(staging, OWNER_MARKER);
    const existingMarker = await fs
      .lstat(markerFile)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    if (existingMarker) {
      const owned = await this.verifyAt(row, staging);
      if (owned.marker.owner_token !== ownerToken)
        fail('WORKSPACE_RECOVERY_REQUIRED');
    } else await newPrivateJson(markerFile, marker);
    await this.fault?.('ROOT_MARKER_DURABLE', {
      workspace_id: row.id,
      operation_id: operationId,
    });
    await renameWorkspaceExclusive(staging, root);
    await syncDirectory(path.dirname(root));
    await syncDirectory(stageParent);
    await this.fault?.('ROOT_PUBLISHED', {
      workspace_id: row.id,
      operation_id: operationId,
    });
    const result = await this.verifyAt(row, root);
    await fs.unlink(proofFile);
    await syncDirectory(stageParent);
    return result;
  }

  /** Restore has already authenticated the copied tree; old dev/ino never become a path. */
  async rebuildOwner(
    row: WorkspaceRow,
    overrideRoot?: string,
  ): Promise<OwnedWorkspaceRoot> {
    const current = await this.verifyAt(
      row,
      overrideRoot ?? this.path(row),
      false,
    );
    const marker = {
      ...current.marker,
      dev: current.stat.dev,
      ino: current.stat.ino,
    };
    await privateJson(path.join(current.root, OWNER_MARKER), marker);
    return {
      ...current,
      dev: current.stat.dev,
      ino: current.stat.ino,
      marker,
      identity: {
        dev: current.stat.dev,
        ino: current.stat.ino,
        owner_token: marker.owner_token,
      },
    };
  }
}
