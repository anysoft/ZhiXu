import fs from 'fs/promises';
import path from 'path';
import { constants } from 'fs';
import { createHash } from 'crypto';
import {
  WorkspaceStore,
  WORKSPACE_SCHEMA_IDENTITY,
  WORKSPACE_SCHEMA_SIGNATURE,
} from './store';
import { WorkspaceRootResolver, OWNER_MARKER } from './roots';
import { hashWorkspaceRecords, scanWorkspace } from './inventory';
import { WorkspaceLimits } from './limits';
import { fail, WorkspaceFoundationError } from './errors';
import type { GitWorkspaceRow, InventoryEntry, WorkspaceRow } from './types';
import {
  inspectGitWorkspace,
  GitWorkspaceSummary,
  gitRepositoryKey,
} from './gitStorage';
import { collectManifestReferences } from './manifestReferences';
import { verifyRepositoryAssets } from './repositoryAssets';
import { hashFile, privateDirectory, relativeName } from '../backup/files';

export interface SourceReference {
  task_id: number;
  relative_entrypoint: string;
  language: string;
  cwd_mode: string;
  cwd_relative_path: string | null;
  definition_version: number;
  availability: 'PRESENT' | 'RETIRED_MISSING_EXPECTED';
}
export interface ReclaimedGitSummary
  extends Pick<
    GitWorkspaceSummary,
    | 'repository_id'
    | 'storage_key'
    | 'ref_type'
    | 'ref_name'
    | 'private_branch'
    | 'resolved_commit'
    | 'applied_commit'
    | 'last_verified_commit'
  > {
  storage_state: 'RECLAIMED';
  preservation_snapshot_keys: string[];
}
export interface WorkspaceManifestEntry {
  workspace_id: number;
  workspace_type: 'LOCAL' | 'GIT';
  storage_key: string;
  lifecycle_state: string;
  storage_state: string;
  source_generation: number;
  content_revision: number;
  content_inventory_hash: string | null;
  root_identity: {
    owner_token: string | null;
    dev: number | null;
    ino: number | null;
  };
  file_count: number;
  entry_count: number;
  total_bytes: number;
  content_inventory: InventoryEntry[];
  source_references: SourceReference[];
  git: GitWorkspaceSummary | ReclaimedGitSummary | null;
  environment_config_references: Record<string, unknown[]>;
  sync_discovery_event_references: Record<string, unknown[]>;
  preservation_holds: unknown[];
}
export interface WorkspaceBackupManifest {
  format_family: 'zhixu-workspace-backup';
  format_version: 2;
  backup_id: string;
  created_at: string;
  schema_identity: string;
  schema_signature: string;
  database: { sha256: string; size: number };
  inventory: { sha256: string; size: number };
  total_bytes: number;
  file_count: number;
  preserved_snapshots: { backup_id: string; manifest_sha256: string }[];
  workspaces: WorkspaceManifestEntry[];
}

interface SourceRow {
  task_id: number;
  relative_entrypoint: string;
  language: string;
  cwd_mode: string;
  cwd_relative_path: string | null;
  version: number;
  enabled: number;
  origin: string;
  discovery_state: string;
  discovery_key: string | null;
  discovery_definition: string | null;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function sameRecords(a: InventoryEntry[], b: InventoryEntry[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function backupFailure(error: unknown): never {
  if (error instanceof WorkspaceFoundationError) throw error;
  if (
    error &&
    typeof error === 'object' &&
    'error_code' in error &&
    error.error_code === 'RUNTIME_BUSY'
  )
    fail('BACKUP_BUSY');
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  if (code === 'ENOSPC' || code === 'EDQUOT') fail('DISK_BUDGET_EXCEEDED', 413);
  if (
    typeof code === 'string' &&
    /^(?:BACKUP|RESTORE|PLATFORM)_[A-Z_]+$/.test(code)
  )
    fail(code);
  fail('BACKUP_SOURCE_INCOMPLETE');
}
export function manifestValue(value: unknown): WorkspaceBackupManifest {
  const record = object(value);
  if (
    !record ||
    record.format_family !== 'zhixu-workspace-backup' ||
    record.format_version !== 2 ||
    record.schema_identity !== WORKSPACE_SCHEMA_IDENTITY ||
    record.schema_signature !== WORKSPACE_SCHEMA_SIGNATURE ||
    typeof record.backup_id !== 'string' ||
    typeof record.created_at !== 'string' ||
    !Array.isArray(record.workspaces) ||
    !Array.isArray(record.preserved_snapshots) ||
    !Number.isSafeInteger(record.total_bytes) ||
    !Number.isSafeInteger(record.file_count)
  )
    fail('BACKUP_SOURCE_INCOMPLETE');
  for (const key of ['database', 'inventory']) {
    const item = object(record[key]);
    if (
      !item ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.size) ||
      Number(item.size) < 0
    )
      fail('BACKUP_SOURCE_INCOMPLETE');
  }
  if (record.preserved_snapshots.length > 1024)
    fail('BACKUP_SOURCE_INCOMPLETE');
  for (const value of record.preserved_snapshots) {
    const item = object(value);
    if (
      !item ||
      typeof item.backup_id !== 'string' ||
      typeof item.manifest_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.manifest_sha256)
    )
      fail('BACKUP_SOURCE_INCOMPLETE');
  }
  // Full workspace shape is compared against the independently collected DB/FS facts.
  return record as unknown as WorkspaceBackupManifest;
}

/** Domain proof over a real fresh-v2 DB and its owned files, never a synthetic receipt. */
export class WorkspaceBackupDomain {
  constructor(readonly limits: WorkspaceLimits) {}

  private async assertConfigAssets(store: WorkspaceStore) {
    let after = 0;
    while (true) {
      const revisions = await store.all<{
        id: number;
        asset_id: number;
        revision_number: number;
        size: number;
        checksum: string;
        storage_key: string;
      }>(
        'SELECT id,asset_id,revision_number,size,checksum,storage_key FROM ConfigAssetRevisions WHERE id>? ORDER BY id LIMIT 500',
        [after],
      );
      if (!revisions.length) return;
      for (const revision of revisions) {
        const canonical = `asset-${revision.asset_id}/revisions/${revision.revision_number}/content`;
        if (
          !Number.isSafeInteger(revision.asset_id) ||
          revision.asset_id < 1 ||
          !Number.isSafeInteger(revision.revision_number) ||
          revision.revision_number < 1 ||
          !Number.isSafeInteger(revision.size) ||
          revision.size < 0 ||
          !/^[a-f0-9]{64}$/.test(revision.checksum) ||
          (revision.storage_key !== canonical &&
            revision.storage_key !== 'config-assets/' + canonical)
        )
          fail('BACKUP_CONFIG_INTEGRITY_FAILED');
        try {
          const file = path.join(store.dataRoot, 'config-assets', canonical);
          await privateDirectory(path.dirname(file));
          const actual = await hashFile(file);
          if (
            actual.size !== revision.size ||
            actual.sha256 !== revision.checksum
          )
            fail('BACKUP_CONFIG_INTEGRITY_FAILED');
        } catch {
          fail('BACKUP_CONFIG_INTEGRITY_FAILED');
        }
        after = revision.id;
      }
    }
  }

  async assertIdle(store: WorkspaceStore) {
    const checks: [string, string][] = [
      [
        'Workspaces',
        "lifecycle_state IN ('CREATING','DELETE_REQUESTED','RECOVERY_REQUIRED','ERROR') OR storage_state IN ('PROVISIONING','RECLAIMING')",
      ],
      [
        'WorkspaceOperations',
        "status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED')",
      ],
      [
        'TaskRuns',
        "status IN ('RESOLVING','RUNNING','RECOVERY_REQUIRED') OR active_workspace_id IS NOT NULL",
      ],
      ['WorkspaceSyncRuns', "status IN ('RUNNING','RECOVERY_REQUIRED')"],
      ['WorkspaceUpdateOutbox', "status='PROCESSING'"],
      ['TriggerEvents', "status='PROCESSING'"],
      ['RuntimeOperations', "status IN ('QUEUED','RUNNING')"],
      ['NotificationOutbox', "status='SENDING'"],
    ];
    for (const [table, condition] of checks) {
      if (
        (
          await store.all(
            `SELECT 1 AS busy FROM ${table} WHERE ${condition} LIMIT 1`,
          )
        ).length
      )
        return false;
    }
    for (const relative of [
      'tmp/config-materialization',
      'tmp/execution/node-bindings',
      'tmp/execution/workspace-owners',
      'tmp/workspace-v2',
      'runtime/python/quarantine',
      'runtime/node/quarantine',
    ]) {
      const root = path.join(store.dataRoot, relative);
      const walk = async (dir: string): Promise<void> => {
        const stat = await fs
          .lstat(dir)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
        if (!stat) return;
        if (!stat.isDirectory() || stat.isSymbolicLink())
          fail('BACKUP_RECOVERY_REQUIRED');
        for (const name of await fs.readdir(dir))
          await walk(path.join(dir, name));
      };
      await walk(root);
    }
    return true;
  }

  private async assertWorkspaceDirectories(
    store: WorkspaceStore,
    rows: WorkspaceRow[],
  ) {
    const managed = path.join(store.dataRoot, 'workspaces');
    const present = await fs
      .lstat(managed)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    if (!present) {
      if (rows.some((row) => row.storage_state === 'PRESENT'))
        fail('BACKUP_SOURCE_INCOMPLETE');
      return;
    }
    await privateDirectory(managed);
    for (const type of await fs.readdir(managed)) {
      if (!['local', 'git'].includes(type)) fail('BACKUP_SOURCE_INCOMPLETE');
      const group = path.join(managed, type);
      await privateDirectory(group);
      for (const name of await fs.readdir(group)) {
        const expected = rows.find(
          (row) =>
            row.root_key === `workspaces/${type}/${name}` &&
            row.storage_state === 'PRESENT',
        );
        if (!expected) fail('BACKUP_SOURCE_INCOMPLETE');
      }
    }
  }

  private async sourceReferences(
    store: WorkspaceStore,
    row: WorkspaceRow,
    root: string,
  ): Promise<SourceReference[]> {
    const sources = await store.all<SourceRow>(
      `SELECT s.task_id,s.relative_entrypoint,s.language,s.cwd_mode,s.cwd_relative_path,
       t.version,t.enabled,t.origin,t.discovery_state,t.discovery_key,t.discovery_definition
       FROM TaskSources s JOIN Tasks t ON t.id=s.task_id AND t.workspace_id=s.workspace_id
       WHERE s.workspace_id=? ORDER BY s.task_id`,
      [row.id],
    );
    const references: SourceReference[] = [];
    for (const source of sources) {
      relativeName(source.relative_entrypoint);
      const file = path.join(root, source.relative_entrypoint);
      let available = false;
      try {
        const handle = await fs.open(
          file,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = await handle.stat();
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            (process.getuid && stat.uid !== process.getuid())
          )
            fail('BACKUP_SOURCE_INCOMPLETE');
          available = true;
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!available) {
        let definition: Record<string, unknown> | null = null;
        try {
          definition = object(JSON.parse(source.discovery_definition || '{}'));
        } catch {
          fail('BACKUP_SOURCE_INCOMPLETE');
        }
        const proof = object(definition?.retirement);
        const git = (
          await store.all<GitWorkspaceRow>(
            'SELECT * FROM GitWorkspaces WHERE workspace_id=?',
            [row.id],
          )
        )[0];
        if (
          source.origin !== 'DISCOVERED' ||
          source.discovery_state !== 'RETIRED' ||
          source.enabled !== 0 ||
          !proof ||
          !git ||
          proof.workspace_id !== row.id ||
          proof.source_generation !== row.source_generation ||
          proof.content_revision !== row.content_revision ||
          proof.inventory_hash !== row.content_inventory_hash ||
          proof.after_commit !== git.applied_commit ||
          proof.discovery_key !== source.discovery_key ||
          proof.relative_entrypoint !== source.relative_entrypoint ||
          typeof proof.reason !== 'string'
        )
          fail('BACKUP_SOURCE_INCOMPLETE');
      }
      references.push({
        task_id: source.task_id,
        relative_entrypoint: source.relative_entrypoint,
        language: source.language,
        cwd_mode: source.cwd_mode,
        cwd_relative_path: source.cwd_relative_path,
        definition_version: source.version,
        availability: available ? 'PRESENT' : 'RETIRED_MISSING_EXPECTED',
      });
    }
    return references;
  }

  async collect(
    store: WorkspaceStore,
    mode: 'live' | 'snapshot' = 'live',
    expected?: WorkspaceManifestEntry[],
    sourceModes?: Map<string, number>,
  ) {
    try {
      return await this.collectUnchecked(store, mode, expected, sourceModes);
    } catch (error) {
      return backupFailure(error);
    }
  }

  private async collectUnchecked(
    store: WorkspaceStore,
    mode: 'live' | 'snapshot',
    expected?: WorkspaceManifestEntry[],
    sourceModes?: Map<string, number>,
  ) {
    await store.verifySchema();
    if (!(await this.assertIdle(store))) fail('BACKUP_RECOVERY_REQUIRED');
    await this.assertConfigAssets(store);
    await verifyRepositoryAssets(store, { relocated: mode === 'snapshot' });
    const rows = await store.all<WorkspaceRow>(
      'SELECT * FROM Workspaces ORDER BY id',
    );
    await this.assertWorkspaceDirectories(store, rows);
    const roots = new WorkspaceRootResolver(store.dataRoot);
    const result: WorkspaceManifestEntry[] = [];
    for (const row of rows) {
      const prior = expected?.find((item) => item.workspace_id === row.id);
      const root = roots.path(row);
      let entries: InventoryEntry[] = [],
        fileCount = 0,
        totalBytes = 0;
      if (row.storage_state === 'RECLAIMED') {
        if (
          row.lifecycle_state !== 'TOMBSTONED' ||
          (await fs.lstat(root).catch(() => null))
        )
          fail('BACKUP_SOURCE_INCOMPLETE');
      } else {
        await roots.verifyAt(row, root, mode === 'live');
        const scanned = await scanWorkspace(root, row.type, this.limits);
        entries = scanned.entries.map((entry) => ({ ...entry }));
        if (mode === 'snapshot') {
          if (!prior || !sourceModes || !Array.isArray(prior.content_inventory))
            fail('BACKUP_SOURCE_INCOMPLETE');
          for (const entry of entries) {
            const saved = prior.content_inventory.find(
              (item) => item.path === entry.path,
            );
            const originalMode = sourceModes.get(
              row.root_key + '/' + entry.path,
            );
            if (
              !saved ||
              saved.kind !== entry.kind ||
              saved.size !== entry.size ||
              saved.sha256 !== entry.sha256 ||
              saved.mode !== originalMode
            )
              fail('BACKUP_SOURCE_INCOMPLETE');
            entry.mode = saved.mode;
          }
          if (!sameRecords(entries, prior.content_inventory))
            fail('BACKUP_SOURCE_INCOMPLETE');
        }
        fileCount = entries.filter((entry) => entry.kind === 'file').length;
        totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
        if (
          hashWorkspaceRecords(entries) !== row.content_inventory_hash ||
          row.file_count !== fileCount ||
          row.total_bytes !== totalBytes
        )
          fail('BACKUP_SOURCE_INCOMPLETE');
      }
      const gitRow = (
        await store.all<GitWorkspaceRow>(
          'SELECT * FROM GitWorkspaces WHERE workspace_id=?',
          [row.id],
        )
      )[0];
      if ((row.type === 'LOCAL' && gitRow) || (row.type === 'GIT' && !gitRow))
        fail('BACKUP_SOURCE_INCOMPLETE');
      const holds = await store.all<{
        snapshot_key: string;
        released_at: string | null;
      }>(
        'SELECT id,snapshot_key,source_generation,content_revision,inventory_hash,manifest_hash,released_at FROM WorkspacePreservationHolds WHERE workspace_id=? ORDER BY id',
        [row.id],
      );
      let git: GitWorkspaceSummary | ReclaimedGitSummary | null =
        row.type === 'GIT' && row.storage_state === 'PRESENT'
          ? await inspectGitWorkspace(store, store.dataRoot, row, gitRow, {
              repair: false,
              relocated: mode === 'snapshot',
            })
          : null;
      if (row.type === 'GIT' && row.storage_state === 'RECLAIMED') {
        const repository = (
          await store.all<{
            id: number;
            host: string | null;
            storage_state: string;
            storage_path: string | null;
          }>(
            'SELECT id,host,storage_state,storage_path FROM Repositories WHERE id=?',
            [gitRow.repository_id],
          )
        )[0];
        if (!repository) fail('BACKUP_SOURCE_INCOMPLETE');
        git = {
          storage_state: 'RECLAIMED',
          repository_id: gitRow.repository_id,
          storage_key: gitRepositoryKey(repository),
          ref_type: gitRow.ref_type,
          ref_name: gitRow.ref_name,
          private_branch: gitRow.private_branch,
          resolved_commit: gitRow.resolved_commit,
          applied_commit: gitRow.applied_commit,
          last_verified_commit: gitRow.last_verified_commit,
          preservation_snapshot_keys: [
            ...new Set(
              holds
                .filter((hold) => hold.released_at === null)
                .map((hold) => hold.snapshot_key),
            ),
          ].sort(),
        };
      }
      if (
        mode === 'snapshot' &&
        git &&
        'head' in git &&
        prior?.git &&
        'head' in prior.git
      ) {
        // Payloads are stored privately. Original executable bits are authenticated
        // above against both inventories; only Git's filemode-derived status changes.
        const immutable = (value: GitWorkspaceSummary) => ({
          ...value,
          dirty: false,
          porcelain: '',
        });
        if (
          JSON.stringify(immutable(git)) !==
          JSON.stringify(immutable(prior.git))
        )
          fail('BACKUP_SOURCE_INCOMPLETE');
        git = prior.git;
      }
      const { environmentConfig: refs, syncDiscoveryEvents: events } =
        await collectManifestReferences(store, row);
      result.push({
        workspace_id: row.id,
        workspace_type: row.type,
        storage_key: row.root_key,
        lifecycle_state: row.lifecycle_state,
        storage_state: row.storage_state,
        source_generation: row.source_generation,
        content_revision: row.content_revision,
        content_inventory_hash: row.content_inventory_hash,
        root_identity: {
          owner_token: row.root_owner_token,
          dev: row.root_device,
          ino: row.root_inode,
        },
        file_count: fileCount,
        entry_count: entries.length,
        total_bytes: totalBytes,
        content_inventory: entries,
        source_references:
          row.storage_state === 'PRESENT'
            ? await this.sourceReferences(store, row, root)
            : [],
        git,
        environment_config_references: refs,
        sync_discovery_event_references: events,
        preservation_holds: holds,
      });
    }
    if (expected && JSON.stringify(result) !== JSON.stringify(expected))
      fail('BACKUP_SOURCE_INCOMPLETE');
    return result;
  }
}
