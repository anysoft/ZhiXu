import fs from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import ConfigMaterializationService, {
  MaterializationLease,
  TaskWorkspace,
  MaterializationConfig,
} from '../configMaterialization';
import ExecutionNodeBinding from '../executionNodeBinding';
import { ConfigRevision } from '../../data/configAsset';
import { WorkspaceStore } from '../workspaceV2/store';
import { WorkspaceRootResolver } from '../workspaceV2/roots';
import { WorkspaceLease } from '../workspaceV2/lease';
import { WorkspaceExecutionPaths } from './paths';
import { fail } from '../workspaceV2/errors';
import { FaultHook, WorkspaceRow } from '../workspaceV2/types';
import { syncDirectory, readJson } from '../backup/files';
import { requireDiskBudget } from '../workspaceV2/inventory';
import { workspaceLimits } from '../workspaceV2/limits';
import { safeParents, atomicPrivateWrite } from '../../shared/configAssets';
import type { CandidateResolvedConfig } from './types';

export type WorkspaceResolvedConfig = CandidateResolvedConfig;

export interface WorkspaceMaterializationContext {
  identity?: { taskRunId: number; taskId: number };
  source: { workspaceId: number; cwd: string };
  workspace: Readonly<TaskWorkspace>;
  runtime: { nodeModulesRoot?: string };
  configSnapshot: readonly WorkspaceResolvedConfig[];
}
export interface MaterializationRecoveryOwner {
  runId: number;
  ownerToken: string | null;
}
interface OwnerProof {
  version: 1;
  operation_token: string;
  workspace_id: number;
  workspace_type: WorkspaceRow['type'];
  resource_key: string;
  root_key: string;
  root_device: number;
  root_inode: number;
  root_owner_token: string;
  source_generation: number;
  task_run_id: number | null;
  run_owner_token: string | null;
}

/** Actual immutable candidate asset bytes; no v9 model or global root is consulted. */
export class WorkspaceRevisionReader {
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
  ) {}
  async readRevision(revision: ConfigRevision): Promise<Buffer> {
    const rows = await this.store.all<ConfigRevision>(
      'SELECT id,asset_id,revision_number,checksum,size,storage_key FROM ConfigAssetRevisions WHERE id=?',
      [revision.id],
    );
    const actual = rows[0];
    if (
      !actual ||
      JSON.stringify(actual) !==
        JSON.stringify({
          id: revision.id,
          asset_id: revision.asset_id,
          revision_number: revision.revision_number,
          checksum: revision.checksum,
          size: revision.size,
          storage_key: revision.storage_key,
        })
    )
      fail('CONFIG_REVISION_CORRUPT');
    const canonical = `asset-${actual.asset_id}/revisions/${actual.revision_number}/content`;
    if (
      (actual.storage_key !== canonical &&
        actual.storage_key !== 'config-assets/' + canonical) ||
      !Number.isSafeInteger(actual.size) ||
      actual.size < 0 ||
      actual.size > 1024 * 1024
    )
      fail('CONFIG_REVISION_CORRUPT');
    const directory = await this.roots.directory(
      `config-assets/asset-${actual.asset_id}/revisions/${actual.revision_number}`,
    );
    const file = path.join(directory, 'content');
    const handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size !== actual.size ||
        before.mode & 0o077 ||
        (process.getuid && before.uid !== process.getuid())
      )
        fail('CONFIG_REVISION_CORRUPT');
      const bytes = await handle.readFile();
      const after = await handle.stat(),
        named = await fs.lstat(file);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        after.dev !== named.dev ||
        after.ino !== named.ino ||
        named.isSymbolicLink() ||
        bytes.length !== actual.size ||
        createHash('sha256').update(bytes).digest('hex') !== actual.checksum
      )
        fail('CONFIG_REVISION_CORRUPT');
      return bytes;
    } finally {
      await handle.close();
    }
  }
}

/** Composes the existing journal/restore and node binding algorithms with Workspace identities. */
export class WorkspaceMaterialization {
  readonly paths: WorkspaceExecutionPaths;
  readonly assets: WorkspaceRevisionReader;
  private readonly configs: ConfigMaterializationService;
  private readonly node: ExecutionNodeBinding;
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    options: { fault?: FaultHook } = {},
  ) {
    if (store.dataRoot !== roots.dataRoot) fail('WORKSPACE_PATH_INVALID');
    this.paths = new WorkspaceExecutionPaths(store.dataRoot);
    this.assets = new WorkspaceRevisionReader(store, roots);
    const checkpoint = options.fault;
    this.configs = new ConfigMaterializationService(this.assets, {
      journalRoot: path.join(store.dataRoot, 'tmp/config-materialization'),
      checkpoint,
    });
    this.node = new ExecutionNodeBinding(this.paths, {
      journalPrefix: 'workspace',
      checkpoint,
    });
  }
  lease(
    lease: WorkspaceLease,
    extraFds: readonly number[] = [],
  ): MaterializationLease {
    return {
      resourceKey: lease.resourceKey,
      exclusive: true,
      processLeaseFds: [...new Set([...lease.processLeaseFds, ...extraFds])],
      assertHeld: () => lease.assertHeld(),
    };
  }
  private async cleanEmptyConfigKey(workspace: TaskWorkspace) {
    const base = path.join(this.configs.root, workspace.resourceKey);
    const stat = await fs.lstat(base).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return;
    await this.roots.directory(
      'tmp/config-materialization/' + workspace.resourceKey,
    );
    if ((await fs.readdir(base)).length) fail('WORKSPACE_RECOVERY_REQUIRED');
    const after = await fs.lstat(base);
    if (after.dev !== stat.dev || after.ino !== stat.ino)
      fail('WORKSPACE_RECOVERY_REQUIRED');
    await fs.rmdir(base);
    await syncDirectory(path.dirname(base));
  }
  private async validate(row: WorkspaceRow, lease: WorkspaceLease) {
    if (
      row.id !== lease.workspaceId ||
      this.paths.resourceKey(row.id) !== lease.resourceKey
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
    await lease.assertHeld();
    return this.roots.requireOwned(row);
  }
  private ownerFile(id: number) {
    return path.join(
      this.store.dataRoot,
      'tmp/execution/workspace-owners',
      `workspace-${id}.json`,
    );
  }
  private async owner(
    row: WorkspaceRow,
    lease: WorkspaceLease,
    expected?: MaterializationRecoveryOwner,
  ): Promise<OwnerProof | null> {
    const file = this.ownerFile(row.id);
    const leftovers = await fs
      .readdir(path.dirname(file))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
    if (
      leftovers.some((name) => name.startsWith(`workspace-${row.id}.json.tmp-`))
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
    const exists = await fs
      .lstat(file)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    if (!exists) return null;
    await this.roots.directory('tmp/execution/workspace-owners');
    const proof = (await readJson(file, 65536)) as OwnerProof;
    const owned = await this.validate(row, lease);
    const uuid =
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    if (
      !proof ||
      proof.version !== 1 ||
      !uuid.test(proof.operation_token) ||
      proof.workspace_id !== row.id ||
      proof.workspace_type !== row.type ||
      proof.resource_key !== lease.resourceKey ||
      proof.root_key !== row.root_key ||
      proof.root_device !== owned.dev ||
      proof.root_inode !== owned.ino ||
      proof.root_owner_token !== owned.marker.owner_token ||
      proof.source_generation !== row.source_generation
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
    if (proof.task_run_id !== null) {
      if (
        !Number.isSafeInteger(proof.task_run_id) ||
        proof.task_run_id < 1 ||
        typeof proof.run_owner_token !== 'string' ||
        !uuid.test(proof.run_owner_token) ||
        (expected && expected.runId !== proof.task_run_id)
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
      const run = (
        await this.store.all<{
          workspace_id: number;
          expected_source_generation: number;
          owner_token: string | null;
        }>(
          'SELECT workspace_id,expected_source_generation,owner_token FROM TaskRuns WHERE id=?',
          [proof.task_run_id],
        )
      )[0];
      if (
        !run ||
        run.workspace_id !== row.id ||
        run.expected_source_generation !== proof.source_generation ||
        !run.owner_token ||
        !uuid.test(run.owner_token)
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
      // The original epoch is audit evidence. A newly acquired run-owner EX FD
      // may have installed a different recovery CAS epoch before restarting us.
    } else if (proof.run_owner_token !== null || expected)
      fail('WORKSPACE_RECOVERY_REQUIRED');
    return proof;
  }
  private async hasJournal(row: WorkspaceRow, lease: WorkspaceLease) {
    const config = path.join(this.configs.root, lease.resourceKey);
    const nodes = await fs
      .readdir(path.join(this.store.dataRoot, 'tmp/execution/node-bindings'))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
    return (
      nodes.some(
        (name) =>
          name === `workspace-${row.id}.json` ||
          name.startsWith(`workspace-${row.id}.json.tmp-`),
      ) ||
      (
        await fs.readdir(config).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        })
      ).length > 0
    );
  }
  private async removeOwner(
    row: WorkspaceRow,
    lease: WorkspaceLease,
    proof: OwnerProof,
  ) {
    if (await this.hasJournal(row, lease)) fail('WORKSPACE_RECOVERY_REQUIRED');
    const current = await this.owner(row, lease);
    if (!current || JSON.stringify(current) !== JSON.stringify(proof))
      fail('WORKSPACE_RECOVERY_REQUIRED');
    await fs.unlink(this.ownerFile(row.id));
    await syncDirectory(path.dirname(this.ownerFile(row.id)));
  }
  private async createOwner(
    row: WorkspaceRow,
    lease: WorkspaceLease,
    context: WorkspaceMaterializationContext,
  ) {
    if ((await this.owner(row, lease)) || (await this.hasJournal(row, lease)))
      fail('WORKSPACE_RECOVERY_REQUIRED');
    const owned = await this.validate(row, lease);
    const run = context.identity
      ? (
          await this.store.all<{
            id: number;
            workspace_id: number;
            owner_token: string | null;
          }>('SELECT id,workspace_id,owner_token FROM TaskRuns WHERE id=?', [
            context.identity.taskRunId,
          ])
        )[0]
      : undefined;
    if (run && (run.workspace_id !== row.id || !run.owner_token))
      fail('WORKSPACE_RECOVERY_REQUIRED');
    const proof: OwnerProof = {
      version: 1,
      operation_token: randomUUID(),
      workspace_id: row.id,
      workspace_type: row.type,
      resource_key: lease.resourceKey,
      root_key: row.root_key,
      root_device: owned.dev,
      root_inode: owned.ino,
      root_owner_token: owned.marker.owner_token,
      source_generation: row.source_generation,
      task_run_id: run?.id ?? null,
      run_owner_token: run?.owner_token ?? null,
    };
    await this.roots.directory('tmp/execution/workspace-owners', true);
    await atomicPrivateWrite(this.ownerFile(row.id), JSON.stringify(proof));
    return proof;
  }
  private async budget(context: WorkspaceMaterializationContext) {
    const limits = workspaceLimits();
    if (context.configSnapshot.length > limits.maxWorkspaceEntries)
      fail('WORKSPACE_QUOTA_EXCEEDED');
    let bytes = 65536;
    const run = 'run-' + 'f'.repeat(36);
    const directory = path.join(
      this.configs.root,
      context.workspace.resourceKey,
      run,
    );
    let journalBytes = Buffer.byteLength(
      JSON.stringify({
        version: 1,
        workspace: { ...context.workspace, taskDir: context.source.cwd },
        run,
        entries: [],
      }),
    );
    for (const [index, item] of context.configSnapshot.entries()) {
      const size = item.revision.size;
      if (!Number.isSafeInteger(size) || size < 0 || size > 1024 * 1024)
        fail('CONFIG_REVISION_CORRUPT');
      const anchor =
        item.binding.target_base === 'TASK_CWD'
          ? context.source.cwd
          : context.workspace.workspaceRoot;
      const relative = path.relative(context.workspace.workspaceRoot, anchor);
      if (
        path.isAbsolute(relative) ||
        relative === '..' ||
        relative.startsWith('../')
      )
        fail('WORKSPACE_PATH_FORBIDDEN');
      let original = 0;
      try {
        const file = await safeParents(anchor, item.binding.target_path);
        const stat = await fs.lstat(file);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          fail('CONFIG_TARGET_UNSAFE');
        original = stat.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      bytes += size * 3 + original + 4096;
      if (!Number.isSafeInteger(bytes) || bytes > limits.temporaryMaxBytes)
        fail('DISK_BUDGET_EXCEEDED');
      const target = path.join(anchor, item.binding.target_path);
      const number = '9'.repeat(32);
      journalBytes +=
        Buffer.byteLength(
          JSON.stringify({
            root: anchor,
            relative: item.binding.target_path,
            backup: path.join(directory, `backup-${index}`),
            copy: path.join(directory, `content-${index}`),
            temporary: path.join(
              path.dirname(target),
              `.platform-${run}-${index}`,
            ),
            original: {
              ino: number,
              dev: number,
              mode: number,
              checksum: 'f'.repeat(64),
            },
            installed: { ino: number, dev: number },
            mode: item.binding.materialization_mode,
            phase: 'BACKED_UP',
          }),
        ) + 1;
      // The reused recovery reader is deliberately bounded at one MiB. Reject
      // before writing if even a conservative complete journal would exceed it.
      if (journalBytes > 1024 * 1024) fail('WORKSPACE_QUOTA_EXCEEDED');
    }
    await requireDiskBudget(context.workspace.workspaceRoot, bytes, limits);
  }
  async preflight(context: WorkspaceMaterializationContext) {
    await this.budget(context);
  }
  async recover(
    row: WorkspaceRow,
    lease: WorkspaceLease,
    workspace?: Readonly<TaskWorkspace>,
    expected?: MaterializationRecoveryOwner,
  ) {
    const owned = await this.validate(row, lease);
    const proof = await this.owner(row, lease, expected);
    if (!proof && (await this.hasJournal(row, lease)))
      fail('WORKSPACE_RECOVERY_REQUIRED');
    const materializationLease = this.lease(lease);
    await this.node.recover(row.id, owned.root, materializationLease);
    const logical: TaskWorkspace = workspace
      ? { ...workspace, taskDir: workspace.cwd }
      : {
          workspaceRoot: owned.root,
          taskDir: owned.root,
          cwd: owned.root,
          resourceKey: lease.resourceKey,
        };
    await this.configs.recover(logical, materializationLease);
    await this.cleanEmptyConfigKey(logical);
    if (proof) await this.removeOwner(row, lease, proof);
    await this.validate(row, lease);
  }
  async prepare(
    context: WorkspaceMaterializationContext,
    lease: WorkspaceLease,
    extraFds: readonly number[] = [],
  ) {
    const row = await this.store.workspace(context.source.workspaceId);
    const owned = await this.validate(row, lease);
    if (
      owned.root !== context.workspace.workspaceRoot ||
      context.workspace.resourceKey !== lease.resourceKey
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
    // The mature materializer calls this anchor TASK_DIR; for v2 it denotes the
    // frozen resolved TASK_CWD. No persistent legacy source/identity is created.
    const logical: TaskWorkspace = {
      ...context.workspace,
      taskDir: context.source.cwd,
    };
    const materializationLease = this.lease(lease, extraFds);
    await this.budget(context);
    const proof = await this.createOwner(row, lease, context);
    const node = await this.node.prepareResource(
      row.id,
      owned.root,
      context.runtime.nodeModulesRoot,
      materializationLease,
    );
    let configCleanup: (() => Promise<void>) | undefined;
    try {
      const bindings: MaterializationConfig[] = context.configSnapshot.map(
        (item) => ({
          revision: item.revision,
          binding: {
            ...item.binding,
            target_base:
              item.binding.target_base === 'TASK_CWD'
                ? 'TASK_DIR'
                : 'WORKSPACE_ROOT',
            conflict_policy:
              item.binding.conflict_policy === 'BACKUP_AND_RESTORE'
                ? 'REPLACE_RESTORE'
                : 'FAIL_IF_EXISTS',
          },
        }),
      );
      const configured = await this.configs.prepare(
        logical,
        bindings,
        materializationLease,
      );
      configCleanup = configured.cleanup;
      return {
        cleanup: async () => {
          let failed = false;
          try {
            await configured.cleanup();
            await this.cleanEmptyConfigKey(logical);
          } catch {
            failed = true;
          }
          try {
            await node.cleanup();
          } catch {
            failed = true;
          }
          if (failed) fail('WORKSPACE_RECOVERY_REQUIRED');
          await this.validate(row, lease);
          await this.removeOwner(row, lease, proof);
        },
      };
    } catch (error) {
      try {
        await configCleanup?.();
        await this.cleanEmptyConfigKey(logical);
        await node.cleanup();
        await this.removeOwner(row, lease, proof);
      } catch {
        fail('WORKSPACE_RECOVERY_REQUIRED');
      }
      throw error;
    }
  }
}
