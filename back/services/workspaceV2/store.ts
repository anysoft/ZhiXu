import sqlite3 from 'sqlite3';
import fs from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';
import { fail, positiveId, WorkspaceFoundationError } from './errors';
import type { Inventory, OperationRow, RunResult, WorkspaceRow } from './types';

export const WORKSPACE_SCHEMA_IDENTITY = 'zhixu.workspace.v2.s0.1';
export const WORKSPACE_SCHEMA_SIGNATURE =
  'f466bedcecdad199bfb3ca501800f7fac026300d5fc2ad91ea77038cc782fe4c';

interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

/** Checks the whole parent chain, not only the final path component. */
export async function assertPrivatePath(target: string, directory: boolean) {
  if (
    !path.isAbsolute(target) ||
    path.resolve(target) !== target ||
    target === '/'
  )
    fail('WORKSPACE_PATH_INVALID', 400);
  const pieces = target.split(path.sep).filter(Boolean);
  let current = path.parse(target).root;
  for (let i = 0; i < pieces.length; i++) {
    current = path.join(current, pieces[i]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (i < pieces.length - 1 && !stat.isDirectory()))
      fail('WORKSPACE_PATH_FORBIDDEN', 403);
    if (i === pieces.length - 1) {
      if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
        fail('WORKSPACE_PATH_FORBIDDEN', 403);
      if (process.getuid && stat.uid !== process.getuid())
        fail('WORKSPACE_PATH_FORBIDDEN', 403);
      if ((stat.mode & 0o077) !== 0) fail('WORKSPACE_PATH_FORBIDDEN', 403);
    }
  }
}

/**
 * Explicit, existing fresh-v2 candidate database only. This class cannot initialize,
 * migrate, drop, or bind the application's global v9 Sequelize connection.
 */
export class WorkspaceStore {
  private tail: Promise<void> = Promise.resolve();
  private readonly inside = new AsyncLocalStorage<{ active: boolean }>();
  private closed = false;

  private constructor(
    private readonly connection: sqlite3.Database,
    readonly databasePath: string,
    readonly dataRoot: string,
    readonly readOnly: boolean,
  ) {}

  static async open(
    databasePath: string,
    dataRoot: string,
    options: { readOnly?: boolean } = {},
  ) {
    try {
      return await this.openExisting(databasePath, dataRoot, options);
    } catch (error) {
      if (error instanceof WorkspaceFoundationError) throw error;
      fail('UNSUPPORTED_DATABASE_SCHEMA', 503);
    }
  }

  private static async openExisting(
    databasePath: string,
    dataRoot: string,
    options: { readOnly?: boolean },
  ) {
    await assertPrivatePath(dataRoot, true);
    if (databasePath !== path.join(dataRoot, 'db/database.sqlite'))
      fail('WORKSPACE_PATH_INVALID', 400);
    await assertPrivatePath(path.dirname(databasePath), true);
    await assertPrivatePath(databasePath, false);
    // Validate through an opened descriptor too; never create a missing DB.
    const file = await fs.open(
      databasePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await file.stat();
    try {
      const connection = await new Promise<sqlite3.Database>(
        (resolve, reject) => {
          const db: sqlite3.Database = new sqlite3.Database(
            databasePath,
            options.readOnly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE,
            (error) => (error ? reject(error) : resolve(db)),
          );
        },
      );
      const store = new WorkspaceStore(
        connection,
        databasePath,
        dataRoot,
        !!options.readOnly,
      );
      try {
        const after = await fs.lstat(databasePath);
        if (after.dev !== before.dev || after.ino !== before.ino)
          fail('WORKSPACE_PATH_FORBIDDEN', 403);
        await store.exec(
          'PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA busy_timeout=5000;',
        );
        await store.verifySchema();
        return store;
      } catch (error) {
        await store.close();
        throw error;
      }
    } catch (error) {
      if (error instanceof WorkspaceFoundationError) throw error;
      fail('UNSUPPORTED_DATABASE_SCHEMA', 503);
    } finally {
      await file.close();
    }
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) fail('WORKSPACE_NOT_READY');
    if (this.inside.getStore()?.active) return action();
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const scope = { active: true };
    try {
      return await this.inside.run(scope, action);
    } finally {
      scope.active = false;
      release();
    }
  }

  all<T extends object = Record<string, unknown>>(
    sql: string,
    parameters: unknown[] = [],
  ): Promise<T[]> {
    return this.exclusive(
      () =>
        new Promise<T[]>((resolve, reject) => {
          this.connection.all<T>(sql, parameters, (error, rows) => {
            if (error) reject(this.safeSqlError(error));
            else resolve(rows);
          });
        }),
    );
  }

  run(sql: string, parameters: unknown[] = []): Promise<RunResult> {
    if (this.readOnly) fail('WORKSPACE_PATH_FORBIDDEN', 403);
    return this.exclusive(
      () =>
        new Promise<RunResult>((resolve, reject) => {
          const safeError = (error: Error) => this.safeSqlError(error);
          this.connection.run(sql, parameters, function (error) {
            if (error) reject(safeError(error));
            else {
              const lastID = Number(this.lastID);
              if (!Number.isSafeInteger(lastID)) {
                reject(
                  new WorkspaceFoundationError('WORKSPACE_OPERATION_FAILED'),
                );
              } else resolve({ changes: this.changes, lastID });
            }
          });
        }),
    );
  }

  private exec(sql: string): Promise<void> {
    return this.exclusive(
      () =>
        new Promise<void>((resolve, reject) => {
          this.connection.exec(sql, (error) => {
            if (error) reject(this.safeSqlError(error));
            else resolve();
          });
        }),
    );
  }

  async transaction<T>(action: (transaction: WorkspaceStore) => Promise<T>) {
    if (this.readOnly) fail('WORKSPACE_PATH_FORBIDDEN', 403);
    // No nested SQLite transaction: the owning call supplies the same executor.
    if (this.inside.getStore()?.active) return action(this);
    return this.exclusive(async () => {
      await this.exec('BEGIN IMMEDIATE');
      try {
        const result = await action(this);
        await this.exec('COMMIT');
        return result;
      } catch (error) {
        await this.exec('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  async workspace(id: number) {
    const rows = await this.all<WorkspaceRow>(
      'SELECT * FROM Workspaces WHERE id=?',
      [positiveId(id)],
    );
    if (!rows[0]) fail('WORKSPACE_NOT_FOUND', 404);
    return rows[0];
  }
  getWorkspace(id: number) {
    return this.workspace(id);
  }

  async assertAccessible(id: number, mutation: boolean, operationId?: string) {
    const row = await this.workspace(id);
    if (row.lifecycle_state === 'RECOVERY_REQUIRED')
      fail('WORKSPACE_RECOVERY_REQUIRED');
    if (mutation && row.lifecycle_state === 'ARCHIVED')
      fail('WORKSPACE_ARCHIVED');
    if (
      row.storage_state !== 'PRESENT' ||
      (row.lifecycle_state !== 'READY' &&
        !mutation &&
        row.lifecycle_state !== 'ARCHIVED') ||
      (mutation && row.lifecycle_state !== 'READY')
    )
      fail('WORKSPACE_NOT_READY');
    const operations = await this.all<OperationRow>(
      "SELECT * FROM WorkspaceOperations WHERE workspace_id=? AND status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED')",
      [id],
    );
    if (operations.some((op) => op.id !== operationId)) {
      if (operations.some((op) => op.status === 'RECOVERY_REQUIRED'))
        fail('WORKSPACE_RECOVERY_REQUIRED');
      fail('WORKSPACE_BUSY');
    }
    const recovering = await this.all(
      "SELECT id FROM WorkspaceSyncRuns WHERE workspace_id=? AND status='RECOVERY_REQUIRED' LIMIT 1",
      [id],
    );
    if (recovering.length) fail('SYNC_RECOVERY_REQUIRED');
    return row;
  }

  async updateInventory(
    id: number,
    expectedRevision: number,
    inventory: Inventory,
  ) {
    if (!/^[0-9a-f]{64}$/.test(inventory.hash)) fail('SOURCE_UNVERIFIED');
    const result = await this.run(
      `UPDATE Workspaces SET content_revision=content_revision+CASE WHEN content_inventory_hash<>? THEN 1 ELSE 0 END,
       content_inventory_hash=?,file_count=?,total_bytes=?,updatedAt=? WHERE id=? AND content_revision=?`,
      [
        inventory.hash,
        inventory.hash,
        inventory.fileCount,
        inventory.totalBytes,
        new Date().toISOString(),
        id,
        expectedRevision,
      ],
    );
    if (result.changes !== 1) fail('WORKSPACE_VERSION_CONFLICT');
    return this.workspace(id);
  }

  async verifySchema() {
    const metadata = await this.all<{
      schema_identity: string;
      schema_version: number;
      schema_signature: string;
      model_contract: string;
    }>('SELECT * FROM PlatformMetadata').catch(() =>
      fail('UNSUPPORTED_DATABASE_SCHEMA', 503),
    );
    if (
      metadata.length !== 1 ||
      metadata[0].schema_identity !== WORKSPACE_SCHEMA_IDENTITY ||
      metadata[0].schema_version !== 1
    )
      fail('UNSUPPORTED_DATABASE_SCHEMA', 503);
    const objects = await this.all<SchemaObject>(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name",
    );
    const tokens =
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[^\s'"`\[]+/g;
    const signature = createHash('sha256')
      .update(
        JSON.stringify(
          objects.map((row) => ({
            type: row.type,
            name: row.name,
            table: row.tbl_name,
            sql: (row.sql.match(tokens) || []).join(' '),
          })),
        ),
      )
      .digest('hex');
    const integrity = await this.all<{ integrity_check: string }>(
      'PRAGMA integrity_check',
    );
    const foreignKeys = await this.all('PRAGMA foreign_key_check');
    if (
      metadata[0].schema_signature !== WORKSPACE_SCHEMA_SIGNATURE ||
      metadata[0].model_contract !== 'S0-2026-11-13' ||
      signature !== WORKSPACE_SCHEMA_SIGNATURE ||
      foreignKeys.length ||
      integrity.length !== 1 ||
      integrity[0].integrity_check !== 'ok'
    )
      fail('DATABASE_SCHEMA_CORRUPTED', 503);
  }

  private safeSqlError(error: Error) {
    const code = error.message.match(
      /(?:SQLITE_CONSTRAINT:\s*)?([A-Z][A-Z0-9_]{3,})$/,
    )?.[1];
    return new WorkspaceFoundationError(code || 'WORKSPACE_OPERATION_FAILED');
  }

  async close() {
    if (this.closed) return;
    await this.exclusive(
      () =>
        new Promise<void>((resolve, reject) => {
          this.connection.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    this.closed = true;
  }
}
