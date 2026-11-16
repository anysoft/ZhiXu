import fs from 'fs/promises';
import path from 'path';
import { WorkspaceFiles } from '../services/workspaceFiles';
import { parsePorcelain } from '../shared/worktreeStatus';
import { RuntimeLease } from '../services/runtimeProcess';
import RuntimePathResolver from '../services/runtimePaths';
import { openRegular, privateJson, readJson } from '../services/backup/files';
import {
  relativeWorkspacePath,
  scanWorkspace,
  OWNER_MARKER,
} from '../services/workspaceV2/inventory';
import { assertWorkspaceJournalIsolation } from '../services/workspaceV2/journals';
import { fail, WorkspaceFoundationError } from '../services/workspaceV2/errors';
import { validateWorkspaceRef } from '../services/workspaceV2/gitStorage';
import type {
  WorkspaceRow,
  GitWorkspaceRow,
  OperationRow,
} from '../services/workspaceV2/types';
import type { WorkspaceLease } from '../services/workspaceV2/lease';
import type {
  SyncRunRow,
  SyncPolicyRow,
  SyncPolicyWrite,
} from '../services/gitWorkspaceV2/types';
import type { ApiCall, V2Services, RouteMap } from './types';
import {
  candidateGitResources,
  CandidateGitResources,
} from './repositoryResources';
import { operationDto, workspaceDto } from './workspaceApi';
import * as v from './workspaceValidation';

type Run = (
  args: string[],
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  allowFailure?: boolean,
) => Promise<{ code: number; stdout: string; stderr: string }>;
interface SuppressionDtoRow {
  workspace_id: number;
  discovery_key: string;
  reason: string;
  created_at: string;
}
const suppressionDto = (row: SuppressionDtoRow) => ({
  ...row,
  created_at: v.utcTimestamp(row.created_at),
});
class IdentityPaths extends RuntimePathResolver {
  async lock() {
    return path.join(await this.directory('.locks', true), 'git-identity.lock');
  }
}
async function identity(s: V2Services) {
  const directory = await s.roots.directory('config', true),
    file = path.join(directory, 'git-identity.json');
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return { name: '', email: '', version: 1 };
  const handle = await openRegular(file);
  try {
    if ((await handle.stat()).size > 4096) fail('INVALID_REQUEST', 400);
  } finally {
    await handle.close();
  }
  const value = v.object(
    await readJson(file),
    ['name', 'email', 'version'],
    ['name', 'email', 'version'],
  );
  return {
    name: v.text(value.name, 255, true),
    email: v.text(value.email, 255, true),
    version: v.integer(value.version),
  };
}
function syncDto(row: SyncRunRow) {
  return {
    id: row.id,
    initial: !!row.initial,
    workspace_id: row.workspace_id,
    status: row.status,
    phase: row.phase,
    source_generation: row.source_generation,
    policy_version: row.policy_version,
    before_commit: row.before_commit,
    target_commit: row.target_commit,
    actual_commit: row.actual_commit,
    after_commit: row.after_commit,
    git_update_status: row.git_update_status,
    discovery_status: row.discovery_status,
    event_status: row.event_status,
    trigger_source: row.trigger_source,
    error_code: row.error_code,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}
function policyDto(row: SyncPolicyRow) {
  const schedule =
    row.schedule_kind === 'NONE'
      ? null
      : row.schedule_kind === 'CRON'
      ? {
          type: 'CRON',
          expression: row.cron_expression,
          timezone: row.timezone,
          misfire_policy: row.misfire_policy,
        }
      : {
          type: 'INTERVAL',
          interval_ms: row.interval_ms,
          anchor_at: row.anchor_at,
          misfire_policy: row.misfire_policy,
        };
  return {
    workspace_id: row.workspace_id,
    version: row.version,
    enabled: !!row.enabled,
    mode: row.update_mode,
    schedule,
    next_due_at: row.next_due_at,
  };
}
export function gitApiRoutes(
  s: V2Services,
  resources: CandidateGitResources = candidateGitResources(s),
): RouteMap {
  const id = (params: Record<string, string>) => v.pathId(params.id);
  const source = async (workspaceId: number) => {
    const row = await s.store.workspace(workspaceId);
    if (row.type !== 'GIT') fail('WORKSPACE_TYPE_INVALID', 422);
    const git = (
      await s.store.all<GitWorkspaceRow>(
        'SELECT * FROM GitWorkspaces WHERE workspace_id=?',
        [workspaceId],
      )
    )[0];
    if (!git) fail('WORKSPACE_TYPE_INVALID', 422);
    return { row, git };
  };
  const scopedRun = async (params: Record<string, string>) => {
    const row = await s.sync.get(v.pathId(params.syncRunId));
    if (row.workspace_id !== id(params)) fail('SYNC_RUN_NOT_FOUND', 404);
    return row;
  };
  const locked = async <T>(
    workspaceId: number,
    write: boolean,
    action: (
      row: WorkspaceRow,
      git: GitWorkspaceRow,
      leases: WorkspaceLease[],
      run: Run,
    ) => Promise<T>,
  ) => {
    const initial = await source(workspaceId);
    return s.leases.withRepository(
      initial.git.repository_id,
      'GIT_WORKBENCH',
      (repositoryLease) =>
        s.leases.withWorkspace(
          workspaceId,
          'GIT_WORKBENCH',
          async (workspaceLease) => {
            const row = await s.store.assertAccessible(workspaceId, write),
              { git } = await source(workspaceId);
            if (write && git.ref_type !== 'branch')
              fail('GIT_REF_POLICY_INVALID');
            await assertWorkspaceJournalIsolation(
              s.store,
              s.roots,
              workspaceId,
            );
            await s.roots.requireReady(row, workspaceLease, true);
            const inspection = await s.git.inspect(workspaceId, workspaceLease);
            if (inspection.inventory.hash !== row.content_inventory_hash)
              fail('WORKSPACE_VERSION_CONFLICT');
            return s.git.withCommands(
              [repositoryLease, workspaceLease],
              {},
              (run) => action(row, git, [repositoryLease, workspaceLease], run),
            );
          },
        ),
    );
  };
  const status = async (row: WorkspaceRow, git: GitWorkspaceRow, run: Run) => {
    const root = s.roots.path(row),
      output = (
        await run(
          [
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
            '--ignore-submodules=all',
          ],
          root,
        )
      ).stdout;
    const parsed = parsePorcelain(output);
    const markers = parsed.changed_files.filter(
      (file) => file.path === OWNER_MARKER,
    );
    if (markers.some((file) => file.index !== '?' || file.worktree !== '?'))
      fail('WORKSPACE_RECOVERY_REQUIRED');
    parsed.untracked -= markers.length;
    parsed.changed_files = parsed.changed_files.filter(
      (file) => file.path !== OWNER_MARKER,
    );
    for (const file of parsed.changed_files) relativeWorkspacePath(file.path);
    // Recompute counts after excluding the platform-owned marker.
    const selected = parsed;
    const head = (
      await run(['rev-parse', '--verify', 'HEAD'], root)
    ).stdout.trim();
    const branch = await run(
      ['symbolic-ref', '-q', 'HEAD'],
      root,
      undefined,
      true,
    );
    const remoteRef = `refs/remotes/origin/${git.ref_name}`;
    const remote = await run(
      ['rev-parse', '--verify', remoteRef],
      root,
      undefined,
      true,
    );
    let ahead: number | null = null,
      behind: number | null = null;
    if (!remote.code) {
      const counts = (
        await run(
          ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`],
          root,
        )
      ).stdout
        .trim()
        .split(/\s+/)
        .map(Number);
      if (counts.length === 2 && counts.every(Number.isSafeInteger))
        [ahead, behind] = counts;
    }
    return {
      head,
      remote_branch: git.ref_type === 'branch' ? git.ref_name : null,
      clean: selected.changed_files.length === 0,
      detached: branch.code !== 0,
      staged: selected.staged,
      modified: selected.modified,
      untracked: selected.untracked,
      conflicted: selected.conflicted,
      ahead,
      behind,
      remote_missing: !!remote.code,
      changed_files: selected.changed_files,
      content_revision: row.content_revision,
    };
  };
  const mutate = async (
    call: ApiCall,
    kind: 'stage' | 'unstage' | 'commit' | 'push',
  ) => {
    const allowed =
      kind === 'commit'
        ? ['message', 'expected_content_revision']
        : kind === 'push'
        ? ['remote_branch', 'expected_content_revision']
        : ['paths', 'expected_content_revision'];
    const input = v.object(call.body, allowed, allowed),
      workspaceId = id(call.params),
      expected = v.number(input.expected_content_revision);
    return locked(workspaceId, true, async (row, git, _leases, run) => {
      if (row.content_revision !== expected) fail('WORKSPACE_VERSION_CONFLICT');
      const root = s.roots.path(row),
        before = await status(row, git, run);
      if (before.detached || before.conflicted) fail('GIT_REF_POLICY_INVALID');
      if (kind === 'stage' || kind === 'unstage') {
        const paths = v.strings(input.paths, 200);
        if (!paths.length) fail('INVALID_REQUEST', 400);
        const files = new WorkspaceFiles(root);
        for (const relative of paths) {
          relativeWorkspacePath(relative);
          await files.target(relative, true);
          const stat = await fs
            .lstat(path.join(root, relative))
            .catch((e: NodeJS.ErrnoException) => {
              if (e.code === 'ENOENT') return null;
              throw e;
            });
          if (
            stat &&
            (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          )
            fail('WORKSPACE_PATH_FORBIDDEN', 403);
        }
        await run(
          kind === 'stage'
            ? ['add', '-A', '--', ...paths]
            : ['restore', '--staged', '--', ...paths],
          root,
        );
      } else if (kind === 'commit') {
        const message = v.text(input.message, 8192);
        if (Buffer.byteLength(message) > 8192 || !message.trim())
          fail('INVALID_REQUEST', 400);
        if (!before.staged) fail('GIT_NOTHING_TO_COMMIT');
        const author = await identity(s);
        if (!author.name || !author.email) fail('GIT_IDENTITY_REQUIRED');
        const env = resources.environment(
          {
            remote: '',
            directory: '',
            secrets: [],
            cleanup: async () => undefined,
            env: {},
          },
          author,
        );
        // User identity is environment data; no command-line -c override bypass exists.
        await run(
          ['commit', '--no-gpg-sign', '--no-verify', '-m', message],
          root,
          env,
        );
      } else {
        const branch = v.text(input.remote_branch, 1024);
        validateWorkspaceRef('branch', branch);
        const repository = await resources.repository(git.repository_id),
          access = await resources.access(repository, 'push', workspaceId);
        try {
          const result = await run(
            [
              'push',
              '--porcelain',
              '--no-verify',
              '--',
              access.remote,
              `HEAD:refs/heads/${branch}`,
            ],
            root,
            resources.environment(access),
            true,
          );
          if (result.code) fail('GIT_PUSH_FAILED');
        } finally {
          await access.cleanup();
        }
      }
      await s.roots.requireOwned(row);
      const inventory = await scanWorkspace(root, 'GIT');
      if (inventory.hash !== row.content_inventory_hash)
        fail('WORKSPACE_RECOVERY_REQUIRED');
      const after = await status(row, git, run);
      await s.store.run(
        'UPDATE GitWorkspaces SET last_verified_commit=?,dirty_state=?,last_update_at=?,last_error_code=NULL WHERE workspace_id=?',
        [
          after.head,
          after.clean ? 'CLEAN' : 'DIRTY',
          new Date().toISOString(),
          workspaceId,
        ],
      );
      return {
        head: after.head,
        content_revision: row.content_revision,
        status: after,
      };
    });
  };
  return {
    'GET /system/git-identity': async () => identity(s),
    'GET /workspaces/:id/git/status': async ({ params, query }) => {
      v.object(query, ['path', 'offset', 'limit']);
      return locked(id(params), false, async (row, git, _leases, run) => {
        const result = await status(row, git, run),
          offset = v.integer(query.offset ?? 0, 0),
          limit = v.integer(query.limit ?? 200, 1, 1000);
        const relative =
          query.path === undefined ? '' : v.text(query.path, 4096, true);
        relativeWorkspacePath(relative, true);
        const selected = relative
          ? result.changed_files.filter(
              (file) =>
                file.path === relative || file.path.startsWith(relative + '/'),
            )
          : result.changed_files;
        return {
          ...result,
          changed_files: selected.slice(offset, offset + limit),
        };
      });
    },
    'GET /workspaces/:id/git/diff': async ({ params, query }) => {
      const input = v.object(query, ['path', 'staged'], ['path']),
        relative = v.text(input.path);
      relativeWorkspacePath(relative);
      const staged = v.queryBoolean(input.staged),
        maxBytes = 262144,
        maxLines = 4000;
      return locked(id(params), false, async (row, _git, _leases, run) => {
        const root = s.roots.path(row);
        await new WorkspaceFiles(root).target(relative, true);
        const result = await run(
          [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--ignore-submodules=all',
            ...(staged ? ['--cached'] : []),
            '--',
            relative,
          ],
          root,
        );
        const lines = result.stdout.split('\n'),
          selected = lines.slice(0, maxLines).join('\n');
        const bytes = Buffer.from(selected),
          truncated = bytes.length > maxBytes || lines.length > maxLines;
        return {
          path: relative,
          staged,
          text: bytes.subarray(0, maxBytes).toString('utf8'),
          truncated,
          content_revision: row.content_revision,
        };
      });
    },
    'POST /workspaces/:id/git/stage': (call) => mutate(call, 'stage'),
    'POST /workspaces/:id/git/unstage': (call) => mutate(call, 'unstage'),
    'POST /workspaces/:id/git/commit': (call) => mutate(call, 'commit'),
    'POST /workspaces/:id/git/push': (call) => mutate(call, 'push'),
    'POST /workspaces/:id/git/repair': async ({ params, body }) => {
      const input = v.object(body, ['expected_version'], ['expected_version']),
        workspaceId = id(params),
        { row } = await source(workspaceId);
      if (row.version !== v.number(input.expected_version))
        fail('WORKSPACE_VERSION_CONFLICT');
      if (!['ERROR', 'RECOVERY_REQUIRED'].includes(row.lifecycle_state))
        fail('WORKSPACE_NOT_READY');
      const op = (
        await s.store.all<OperationRow>(
          "SELECT * FROM WorkspaceOperations WHERE workspace_id=? AND operation_type='CREATE' AND status IN ('PENDING','RUNNING','RECOVERY_REQUIRED') ORDER BY submitted_at LIMIT 1",
          [workspaceId],
        )
      )[0];
      if (!op) fail('WORKSPACE_RECOVERY_REQUIRED');
      const recovered = await s.lifecycle.recover(workspaceId);
      return {
        workspace: await workspaceDto(s, recovered),
        operation: operationDto(await s.lifecycle.operation(op.id)),
      };
    },
    'PUT /system/git-identity': async ({ body }) => {
      const input = v.object(
        body,
        ['name', 'email', 'expected_version'],
        ['name', 'email', 'expected_version'],
      );
      const name = v.text(input.name, 255).trim(),
        email = v.text(input.email, 255).trim(),
        version = v.number(input.expected_version);
      if (
        !name ||
        /[\x00-\x1f\x7f<>]/.test(name) ||
        !/^\S+@\S+\.\S+$/.test(email) ||
        /[\x00-\x20\x7f<>]/.test(email)
      )
        fail('INVALID_REQUEST', 400);
      return s.leases.barrier.mutation(async () => {
        const lease = await RuntimeLease.acquire(
          new IdentityPaths(s.roots.dataRoot),
          1,
        );
        try {
          const old = await identity(s);
          if (old.version !== version) fail('WORKSPACE_VERSION_CONFLICT');
          const result = { name, email, version: version + 1 };
          await privateJson(
            path.join(
              await s.roots.directory('config', true),
              'git-identity.json',
            ),
            result,
          );
          return result;
        } finally {
          await lease.release();
        }
      });
    },
    'GET /workspaces/:id/sync-policy': async ({ params }) =>
      policyDto(await s.sync.policies.get(id(params))),
    'PUT /workspaces/:id/sync-policy': async ({ params, body }) => {
      const input = v.object(
        body,
        ['expected_version', 'enabled', 'mode', 'schedule'],
        ['expected_version', 'enabled', 'mode', 'schedule'],
      );
      const policy = {
        expected_version: v.number(input.expected_version),
        enabled: v.boolean(input.enabled),
        mode: v.choice(input.mode, ['MANUAL', 'SCHEDULED']),
        schedule: input.schedule,
      } as SyncPolicyWrite;
      return policyDto(await s.sync.policies.save(id(params), policy));
    },
    'POST /workspaces/:id/sync': async ({ params, body, idempotencyKey }) => {
      const input = v.object(
        body,
        ['expected_version', 'expected_policy_version'],
        ['expected_version', 'expected_policy_version'],
      );
      return syncDto(
        await s.sync.submit(id(params), {
          requestKey: v.text(idempotencyKey, 200),
          expectedVersion: v.number(input.expected_version),
          expectedPolicyVersion: v.number(input.expected_policy_version),
        }),
      );
    },
    'POST /workspaces/:id/sync/preview': async ({ params, body }) => {
      const input = v.object(
          body,
          ['expected_version', 'expected_policy_version'],
          ['expected_version', 'expected_policy_version'],
        ),
        workspaceId = id(params),
        { git } = await source(workspaceId);
      return s.leases.withRepository(
        git.repository_id,
        'SYNC_PREVIEW',
        (repoLease) =>
          s.leases.withWorkspace(workspaceId, 'SYNC_PREVIEW', async (lease) => {
            const row = await s.store.assertAccessible(workspaceId, true),
              policy = await s.sync.policies.get(workspaceId);
            if (row.version !== v.number(input.expected_version))
              fail('WORKSPACE_VERSION_CONFLICT');
            if (policy.version !== v.number(input.expected_policy_version))
              fail('SYNC_POLICY_VERSION_CONFLICT');
            const plan = await s.git.plan(workspaceId, repoLease, lease);
            return {
              workspace_id: workspaceId,
              source_generation: row.source_generation,
              content_revision: row.content_revision,
              current_commit: plan.before,
              target_commit: plan.target,
              policy_version: policy.version,
              readiness: plan.status === 'BLOCKED' ? 'BLOCKED' : 'READY',
              error_code: plan.diagnostic,
            };
          }),
      );
    },
    'GET /workspaces/:id/sync-history': async ({ params, query }) => {
      v.object(query, ['page', 'size']);
      await source(id(params));
      const { page, size } = v.pagination(query);
      const total = (
        await s.store.all<{ count: number }>(
          'SELECT COUNT(*) count FROM WorkspaceSyncRuns WHERE workspace_id=?',
          [id(params)],
        )
      )[0].count;
      return {
        items: (
          await s.store.all<SyncRunRow>(
            'SELECT * FROM WorkspaceSyncRuns WHERE workspace_id=? ORDER BY id DESC LIMIT ? OFFSET ?',
            [id(params), size, (page - 1) * size],
          )
        ).map(syncDto),
        page,
        size,
        total,
      };
    },
    'GET /workspaces/:id/sync-runs/:syncRunId': async ({ params }) =>
      syncDto(await scopedRun(params)),
    'GET /workspaces/:id/sync-runs/:syncRunId/log': async ({
      params,
      query,
    }) => {
      v.object(query, ['cursor', 'limit_bytes']);
      const row = await scopedRun(params);
      const cursor = v.integer(query.cursor ?? 0, 0),
        limit = v.integer(query.limit_bytes ?? 65536, 1, 262144);
      // S3 persists safe state diagnostics, never credential-bearing transport stderr.
      const buffer = Buffer.from(
        JSON.stringify({
          id: row.id,
          status: row.status,
          phase: row.phase,
          error_code: row.error_code,
        }) + '\n',
      );
      if (cursor > buffer.length) fail('INVALID_REQUEST', 400);
      const end = Math.min(buffer.length, cursor + limit);
      return {
        text: buffer.subarray(cursor, end).toString('utf8'),
        next_cursor: end < buffer.length ? String(end) : null,
        complete: !!row.finished_at,
        truncated: end < buffer.length,
      };
    },
    'POST /workspaces/:id/sync-runs/:syncRunId/cancel': async ({
      params,
      body,
    }) => {
      v.object(body ?? {}, []);
      return syncDto(await s.sync.cancel((await scopedRun(params)).id));
    },
    'GET /workspaces/:id/discovery': async ({ params }) =>
      s.discovery.policy(id(params)),
    'PUT /workspaces/:id/discovery': async ({ params, body }) => {
      const input = v.object(
        body,
        ['expected_version', 'enabled', 'includes', 'excludes', 'languages'],
        ['expected_version', 'enabled', 'includes', 'excludes', 'languages'],
      );
      return s.discovery.savePolicy(id(params), {
        expected_version: v.number(input.expected_version, 0),
        enabled: v.boolean(input.enabled),
        includes: v.strings(input.includes, 128),
        excludes: v.strings(input.excludes, 128),
        languages: v
          .strings(input.languages, 4)
          .map((language) =>
            v.choice(language, ['PYTHON', 'JAVASCRIPT', 'TYPESCRIPT', 'SHELL']),
          ),
      });
    },
    'POST /workspaces/:id/discovery/preview': async ({ params, body }) => {
      const input = v.object(
        body,
        ['expected_version', 'expected_content_revision'],
        ['expected_version', 'expected_content_revision'],
      );
      const result = await s.discovery.preview(id(params), {
        expected_version: v.number(input.expected_version),
        expected_content_revision: v.number(input.expected_content_revision),
      });
      if (result.diagnostics.some((diagnostic) => diagnostic.blocking)) {
        const diagnostics = result.diagnostics
          .slice(0, 32)
          .map((diagnostic) => {
            if (!/^[A-Z][A-Z0-9_]{1,95}$/.test(diagnostic.code))
              fail('DISCOVERY_RECONCILIATION_FAILED');
            if (diagnostic.path !== null)
              relativeWorkspacePath(diagnostic.path);
            return {
              code: diagnostic.code,
              path: diagnostic.path,
              blocking: diagnostic.blocking,
            };
          });
        throw Object.assign(
          new WorkspaceFoundationError('DISCOVERY_RECONCILIATION_FAILED', 409),
          {
            details: {
              reason: diagnostics.find((diagnostic) => diagnostic.blocking)!
                .code,
              diagnostics,
            },
          },
        );
      }
      return {
        preview_token: result.preview_token,
        workspace_id: result.workspace_id,
        source_generation: result.source_generation,
        content_revision: result.content_revision,
        commit: result.commit,
        policy_version: result.policy_version,
        expires_at: result.expires_at,
        actions: result.actions.map((action) => ({
          discovery_key: action.discovery_key,
          path: action.path,
          action: action.action,
        })),
      };
    },
    'POST /workspaces/:id/discovery/apply': async ({ params, body }) => {
      const input = v.object(
        body,
        ['preview_token', 'expected_version'],
        ['preview_token', 'expected_version'],
      );
      const result = await s.discovery.apply(id(params), {
        preview_token: v.text(input.preview_token, 8192),
        expected_version: v.number(input.expected_version),
      });
      return {
        policy_version: result.policy_version,
        created: result.created,
        updated: result.updated,
        retired: result.retired,
        ignored: result.ignored,
      };
    },
    'GET /workspaces/:id/discovery/suppressions': async ({ params, query }) => {
      v.object(query, ['page', 'size']);
      await source(id(params));
      const { page, size } = v.pagination(query);
      const total = (
        await s.store.all<{ count: number }>(
          'SELECT COUNT(*) count FROM WorkspaceDiscoverySuppressions WHERE workspace_id=?',
          [id(params)],
        )
      )[0].count;
      return {
        items: (
          await s.store.all<SuppressionDtoRow>(
            'SELECT workspace_id,discovery_key,reason,created_at FROM WorkspaceDiscoverySuppressions WHERE workspace_id=? ORDER BY discovery_key LIMIT ? OFFSET ?',
            [id(params), size, (page - 1) * size],
          )
        ).map(suppressionDto),
        page,
        size,
        total,
      };
    },
    'POST /workspaces/:id/discovery/suppressions': async ({ params, body }) => {
      const input = v.object(
        body,
        ['discovery_key', 'expected_policy_version', 'reason'],
        ['discovery_key', 'expected_policy_version'],
      );
      const row = await s.discovery.suppress(id(params), {
        discovery_key: v.hash(input.discovery_key),
        expected_policy_version: v.number(input.expected_policy_version, 0),
        ...(input.reason === undefined
          ? {}
          : { reason: v.text(input.reason, 255) }),
      });
      return suppressionDto(
        (
          await s.store.all<SuppressionDtoRow>(
            'SELECT workspace_id,discovery_key,reason,created_at FROM WorkspaceDiscoverySuppressions WHERE workspace_id=? AND discovery_key=?',
            [row.workspace_id, row.discovery_key],
          )
        )[0],
      );
    },
    'DELETE /workspaces/:id/discovery/suppressions/:discoveryKey': async ({
      params,
      body,
    }) => {
      const input = v.object(body, ['expected_version'], ['expected_version']);
      await s.discovery.unsuppress(id(params), {
        discovery_key: v.hash(params.discoveryKey),
        expected_policy_version: v.number(input.expected_version, 0),
      });
      return null;
    },
  };
}
