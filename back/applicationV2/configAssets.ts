import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { TextDecoder } from 'util';
import type { V2Services } from './types';
import { fail } from '../services/workspaceV2/errors';
import { WorkspaceRevisionReader } from '../services/taskExecutionV2/materialization';
import { atomicPrivateWrite, syncDirectory } from '../shared/configAssets';
import { object, text, boolean, number, choice } from './taskValidation';

/** Immutable Config assets in the explicit v2 Store; source files are never targets. */
export class CandidateConfigAssets {
  constructor(
    readonly services: Pick<V2Services, 'store' | 'roots' | 'leases'>,
  ) {}
  async asset(id: number) {
    const row = (
      await this.services.store.all<any>(
        'SELECT * FROM ConfigAssets WHERE id=?',
        [number(id)],
      )
    )[0];
    if (!row) fail('CONFIG_ASSET_NOT_FOUND', 404);
    return row;
  }
  async revisions(id: number) {
    await this.asset(id);
    const rows = await this.services.store.all<any>(
      'SELECT * FROM ConfigAssetRevisions WHERE asset_id=? ORDER BY revision_number DESC',
      [id],
    );
    return rows.map((r) => ({
      id: r.id,
      asset_id: r.asset_id,
      revision_number: r.revision_number,
      checksum: r.checksum,
      size: r.size,
      createdAt: r.createdAt,
    }));
  }
  async usage(id: number) {
    await this.asset(id);
    const workspaces = await this.services.store.all<any>(
      'SELECT id,workspace_id,revision_id FROM WorkspaceConfigBindings WHERE asset_id=? ORDER BY id',
      [id],
    );
    const tasks = await this.services.store.all<any>(
      'SELECT id,task_id,revision_id FROM TaskConfigBindings WHERE asset_id=? ORDER BY id',
      [id],
    );
    const history = (
      await this.services.store.all<{ n: number }>(
        `SELECT COUNT(DISTINCT r.id) n FROM TaskRuns r JOIN json_tree(COALESCE(r.source_snapshot,r.snapshot_metadata,'{}')) j WHERE j.key='asset_id' AND j.value=?`,
        [id],
      )
    )[0].n;
    return { workspaces, tasks, history_count: history };
  }
  async dto(id: number) {
    const row = await this.asset(id),
      current =
        (await this.revisions(id)).find(
          (r) => r.id === row.current_revision_id,
        ) ?? null,
      usage = await this.usage(id);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      content_type: row.content_type,
      is_secret: !!row.is_secret,
      current_revision_id: row.current_revision_id,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      current_revision: current,
      has_content: !!current,
      usage_count: usage.workspaces.length + usage.tasks.length,
    };
  }
  async list() {
    return Promise.all(
      (
        await this.services.store.all<{ id: number }>(
          'SELECT id FROM ConfigAssets ORDER BY id',
        )
      ).map((row) => this.dto(row.id)),
    );
  }
  async content(id: number) {
    const asset = await this.asset(id);
    if (asset.is_secret) fail('SECRET_CONTENT_UNAVAILABLE', 403);
    const revision = (
      await this.services.store.all<any>(
        'SELECT * FROM ConfigAssetRevisions WHERE id=? AND asset_id=?',
        [asset.current_revision_id, id],
      )
    )[0];
    if (!revision) fail('CONFIG_REVISION_NOT_FOUND', 404);
    return (
      await new WorkspaceRevisionReader(
        this.services.store,
        this.services.roots,
      ).readRevision(revision)
    ).toString('utf8');
  }
  async save(input: unknown, id?: number) {
    const b = object(
      input,
      [
        'name',
        'description',
        'content_type',
        'is_secret',
        'content',
        'expected_version',
      ],
      ['name', 'is_secret', ...(id === undefined ? [] : ['expected_version'])],
    );
    const name = text(b.name, 255).trim(),
      description =
        b.description === undefined ? '' : text(b.description, 4096, true),
      secret = boolean(b.is_secret);
    if (
      b.content_type !== undefined &&
      choice(b.content_type, ['TEXT', 'BINARY']) !== 'TEXT'
    )
      fail('CONFIG_BINARY_NOT_SUPPORTED', 400);
    const bytes =
      b.content === undefined
        ? undefined
        : Buffer.from(text(b.content, 1048576, true), 'utf8');
    if (
      bytes &&
      new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== b.content
    )
      fail('CONFIG_CONTENT_INVALID', 400);
    if (id === undefined && !bytes) fail('CONFIG_CONTENT_REQUIRED', 400);
    const saved = await this.services.leases.barrier.mutation(() =>
      this.services.store.transaction(async (tx) => {
        let row =
          id === undefined
            ? null
            : (
                await tx.all<any>('SELECT * FROM ConfigAssets WHERE id=?', [
                  number(id),
                ])
              )[0];
        if (id !== undefined && !row) fail('CONFIG_ASSET_NOT_FOUND', 404);
        if (row && row.version !== number(b.expected_version))
          fail('CONFIG_EDIT_CONFLICT');
        if (row?.is_secret && !secret)
          fail('CONFIG_SECRET_DOWNGRADE_FORBIDDEN', 400);
        const now = new Date().toISOString();
        if (!row) {
          const result = await tx.run(
            "INSERT INTO ConfigAssets(name,description,content_type,is_secret,version,createdAt,updatedAt) VALUES(?,?,'TEXT',?,1,?,?)",
            [name, description, secret ? 1 : 0, now, now],
          );
          row = { id: result.lastID, version: 1, current_revision_id: null };
        }
        if (bytes) {
          const latest = (
            await tx.all<{ n: number }>(
              'SELECT COALESCE(MAX(revision_number),0) n FROM ConfigAssetRevisions WHERE asset_id=?',
              [row.id],
            )
          )[0].n;
          const parent = await this.services.roots.directory(
            `config-assets/asset-${row.id}/revisions`,
            true,
          );
          let revision = latest + 1,
            directory = '';
          for (let probe = 0; probe < 1000; probe++, revision++) {
            const candidate = path.join(parent, String(revision));
            try {
              await fs.mkdir(candidate, { mode: 0o700 });
              directory = candidate;
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                throw error;
            }
          }
          if (!directory) fail('CONFIG_SAVE_FAILED');
          // Bounded immutable write (<=1 MiB), no OS-lock/network/child wait in SQL.
          // Failed transactions retain orphan immutable storage, never delete it.
          await syncDirectory(parent);
          await atomicPrivateWrite(
            path.join(directory, 'content'),
            bytes,
            0o400,
          );
          const result = await tx.run(
            'INSERT INTO ConfigAssetRevisions(asset_id,revision_number,checksum,size,storage_key,createdAt) VALUES(?,?,?,?,?,?)',
            [
              row.id,
              revision,
              createHash('sha256').update(bytes).digest('hex'),
              bytes.length,
              `asset-${row.id}/revisions/${revision}/content`,
              now,
            ],
          );
          row.current_revision_id = result.lastID;
        }
        await tx.run(
          'UPDATE ConfigAssets SET name=?,description=?,is_secret=?,current_revision_id=?,version=?,updatedAt=? WHERE id=?',
          [
            name,
            description,
            secret ? 1 : 0,
            row.current_revision_id,
            row.version + (id === undefined ? 0 : 1),
            now,
            row.id,
          ],
        );
        return row.id as number;
      }),
    );
    return this.dto(saved);
  }
  async remove(id: number, version: number) {
    return this.services.leases.barrier.mutation(() =>
      this.services.store.transaction(async (tx) => {
        const asset = await this.asset(id);
        if (asset.version !== number(version)) fail('CONFIG_EDIT_CONFLICT');
        const usage = await this.usage(id);
        if (
          usage.workspaces.length ||
          usage.tasks.length ||
          usage.history_count
        )
          fail('CONFIG_ASSET_IN_USE');
        await tx.run(
          'UPDATE ConfigAssets SET current_revision_id=NULL WHERE id=?',
          [id],
        );
        await tx.run('DELETE FROM ConfigAssetRevisions WHERE asset_id=?', [id]);
        await tx.run('DELETE FROM ConfigAssets WHERE id=?', [id]);
        // Physical immutable bytes remain for an explicit future retention/GC policy.
        return null;
      }),
    );
  }
}
