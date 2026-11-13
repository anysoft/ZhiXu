import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { WorkspaceStore } from './store';
import { WorkspaceRootResolver } from './roots';
import { fail } from './errors';
import { readJson } from '../backup/files';
import { targetPath } from '../../shared/configAssets';
import type { WorkspaceRow } from './types';

const key = (id: number) =>
  createHash('sha256').update(`workspace:${id}`).digest('hex');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('WORKSPACE_RECOVERY_REQUIRED');
  return value as Record<string, unknown>;
}
function contained(root: string, candidate: unknown): candidate is string {
  return (
    typeof candidate === 'string' &&
    path.isAbsolute(candidate) &&
    path.resolve(candidate) === candidate &&
    (candidate === root || candidate.startsWith(root + path.sep))
  );
}

/** Read-only admission proof. Other Workspace journals are accepted only with canonical ownership and a durable execution owner. */
export async function assertWorkspaceJournalIsolation(
  store: WorkspaceStore,
  roots: WorkspaceRootResolver,
  workspaceId: number,
  options: { allowCurrentOwner?: boolean } = {},
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let observed: string | undefined;
    try {
      const groups = [
        ['owner', 'tmp/execution/workspace-owners'],
        ['config', 'tmp/config-materialization'],
        ['node', 'tmp/execution/node-bindings'],
      ] as const;
      let workspaceRows: WorkspaceRow[] | undefined;
      const rows = async () =>
        workspaceRows ??
        (workspaceRows = await store.all<WorkspaceRow>(
          'SELECT * FROM Workspaces ORDER BY id LIMIT 20001',
        ));
      const directory = async (relative: string) => {
        const filename = path.join(store.dataRoot, relative);
        const stat = await fs
          .lstat(filename)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
        if (!stat) return null;
        await roots.directory(relative);
        return filename;
      };
      const owner = async (id: number) => {
        const row = (await rows()).find((w) => w.id === id);
        if (!row || (workspaceRows?.length ?? 0) > 20000)
          fail('WORKSPACE_RECOVERY_REQUIRED');
        if (id === workspaceId && !options.allowCurrentOwner)
          fail('WORKSPACE_RECOVERY_REQUIRED');
        const owned = await roots.requireOwned(row);
        const runs = await store.all<{ id: number }>(
          "SELECT id FROM TaskRuns WHERE workspace_id=? AND active_workspace_id=? AND owner_token IS NOT NULL AND status IN ('RESOLVING','RUNNING','RECOVERY_REQUIRED') LIMIT 1",
          [id, id],
        );
        if (!runs.length) fail('WORKSPACE_RECOVERY_REQUIRED');
        return { row, root: owned.root, owned };
      };
      for (const [kind, relative] of groups) {
        const base = await directory(relative);
        if (!base) continue;
        for (const name of await fs.readdir(base)) {
          observed = undefined;
          if (kind === 'config') {
            if (!/^[a-f0-9]{64}$/.test(name))
              fail('WORKSPACE_RECOVERY_REQUIRED');
            observed = path.join(base, name);
            const row = (await rows()).find((w) => key(w.id) === name);
            if (!row) fail('WORKSPACE_RECOVERY_REQUIRED');
            const proof = await owner(row.id);
            const nested = await directory(relative + '/' + name);
            if (!nested) fail('WORKSPACE_RECOVERY_REQUIRED');
            for (const run of await fs.readdir(nested)) {
              observed = undefined;
              if (!/^run-[a-f0-9-]{36}$/.test(run))
                fail('WORKSPACE_RECOVERY_REQUIRED');
              observed = path.join(nested, run);
              const runRoot = await directory(
                relative + '/' + name + '/' + run,
              );
              if (!runRoot) fail('WORKSPACE_RECOVERY_REQUIRED');
              const files = await fs.readdir(runRoot);
              if (
                files.some(
                  (n) =>
                    !/^journal\.json(?:\.tmp-[a-f0-9]{20})?$/.test(n) &&
                    !/^(?:backup|content)-[0-9]+$/.test(n),
                )
              )
                fail('WORKSPACE_RECOVERY_REQUIRED');
              if (!files.includes('journal.json')) {
                if (
                  files.every((n) =>
                    /^journal\.json\.tmp-[a-f0-9]{20}$/.test(n),
                  )
                )
                  continue;
                fail('WORKSPACE_RECOVERY_REQUIRED');
              }
              const journal = object(
                await readJson(
                  (observed = path.join(runRoot, 'journal.json')),
                  1024 * 1024,
                  true,
                ),
              );
              const workspace = object(journal.workspace);
              if (
                journal.version !== 1 ||
                journal.run !== run ||
                workspace.workspaceRoot !== proof.root ||
                workspace.resourceKey !== name ||
                !contained(proof.root, workspace.cwd) ||
                !contained(proof.root, workspace.taskDir) ||
                !Array.isArray(journal.entries) ||
                journal.entries.length > 10000
              )
                fail('WORKSPACE_RECOVERY_REQUIRED');
              for (const [index, input] of journal.entries.entries()) {
                const entry = object(input);
                if (
                  !contained(proof.root, entry.root) ||
                  typeof entry.relative !== 'string'
                )
                  fail('WORKSPACE_RECOVERY_REQUIRED');
                targetPath(entry.relative);
                const target = path.join(entry.root, entry.relative);
                if (
                  entry.copy !== path.join(runRoot, `content-${index}`) ||
                  entry.backup !== path.join(runRoot, `backup-${index}`) ||
                  entry.temporary !==
                    path.join(
                      path.dirname(target),
                      `.platform-${run}-${index}`,
                    ) ||
                  !['COPY', 'SYMLINK'].includes(String(entry.mode)) ||
                  !['PLANNED', 'BACKED_UP', 'INSTALLED'].includes(
                    String(entry.phase),
                  )
                )
                  fail('WORKSPACE_RECOVERY_REQUIRED');
              }
            }
          } else if (kind === 'owner') {
            const match =
              /^workspace-([1-9][0-9]*)\.json(\.tmp-[a-f0-9]{20})?$/.exec(name);
            if (!match) fail('WORKSPACE_RECOVERY_REQUIRED');
            observed = path.join(base, name);
            const id = Number(match[1]);
            if (!Number.isSafeInteger(id)) fail('WORKSPACE_RECOVERY_REQUIRED');
            const proof = await owner(id);
            if (match[2]) {
              const temporary = await fs
                .lstat(path.join(base, name))
                .catch((error: NodeJS.ErrnoException) => {
                  if (error.code === 'ENOENT') return null;
                  throw error;
                });
              if (
                temporary &&
                (!temporary.isFile() ||
                  temporary.isSymbolicLink() ||
                  temporary.nlink !== 1 ||
                  temporary.mode & 0o077 ||
                  (process.getuid && temporary.uid !== process.getuid()))
              )
                fail('WORKSPACE_RECOVERY_REQUIRED');
              continue;
            }
            const record = object(
              await readJson(path.join(base, name), 65536, true),
            );
            const uuid =
              /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
            if (
              record.version !== 1 ||
              !uuid.test(String(record.operation_token)) ||
              record.workspace_id !== id ||
              record.workspace_type !== proof.row.type ||
              record.resource_key !== key(id) ||
              record.root_key !== proof.row.root_key ||
              record.root_device !== proof.owned.dev ||
              record.root_inode !== proof.owned.ino ||
              record.root_owner_token !== proof.owned.marker.owner_token ||
              record.source_generation !== proof.row.source_generation ||
              !Number.isSafeInteger(record.task_run_id) ||
              Number(record.task_run_id) < 1 ||
              !uuid.test(String(record.run_owner_token))
            )
              fail('WORKSPACE_RECOVERY_REQUIRED');
            const run = (
              await store.all<{
                workspace_id: number;
                expected_source_generation: number;
                owner_token: string | null;
                active_workspace_id: number | null;
                status: string;
              }>(
                'SELECT workspace_id,expected_source_generation,owner_token,active_workspace_id,status FROM TaskRuns WHERE id=?',
                [record.task_run_id],
              )
            )[0];
            if (
              !run ||
              run.workspace_id !== id ||
              run.active_workspace_id !== id ||
              run.expected_source_generation !== record.source_generation ||
              !uuid.test(String(run.owner_token)) ||
              !['RESOLVING', 'RUNNING', 'RECOVERY_REQUIRED'].includes(
                run.status,
              )
            )
              fail('WORKSPACE_RECOVERY_REQUIRED');
          } else {
            const match =
              /^workspace-([1-9][0-9]*)\.json(\.tmp-[a-f0-9]{20})?$/.exec(name);
            if (!match) fail('WORKSPACE_RECOVERY_REQUIRED');
            observed = path.join(base, name);
            const id = Number(match[1]);
            if (!Number.isSafeInteger(id)) fail('WORKSPACE_RECOVERY_REQUIRED');
            const proof = await owner(id);
            if (match[2]) {
              const temporary = path.join(base, name);
              const stat = await fs
                .lstat(temporary)
                .catch((error: NodeJS.ErrnoException) => {
                  if (error.code === 'ENOENT') return null;
                  throw error;
                });
              if (
                stat &&
                (!stat.isFile() ||
                  stat.isSymbolicLink() ||
                  stat.nlink !== 1 ||
                  stat.mode & 0o077 ||
                  (process.getuid && stat.uid !== process.getuid()))
              )
                fail('WORKSPACE_RECOVERY_REQUIRED');
              // Atomic journal publication may still be writing these private bytes.
              // The canonical filename and durable owner prove its separate resource;
              // never parse a partial document or follow it as a cleanup instruction.
              continue;
            }
            const journal = object(
              await readJson(path.join(base, name), 1024 * 1024, true),
            );
            if (
              journal.version !== 1 ||
              journal.root !== proof.root ||
              !contained(store.dataRoot, journal.destination) ||
              typeof journal.staging !== 'string' ||
              !/^\.platform-node-[a-f0-9-]{36}$/.test(journal.staging)
            )
              fail('WORKSPACE_RECOVERY_REQUIRED');
            const relativeBuild = path.relative(
              store.dataRoot,
              journal.destination,
            );
            const buildMatch =
              /^runtime\/node\/environments\/env-([1-9][0-9]*)\/builds\/build-([1-9][0-9]*)\/node_modules$/.exec(
                relativeBuild,
              );
            if (!buildMatch) fail('WORKSPACE_RECOVERY_REQUIRED');
            const environmentId = Number(buildMatch[1]),
              buildId = Number(buildMatch[2]);
            const build = (
              await store.all(
                "SELECT id FROM NodeEnvironmentBuilds WHERE id=? AND environment_id=? AND state='READY' AND health='HEALTHY'",
                [buildId, environmentId],
              )
            )[0];
            if (!build) fail('WORKSPACE_RECOVERY_REQUIRED');
            const buildRoot = path.dirname(journal.destination);
            let current = await roots.root();
            for (const part of path
              .relative(store.dataRoot, buildRoot)
              .split(path.sep)) {
              current = path.join(current, part);
              const ancestor = await fs.lstat(current);
              if (
                !ancestor.isDirectory() ||
                ancestor.isSymbolicLink() ||
                ancestor.mode & 0o022 ||
                (process.getuid && ancestor.uid !== process.getuid())
              )
                fail('WORKSPACE_RECOVERY_REQUIRED');
            }
            const stat = await fs.lstat(buildRoot);
            const modules = await fs.lstat(journal.destination);
            if (
              !modules.isDirectory() ||
              modules.isSymbolicLink() ||
              (process.getuid && modules.uid !== process.getuid())
            )
              fail('WORKSPACE_RECOVERY_REQUIRED');
            const marker = object(
              await readJson(
                path.join(
                  store.dataRoot,
                  `runtime/node/ownership/build-${buildId}.json`,
                ),
              ),
            );
            if (
              marker.owner !== 'platform-node' ||
              marker.kind !== 'build' ||
              marker.id !== buildId ||
              marker.environment !== environmentId ||
              marker.dev !== stat.dev ||
              marker.ino !== stat.ino
            )
              fail('WORKSPACE_RECOVERY_REQUIRED');
          }
        }
      }
      return;
    } catch {
      if (observed) {
        const remaining = await fs
          .lstat(observed)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
        // A stale listing is not an ownership failure. Re-scan all surviving
        // artifacts after a canonical entry disappears; never skip unknown data.
        if (!remaining) continue;
      }
      fail('WORKSPACE_RECOVERY_REQUIRED');
    }
  }
  fail('WORKSPACE_BUSY');
}
