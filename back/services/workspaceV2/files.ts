import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { TextDecoder } from 'util';
import { AsyncLocalStorage } from 'async_hooks';
import config from '../../config';
import { VIEW_LIMIT, WorkspaceFiles } from '../workspaceFiles';
import { privateJson, readJson, syncDirectory } from '../backup/files';
import { WorkspaceStore } from './store';
import { WorkspaceRootResolver } from './roots';
import { assertWorkspaceJournalIsolation } from './journals';
import { WorkspaceLease, WorkspaceLeaseService } from './lease';
import { errorCode, fail, WorkspaceFoundationError } from './errors';
import { workspaceLimits, WorkspaceLimits } from './limits';
import {
  hashWorkspaceRecords,
  OWNER_MARKER,
  relativeWorkspacePath,
  requireDiskBudget,
  scanWorkspace,
} from './inventory';
import type {
  FaultHook,
  Inventory,
  InventoryEntry,
  OperationRow,
  WorkspaceRow,
} from './types';

type MutationKind =
  | 'CREATE_FILE'
  | 'CREATE_DIRECTORY'
  | 'SAVE'
  | 'DELETE'
  | 'RENAME';
interface FileJournal {
  version: 1;
  operation_id: string;
  workspace_id: number;
  owner_token: string;
  root_device: number;
  root_inode: number;
  expected_revision: number;
  before_hash: string;
  after_hash: string;
  kind: MutationKind;
  path: string;
  destination?: string;
}
interface MutationReceipt {
  workspace: WorkspaceRow;
  entry: {
    path: string;
    kind: string;
    size: number;
    identity: string;
    hash: string | null;
  } | null;
}
const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

function isFileJournal(value: unknown): value is FileJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.version === 1 &&
    typeof row.operation_id === 'string' &&
    Number.isSafeInteger(row.workspace_id) &&
    Number(row.workspace_id) > 0 &&
    typeof row.owner_token === 'string' &&
    row.owner_token.length > 0 &&
    Number.isSafeInteger(row.root_device) &&
    Number(row.root_device) >= 0 &&
    Number.isSafeInteger(row.root_inode) &&
    Number(row.root_inode) > 0 &&
    Number.isSafeInteger(row.expected_revision) &&
    Number(row.expected_revision) > 0 &&
    typeof row.before_hash === 'string' &&
    /^[0-9a-f]{64}$/.test(row.before_hash) &&
    typeof row.after_hash === 'string' &&
    /^[0-9a-f]{64}$/.test(row.after_hash) &&
    ['CREATE_FILE', 'CREATE_DIRECTORY', 'SAVE', 'DELETE', 'RENAME'].includes(
      String(row.kind),
    ) &&
    typeof row.path === 'string' &&
    (row.destination === undefined || typeof row.destination === 'string')
  );
}

/** Generic internal v2 files. No Repository, Task execution, HTTP or global DB dependency. */
export class WorkspaceFileService {
  readonly limits: WorkspaceLimits;
  private readonly fault?: FaultHook;
  private readonly receiptContext = new AsyncLocalStorage<{
    active: boolean;
    value?: MutationReceipt;
  }>();
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly leases: WorkspaceLeaseService,
    options: { limits?: Partial<WorkspaceLimits>; fault?: FaultHook } = {},
  ) {
    this.limits = workspaceLimits(options.limits);
    this.fault = options.fault;
    if (store.dataRoot !== roots.dataRoot || roots.dataRoot !== leases.dataRoot)
      fail('WORKSPACE_PATH_INVALID', 400);
  }

  /** Capture the one mutation's after-image before its existing Workspace lease
   * releases. A receipt scope never survives its awaited operation. */
  async captureMutationReceipt(
    action: () => Promise<unknown>,
  ): Promise<MutationReceipt> {
    const scope: { active: boolean; value?: MutationReceipt } = {
      active: true,
    };
    try {
      await this.receiptContext.run(scope, action);
      if (!scope.value) fail('WORKSPACE_OPERATION_FAILED');
      return scope.value;
    } finally {
      scope.active = false;
    }
  }

  private checkPath(relative: string, allowRoot = false) {
    relativeWorkspacePath(relative, allowRoot);
    if (
      Buffer.byteLength(relative) > this.limits.maxRelativePathBytes ||
      (relative && relative.split('/').length > this.limits.maxDirectoryDepth)
    )
      fail('WORKSPACE_QUOTA_EXCEEDED', 413);
  }

  private async guardJournals(id: number) {
    await assertWorkspaceJournalIsolation(this.store, this.roots, id);
    const completed = await this.store.all<{ journal_key: string | null }>(
      "SELECT journal_key FROM WorkspaceOperations WHERE workspace_id=? AND operation_type='FILE_MUTATION' AND status='SUCCEEDED'",
      [id],
    );
    for (const operation of completed) {
      if (!operation.journal_key) continue;
      if (
        !/^tmp\/workspace-v2\/files\/[0-9a-f-]{36}\.json$/.test(
          operation.journal_key,
        )
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
      const remaining = await fs
        .lstat(path.join(this.roots.dataRoot, operation.journal_key))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
      if (remaining) fail('WORKSPACE_RECOVERY_REQUIRED');
    }
  }

  private lowLevel(root: string, lease: WorkspaceLease) {
    return new WorkspaceFiles(root, async (source, destination) => {
      try {
        await lease.run(
          '/usr/bin/python3',
          [
            '-I',
            '-S',
            path.join(config.rootPath, 'shell/workspace_rename.py'),
            source,
            destination,
          ],
          root,
          { PATH: '/usr/bin:/bin' },
          5,
        );
      } catch (error: unknown) {
        if (
          error &&
          typeof error === 'object' &&
          'exit_code' in error &&
          error.exit_code === 17
        )
          fail('WORKSPACE_DESTINATION_EXISTS');
        throw error;
      }
    });
  }

  private safeError(error: unknown): never {
    if (error instanceof WorkspaceFoundationError) throw error;
    const known = errorCode(error);
    if (known !== 'WORKSPACE_OPERATION_FAILED') {
      const status =
        error &&
        typeof error === 'object' &&
        'status' in error &&
        typeof error.status === 'number'
          ? error.status
          : 409;
      fail(known, status);
    }
    const code =
      error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    if (code === 'ENOENT') fail('WORKSPACE_FILE_NOT_FOUND', 404);
    if (code === 'EEXIST') fail('WORKSPACE_DESTINATION_EXISTS');
    if (code === 'ENOSPC' || code === 'EDQUOT')
      fail('DISK_BUDGET_EXCEEDED', 413);
    if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP')
      fail('WORKSPACE_PATH_FORBIDDEN', 403);
    fail('WORKSPACE_OPERATION_FAILED');
  }

  private async readOperation<T>(
    id: number,
    operation: string,
    action: (files: WorkspaceFiles, row: WorkspaceRow) => Promise<T>,
    completeInventory = true,
    publishedInventory = false,
  ): Promise<T> {
    try {
      return await this.leases.withWorkspace(id, operation, async (lease) => {
        const row = await this.store.assertAccessible(id, false);
        await this.guardJournals(id);
        const owned = await this.roots.requireReady(row, lease, true);
        if (completeInventory) {
          const inventory = await scanWorkspace(
            owned.root,
            row.type,
            this.limits,
          );
          if (
            publishedInventory &&
            inventory.hash !== row.content_inventory_hash
          )
            fail('WORKSPACE_VERSION_CONFLICT');
        }
        const result = await action(this.lowLevel(owned.root, lease), row);
        await this.roots.requireOwned(row);
        await lease.assertHeld();
        return result;
      });
    } catch (error: unknown) {
      return this.safeError(error);
    }
  }

  async read(id: number, relative: string) {
    this.checkPath(relative);
    return this.readOperation(id, 'FILE_READ', (files) => files.read(relative));
  }

  /** Public DTO adapters capture revision and bytes under the same source lease. */
  async readSnapshot(id: number, relative: string) {
    this.checkPath(relative);
    return this.readOperation(
      id,
      'FILE_READ',
      async (files, workspace) => ({
        workspace,
        result: await files.read(relative),
      }),
      true,
      true,
    );
  }

  /** The callback cannot outlive the guarded, fully scanned Workspace lease. */
  async treeSnapshot(id: number, relative = '', offset = 0, limit = 200) {
    this.checkPath(relative, true);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      fail('WORKSPACE_PATH_INVALID', 400);
    return this.readOperation(
      id,
      'FILE_TREE',
      async (files, workspace) => {
        const result = await files.tree(relative, offset, limit);
        const entries = await Promise.all(
          result.items.map(async (entry) => ({
            ...entry,
            hash:
              entry.kind === 'file'
                ? sha256(
                    (
                      await files.bytes(
                        entry.path,
                        this.limits.maxSourceFileBytes,
                      )
                    ).data,
                  )
                : null,
          })),
        );
        return { workspace, result: { ...result, entries } };
      },
      true,
      true,
    );
  }

  async metadataSnapshot(id: number, relative: string) {
    this.checkPath(relative);
    return this.readOperation(
      id,
      'FILE_METADATA',
      async (files, workspace) => {
        try {
          const result = await files.metadata(relative);
          const hash =
            result.kind === 'file'
              ? sha256(
                  (await files.bytes(relative, this.limits.maxSourceFileBytes))
                    .data,
                )
              : null;
          return { workspace, result: { ...result, hash } };
        } catch (error: unknown) {
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            return { workspace, result: null };
          throw error;
        }
      },
      true,
      true,
    );
  }

  async tree(id: number, relative = '', offset = 0, limit = 200) {
    this.checkPath(relative, true);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      fail('WORKSPACE_PATH_INVALID', 400);
    return this.readOperation(id, 'FILE_TREE', (files) =>
      files.tree(relative, offset, limit),
    );
  }

  async search(id: number, query: string, content = false) {
    return this.readOperation(
      id,
      'FILE_SEARCH',
      async (files, row) => {
        if (!query || query.length > 256) fail('WORKSPACE_PATH_INVALID', 400);
        const items: { path: string; line?: number; text?: string }[] = [];
        let scanned = 0;
        let bytes = 0;
        let truncated = false;
        const deadline =
          process.hrtime.bigint() +
          BigInt(this.limits.searchDeadlineMs) * BigInt(1000000);
        const pending = [''];
        outer: while (pending.length) {
          const relative = pending.pop()!;
          const target = await files.target(relative, false, true);
          const initial = await fs.lstat(target);
          if (
            !initial.isDirectory() ||
            initial.isSymbolicLink() ||
            (await fs.realpath(target)) !== target
          )
            fail('WORKSPACE_PATH_FORBIDDEN', 403);
          const directory = await fs.opendir(target);
          for await (const entry of directory) {
            if (!relative && entry.name === OWNER_MARKER) continue;
            const member = relative ? `${relative}/${entry.name}` : entry.name;
            const absolute = path.join(files.root, member);
            const info = await fs.lstat(absolute);
            if (!relative && entry.name === '.git' && row.type === 'GIT') {
              if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
                fail('WORKSPACE_PATH_FORBIDDEN', 403);
              continue;
            }
            if (
              scanned >= this.limits.searchMaxEntries ||
              process.hrtime.bigint() > deadline ||
              items.length >= this.limits.searchMaxMatches
            ) {
              truncated = true;
              break outer;
            }
            scanned++;
            if (/^\.platform-(?:run-|node-|workspace-)/i.test(entry.name))
              fail('WORKSPACE_RECOVERY_REQUIRED');
            this.checkPath(member);
            if (
              info.isSymbolicLink() ||
              (process.getuid && info.uid !== process.getuid())
            )
              fail('WORKSPACE_PATH_FORBIDDEN', 403);
            if (info.isDirectory()) {
              pending.push(member);
              continue;
            }
            if (!info.isFile() || info.nlink !== 1)
              fail('WORKSPACE_PATH_FORBIDDEN', 403);
            if (info.size > this.limits.maxSourceFileBytes)
              fail('WORKSPACE_FILE_TOO_LARGE', 413);
            if (!content) {
              if (
                member.toLocaleLowerCase().includes(query.toLocaleLowerCase())
              )
                items.push({ path: member });
              continue;
            }
            if (
              info.size > this.limits.searchMaxFileBytes ||
              bytes + info.size > this.limits.searchMaxBytes
            ) {
              truncated = true;
              continue;
            }
            const value = await files.bytes(
              member,
              Math.min(
                this.limits.searchMaxFileBytes,
                this.limits.searchMaxBytes - bytes,
              ),
            );
            bytes += value.data.length;
            if (value.data.includes(0)) continue;
            let text: string;
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(
                value.data,
              );
            } catch {
              continue;
            }
            const lines = text.split('\n');
            for (let line = 0; line < lines.length; line++) {
              if (process.hrtime.bigint() > deadline) {
                truncated = true;
                break outer;
              }
              if (lines[line].includes(query)) {
                items.push({
                  path: member,
                  line: line + 1,
                  text: lines[line].slice(0, 500),
                });
                if (items.length >= this.limits.searchMaxMatches) {
                  truncated = true;
                  break outer;
                }
              }
            }
          }
          const after = await fs.lstat(target);
          if (
            initial.dev !== after.dev ||
            initial.ino !== after.ino ||
            after.isSymbolicLink()
          )
            fail('WORKSPACE_FILE_CONFLICT');
        }
        return { items, scanned, bytes, truncated };
      },
      false,
    );
  }

  private async references(id: number, relative: string) {
    const references = await this.store.all<{
      relative_entrypoint: string;
      cwd_mode: string;
      cwd_relative_path: string | null;
    }>(
      'SELECT relative_entrypoint,cwd_mode,cwd_relative_path FROM TaskSources WHERE workspace_id=?',
      [id],
    );
    if (
      references.some(
        (ref) =>
          ref.relative_entrypoint === relative ||
          ref.relative_entrypoint.startsWith(relative + '/') ||
          (ref.cwd_mode === 'CUSTOM_RELATIVE' &&
            ref.cwd_relative_path !== null &&
            (ref.cwd_relative_path === relative ||
              ref.cwd_relative_path.startsWith(relative + '/'))),
      )
    )
      fail('WORKSPACE_FILE_REFERENCED');
  }

  private async expected(
    files: WorkspaceFiles,
    relative: string,
    expected: string,
  ) {
    if (!/^[0-9a-f]{64}$/.test(expected)) fail('WORKSPACE_FILE_CONFLICT');
    const meta = await files.metadata(relative);
    if (meta.kind !== 'file' && meta.kind !== 'directory')
      fail('WORKSPACE_PATH_FORBIDDEN', 403);
    const actual =
      meta.kind === 'directory' || meta.size > VIEW_LIMIT
        ? meta.identity
        : sha256((await files.bytes(relative)).data);
    if (actual !== expected) fail('WORKSPACE_FILE_CONFLICT');
    return meta;
  }

  private async missing(files: WorkspaceFiles, relative: string) {
    const target = await files.target(relative, true);
    const info = await fs
      .lstat(target)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    if (info) fail('WORKSPACE_DESTINATION_EXISTS');
    const parent = path.posix.dirname(relative);
    await files.target(parent === '.' ? '' : parent, false, true);
  }

  private plannedInventory(
    before: Inventory,
    kind: MutationKind,
    relative: string,
    content?: string,
    destination?: string,
  ): InventoryEntry[] {
    const entries = before.entries.map((entry) => ({ ...entry }));
    const index = entries.findIndex((entry) => entry.path === relative);
    if (kind === 'CREATE_FILE')
      entries.push({
        path: relative,
        kind: 'file',
        mode: 0o644,
        size: Buffer.byteLength(content ?? ''),
        sha256: sha256(content ?? ''),
      });
    else if (kind === 'CREATE_DIRECTORY')
      entries.push({
        path: relative,
        kind: 'directory',
        mode: 0o755 & ~process.umask(),
        size: 0,
      });
    else if (kind === 'SAVE' && index >= 0) {
      entries[index].size = Buffer.byteLength(content ?? '');
      entries[index].sha256 = sha256(content ?? '');
    } else if (kind === 'DELETE' && index >= 0) entries.splice(index, 1);
    else if (kind === 'RENAME' && destination) {
      for (const entry of entries) {
        if (entry.path === relative) entry.path = destination;
        else if (entry.path.startsWith(relative + '/'))
          entry.path = destination + entry.path.slice(relative.length);
      }
    }
    return entries;
  }

  private quota(entries: InventoryEntry[]) {
    const bytes = entries
      .filter((entry) => entry.kind === 'file')
      .reduce((sum, entry) => sum + entry.size, 0);
    if (
      entries.length > this.limits.maxWorkspaceEntries ||
      bytes > this.limits.maxWorkspaceBytes ||
      entries.some(
        (entry) =>
          entry.size > this.limits.maxSourceFileBytes ||
          entry.path.split('/').length > this.limits.maxDirectoryDepth ||
          Buffer.byteLength(entry.path) > this.limits.maxRelativePathBytes,
      )
    )
      fail('WORKSPACE_QUOTA_EXCEEDED', 413);
  }

  private async mutate<T>(
    id: number,
    kind: MutationKind,
    relative: string,
    prepare: (
      files: WorkspaceFiles,
      before: Inventory,
    ) => Promise<{ content?: string; destination?: string }>,
    action: (files: WorkspaceFiles) => Promise<T>,
  ): Promise<T> {
    this.checkPath(relative);
    if (
      this.receiptContext.getStore()?.active &&
      this.receiptContext.getStore()?.value
    )
      fail('WORKSPACE_OPERATION_FAILED');
    try {
      return await this.leases.withWorkspace(
        id,
        'FILE_' + kind,
        async (lease) => {
          const row = await this.store.assertAccessible(id, true);
          await this.guardJournals(id);
          const owned = await this.roots.requireReady(row, lease);
          const before = await scanWorkspace(owned.root, row.type, this.limits);
          const files = this.lowLevel(owned.root, lease);
          const plan = await prepare(files, before);
          const planned = this.plannedInventory(
            before,
            kind,
            relative,
            plan.content,
            plan.destination,
          );
          this.quota(planned);
          const oldBytes =
            kind === 'SAVE'
              ? before.entries.find((entry) => entry.path === relative)?.size ??
                0
              : 0;
          const temporaryBytes =
            oldBytes + Buffer.byteLength(plan.content ?? '');
          if (temporaryBytes > this.limits.temporaryMaxBytes)
            fail('DISK_BUDGET_EXCEEDED', 413);
          await requireDiskBudget(owned.root, temporaryBytes, this.limits);
          const operationId = randomUUID();
          const token = randomUUID();
          const parent = await this.roots.directory(
            'tmp/workspace-v2/files',
            true,
          );
          const journalFile = path.join(parent, operationId + '.json');
          const journal: FileJournal = {
            version: 1,
            operation_id: operationId,
            workspace_id: id,
            owner_token: token,
            root_device: owned.stat.dev,
            root_inode: owned.stat.ino,
            expected_revision: row.content_revision,
            before_hash: before.hash,
            after_hash: hashWorkspaceRecords(planned),
            kind,
            path: relative,
            destination: plan.destination,
          };
          await this.store.run(
            `INSERT INTO WorkspaceOperations(id,workspace_id,operation_type,status,phase,request_key,request_hash,
           expected_workspace_version,owner_token,journal_key,root_marker,submitted_at,started_at)
           VALUES(?,?,'FILE_MUTATION','RUNNING','PREPARED',?,?,?,?,?,?,?,?)`,
            [
              operationId,
              id,
              operationId,
              sha256(JSON.stringify(journal)),
              row.version,
              token,
              `tmp/workspace-v2/files/${operationId}.json`,
              JSON.stringify(owned.marker),
              new Date().toISOString(),
              new Date().toISOString(),
            ],
          );
          let committed = false;
          try {
            await this.fault?.('FILE_INTENT_DURABLE', {
              workspace_id: id,
              operation_id: operationId,
              kind,
            });
            await privateJson(journalFile, journal);
            await this.fault?.('FILE_PREPARED', {
              workspace_id: id,
              operation_id: operationId,
              kind,
            });
            const result = await action(files);
            await this.fault?.('FILE_APPLIED', {
              workspace_id: id,
              operation_id: operationId,
              kind,
            });
            await this.roots.requireOwned(row);
            const after = await scanWorkspace(
              owned.root,
              row.type,
              this.limits,
            );
            if (after.hash !== journal.after_hash)
              fail('WORKSPACE_RECOVERY_REQUIRED');
            const receipt = this.receiptContext.getStore();
            let entry: MutationReceipt['entry'] = null;
            if (receipt?.active && kind !== 'DELETE') {
              const target = plan.destination ?? relative,
                metadata = await files.metadata(target);
              const hash =
                metadata.kind === 'file'
                  ? sha256(
                      (
                        await files.bytes(
                          target,
                          this.limits.maxSourceFileBytes,
                        )
                      ).data,
                    )
                  : null;
              if (
                metadata.kind === 'file' &&
                after.entries.find((item) => item.path === target)?.sha256 !==
                  hash
              )
                fail('WORKSPACE_FILE_CONFLICT');
              entry = {
                path: metadata.path,
                kind: metadata.kind,
                size: metadata.size,
                identity: metadata.identity,
                hash,
              };
            }
            const published = await this.store.transaction(async (tx) => {
              const workspace = await tx.updateInventory(
                id,
                row.content_revision,
                after,
              );
              await tx.run(
                "UPDATE WorkspaceOperations SET status='SUCCEEDED',phase='COMPLETE',finished_at=? WHERE id=? AND owner_token=?",
                [new Date().toISOString(), operationId, token],
              );
              return workspace;
            });
            if (receipt?.active)
              receipt.value = { workspace: published, entry };
            committed = true;
            await this.fault?.('FILE_COMMITTED', {
              workspace_id: id,
              operation_id: operationId,
              kind,
            });
            await fs.unlink(journalFile);
            await syncDirectory(parent);
            return result;
          } catch (error: unknown) {
            // The DB already owns the complete after-image; a retained authenticated
            // journal is cleanup work and must not roll a committed Workspace back.
            if (committed) throw error;
            let unchanged = false;
            try {
              await this.roots.requireOwned(row);
              unchanged =
                (await scanWorkspace(owned.root, row.type, this.limits))
                  .hash === before.hash;
            } catch {
              /* Unknown files and reserved leftovers must remain protected. */
            }
            await this.store.transaction(async (tx) => {
              await tx.run(
                "UPDATE WorkspaceOperations SET status=?,phase=?,finished_at=?,error_code=? WHERE id=? AND status<>'SUCCEEDED'",
                [
                  unchanged ? 'FAILED' : 'RECOVERY_REQUIRED',
                  unchanged ? 'ABORTED_UNCHANGED' : 'RECOVER_FILE',
                  unchanged ? new Date().toISOString() : null,
                  errorCode(error),
                  operationId,
                ],
              );
              if (!unchanged)
                await tx.run(
                  "UPDATE Workspaces SET lifecycle_state='RECOVERY_REQUIRED',last_error_code=? WHERE id=? AND lifecycle_state='READY'",
                  [errorCode(error), id],
                );
            });
            if (unchanged) {
              await fs
                .unlink(journalFile)
                .catch((failure: NodeJS.ErrnoException) => {
                  if (failure.code !== 'ENOENT') throw failure;
                });
              await syncDirectory(parent);
            }
            throw error;
          }
        },
      );
    } catch (error: unknown) {
      return this.safeError(error);
    }
  }

  async create(id: number, relative: string, content = '', directory = false) {
    const normalized = content.replace(/\r\n/g, '\n');
    if (Buffer.byteLength(normalized) > this.limits.editTextMaxBytes)
      fail('WORKSPACE_FILE_TOO_LARGE', 413);
    return this.mutate(
      id,
      directory ? 'CREATE_DIRECTORY' : 'CREATE_FILE',
      relative,
      async (files) => {
        await this.missing(files, relative);
        return { content: normalized };
      },
      (files) => files.create(relative, content, directory),
    );
  }
  async createDirectory(id: number, relative: string) {
    return this.create(id, relative, '', true);
  }
  async save(
    id: number,
    relative: string,
    content: string,
    expectedHash: string,
  ) {
    return this.mutate(
      id,
      'SAVE',
      relative,
      async (files) => {
        const prior = await files.read(relative);
        if (!('hash' in prior) || prior.hash !== expectedHash)
          fail('WORKSPACE_FILE_CONFLICT');
        if (
          !('content' in prior) ||
          typeof prior.content !== 'string' ||
          !prior.editable
        )
          fail('WORKSPACE_FILE_TOO_LARGE', 413);
        const normalized = content.replace(/\r\n/g, '\n');
        const exact =
          (prior.bom ? '\uFEFF' : '') +
          (prior.eol === 'CRLF'
            ? normalized.replace(/\n/g, '\r\n')
            : normalized);
        if (Buffer.byteLength(exact) > this.limits.editTextMaxBytes)
          fail('WORKSPACE_FILE_TOO_LARGE', 413);
        return { content: exact };
      },
      (files) => files.save(relative, content, expectedHash),
    );
  }
  async remove(id: number, relative: string, expectedHash: string) {
    return this.mutate(
      id,
      'DELETE',
      relative,
      async (files) => {
        await this.references(id, relative);
        const meta = await this.expected(files, relative, expectedHash);
        if (
          meta.kind === 'directory' &&
          (await fs.readdir(await files.target(relative))).length
        )
          fail('WORKSPACE_DIRECTORY_NOT_EMPTY');
        return {};
      },
      (files) => files.remove(relative, expectedHash),
    );
  }
  async rename(
    id: number,
    relative: string,
    destination: string,
    expectedHash: string,
    expectedKind?: 'FILE' | 'DIRECTORY',
  ) {
    this.checkPath(destination);
    return this.mutate(
      id,
      'RENAME',
      relative,
      async (files) => {
        await this.references(id, relative);
        if (destination === relative || destination.startsWith(relative + '/'))
          fail('WORKSPACE_PATH_INVALID', 400);
        const actual = await this.expected(files, relative, expectedHash);
        if (
          expectedKind &&
          actual.kind !== (expectedKind === 'FILE' ? 'file' : 'directory')
        )
          fail('INVALID_REQUEST', 400);
        await this.missing(files, destination);
        return { destination };
      },
      (files) => files.rename(relative, destination, expectedHash),
    );
  }

  /** Reconcile an interrupted atomic operation; never remove unproven temp files. */
  async recover(id: number) {
    try {
      return await this.leases.withWorkspace(id, 'FILE_RECOVER', async () => {
        const row = await this.store.workspace(id);
        const operations = await this.store.all<OperationRow>(
          "SELECT * FROM WorkspaceOperations WHERE workspace_id=? AND operation_type='FILE_MUTATION' AND status IN ('RUNNING','RECOVERY_REQUIRED','SUCCEEDED')",
          [id],
        );
        try {
          for (const operation of operations) {
            const expectedKey = `tmp/workspace-v2/files/${operation.id}.json`;
            if (
              operation.journal_key !== expectedKey ||
              !/^[0-9a-f-]{36}$/.test(operation.id)
            )
              fail('WORKSPACE_RECOVERY_REQUIRED');
            const file = path.join(this.roots.dataRoot, expectedKey);
            await this.roots.directory('tmp/workspace-v2/files');
            const owned = await this.roots.requireOwned(row);
            const remaining = await fs
              .lstat(file)
              .catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') return null;
                throw error;
              });
            if (!remaining) {
              if (operation.status === 'SUCCEEDED') continue;
              // DB-first preparation cannot have applied a file mutation without
              // first making its journal durable. Prove the unchanged source and
              // original root identity before abandoning that incomplete intent.
              let marker: unknown;
              try {
                marker = JSON.parse(operation.root_marker ?? 'null');
              } catch {
                fail('WORKSPACE_RECOVERY_REQUIRED');
              }
              const inventory = await scanWorkspace(
                owned.root,
                row.type,
                this.limits,
              );
              if (
                operation.phase !== 'PREPARED' ||
                operation.expected_workspace_version !== row.version ||
                !marker ||
                typeof marker !== 'object' ||
                !('owner_token' in marker) ||
                !('dev' in marker) ||
                !('ino' in marker) ||
                marker.owner_token !== owned.marker.owner_token ||
                marker.dev !== owned.dev ||
                marker.ino !== owned.ino ||
                inventory.hash !== row.content_inventory_hash
              )
                fail('WORKSPACE_RECOVERY_REQUIRED');
              await this.store.run(
                "UPDATE WorkspaceOperations SET status='FAILED',phase='ABORTED_NO_JOURNAL',finished_at=?,error_code='WORKSPACE_OPERATION_FAILED' WHERE id=?",
                [new Date().toISOString(), operation.id],
              );
              continue;
            }
            const journal: unknown = await readJson(file);
            if (
              !isFileJournal(journal) ||
              journal.workspace_id !== id ||
              journal.operation_id !== operation.id ||
              journal.owner_token !== operation.owner_token ||
              sha256(JSON.stringify(journal)) !== operation.request_hash
            )
              fail('WORKSPACE_RECOVERY_REQUIRED');
            this.checkPath(journal.path);
            if (journal.destination !== undefined)
              this.checkPath(journal.destination);
            if (
              owned.stat.dev !== journal.root_device ||
              owned.stat.ino !== journal.root_inode
            )
              fail('WORKSPACE_RECOVERY_REQUIRED');
            const inventory = await scanWorkspace(
              owned.root,
              row.type,
              this.limits,
            );
            if (
              inventory.hash !== journal.after_hash &&
              inventory.hash !== journal.before_hash
            )
              fail('WORKSPACE_RECOVERY_REQUIRED');
            await this.store.transaction(async (tx) => {
              const current = await tx.workspace(id);
              if (current.content_inventory_hash !== inventory.hash)
                await tx.updateInventory(
                  id,
                  journal.expected_revision,
                  inventory,
                );
              await tx.run(
                "UPDATE WorkspaceOperations SET status=?,phase='RECOVERED',finished_at=?,error_code=? WHERE id=?",
                [
                  inventory.hash === journal.after_hash
                    ? 'SUCCEEDED'
                    : 'FAILED',
                  new Date().toISOString(),
                  inventory.hash === journal.after_hash
                    ? null
                    : 'WORKSPACE_OPERATION_FAILED',
                  operation.id,
                ],
              );
              await tx.run(
                "UPDATE Workspaces SET lifecycle_state='READY',last_error_code=NULL WHERE id=? AND lifecycle_state='RECOVERY_REQUIRED'",
                [id],
              );
            });
            await fs.unlink(file);
            await syncDirectory(path.dirname(file));
          }
        } catch (error: unknown) {
          const code =
            errorCode(error) === 'WORKSPACE_OPERATION_FAILED'
              ? 'WORKSPACE_RECOVERY_REQUIRED'
              : errorCode(error);
          await this.store.transaction(async (tx) => {
            await tx.run(
              "UPDATE WorkspaceOperations SET status='RECOVERY_REQUIRED',phase='RECOVER_FILE',error_code=? WHERE workspace_id=? AND operation_type='FILE_MUTATION' AND status IN ('RUNNING','RECOVERY_REQUIRED')",
              [code, id],
            );
            await tx.run(
              "UPDATE Workspaces SET lifecycle_state='RECOVERY_REQUIRED',last_error_code=? WHERE id=? AND lifecycle_state IN ('READY','ARCHIVED')",
              [code, id],
            );
          });
          if (error instanceof WorkspaceFoundationError) throw error;
          fail(code);
        }
        return this.store.workspace(id);
      });
    } catch (error: unknown) {
      return this.safeError(error);
    }
  }
}
