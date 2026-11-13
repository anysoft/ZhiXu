import fs from 'fs/promises';
import path from 'path';
import { constants } from 'fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { WorkspaceStore } from '../workspaceV2/store';
import { WorkspaceRootResolver } from '../workspaceV2/roots';
import { WorkspaceLease, WorkspaceLeaseService } from '../workspaceV2/lease';
import { scanWorkspace, sameFileIdentity } from '../workspaceV2/inventory';
import { assertWorkspaceJournalIsolation } from '../workspaceV2/journals';
import { inspectGitWorkspace } from '../workspaceV2/gitStorage';
import { fail, positiveId, errorCode } from '../workspaceV2/errors';
import type {
  GitWorkspaceRow,
  Inventory,
  WorkspaceRow,
} from '../workspaceV2/types';
import {
  normalizedSource,
  TaskLanguage,
  loadTaskDefinition,
} from '../taskExecutionV2/task';
import { ManagedRuntimeAdapter } from '../taskExecutionV2/runtime';
import { TaskResourceResolver } from '../taskExecutionV2/resources';
import { WorkspaceRevisionReader } from '../taskExecutionV2/materialization';
import {
  taskLanguage,
  runtimeKind,
  taskSettings,
} from '../../shared/taskDefinition';
import {
  cronNext,
  relativeGlob,
  matchesGlob,
} from '../../shared/triggerDefinition';

export interface DiscoveryPolicy {
  workspace_id: number;
  enabled: boolean;
  includes: string[];
  excludes: string[];
  languages: TaskLanguage[];
  version: number;
  last_reconciled_at: string | null;
}
export interface DiscoveryPolicyWrite {
  expected_version: number;
  enabled: boolean;
  includes: string[];
  excludes: string[];
  languages: TaskLanguage[];
}
export interface DiscoveryPublication {
  source_generation: number;
  content_revision: number;
  inventory_hash: string;
  after_commit: string;
}
export interface DiscoveryDiagnostic {
  code: string;
  path: string | null;
  blocking: boolean;
}
interface DiscoveredEntry {
  key: string;
  path: string;
  language: TaskLanguage;
  name: string;
  schedule: string | null;
  checksum: string;
}
interface TaskCapture {
  id: number;
  version: number;
  name: string;
  enabled: number;
  origin: 'MANUAL' | 'DISCOVERED';
  discovered_workspace_id: number | null;
  discovery_key: string | null;
  discovery_definition: string | null;
  discovery_state: 'ACTIVE' | 'RETIRED';
  relative_entrypoint: string;
  language: TaskLanguage;
}
interface TriggerCapture {
  id: number;
  task_id: number;
  type: string;
  origin: 'USER' | 'DISCOVERY';
  enabled: number;
  version: number;
  discovery_key: string | null;
  expression: string | null;
  timezone: string | null;
  misfire_policy: string | null;
}
interface Suppression {
  workspace_id: number;
  discovery_key: string;
  relative_entrypoint: string;
  reason: string;
  version: number;
}
interface Capture {
  workspace: WorkspaceRow;
  policy: DiscoveryPolicy;
  tasks: TaskCapture[];
  triggers: TriggerCapture[];
  suppressions: Suppression[];
}
export interface DiscoveryAction {
  discovery_key: string;
  path: string;
  action: 'CREATE' | 'UPDATE' | 'RETIRE' | 'IGNORE' | 'PRESERVE_USER';
  task_id: number | null;
}
export interface DiscoveryPlan {
  workspaceId: number;
  policy: DiscoveryPolicy;
  publication: DiscoveryPublication;
  captured: Capture;
  fingerprint: string;
  files: DiscoveredEntry[];
  actions: DiscoveryAction[];
  diagnostics: DiscoveryDiagnostic[];
  inventory: Inventory;
  commit: string;
  syncRunId?: number;
  syncOwnerToken?: string;
}
export interface DiscoveryResult {
  policy_version: number;
  created: number;
  updated: number;
  retired: number;
  ignored: number;
  diagnostics: DiscoveryDiagnostic[];
}
const LANGUAGES: TaskLanguage[] = [
  'PYTHON',
  'JAVASCRIPT',
  'TYPESCRIPT',
  'SHELL',
];
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const discoveryKey = (relative: string) =>
  createHash('sha256').update(relative).digest('hex');
const ignored = new Set([
  '.git',
  'node_modules',
  '.platform',
  '.venv',
  'venv',
  '__pycache__',
  '.runtime',
  '.runtimes',
]);
function baseline(task: TaskCapture): Record<string, any> {
  try {
    const value = JSON.parse(task.discovery_definition || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value))
      fail('DISCOVERY_RECONCILIATION_FAILED');
    return value;
  } catch {
    fail('DISCOVERY_RECONCILIATION_FAILED');
  }
}
function fingerprint(capture: Capture) {
  return digest({
    workspace: [
      capture.workspace.id,
      capture.workspace.version,
      capture.workspace.source_generation,
      capture.workspace.content_revision,
      capture.workspace.content_inventory_hash,
    ],
    policy: capture.policy,
    tasks: capture.tasks,
    triggers: capture.triggers,
    suppressions: capture.suppressions,
  });
}

/** Discovery is a producer of the canonical candidate Task tables, never a second Task/Runner domain. */
class DiscoveryTaskAdapter {
  static async create(
    tx: WorkspaceStore,
    workspaceId: number,
    entry: DiscoveredEntry,
  ) {
    const source = normalizedSource({
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: workspaceId,
      relative_entrypoint: entry.path,
      language: entry.language,
      cwd_mode: 'ENTRYPOINT_DIR',
      cwd_relative_path: null,
    });
    const definition = {
      version: 1,
      relative_entrypoint: entry.path,
      name: entry.name,
      schedule: entry.schedule,
      language: entry.language,
      checksum: entry.checksum,
    };
    const result = await tx.run(
      "INSERT INTO Tasks(workspace_id,name,enabled,origin,discovered_workspace_id,discovery_key,discovery_definition,arguments) VALUES(?,?,0,'DISCOVERED',?,?,?,'[]')",
      [
        workspaceId,
        entry.name,
        workspaceId,
        entry.key,
        JSON.stringify(definition),
      ],
    );
    await tx.run(
      'INSERT INTO TaskSources(task_id,workspace_id,type,relative_entrypoint,language,cwd_mode,cwd_relative_path) VALUES(?,?,?,?,?,?,NULL)',
      [
        result.lastID,
        workspaceId,
        source.type,
        source.relative_entrypoint,
        source.language,
        source.cwd_mode,
      ],
    );
    const settings = taskSettings({});
    await tx.run(
      'INSERT INTO TaskExecutionSettings(task_id,timeout_seconds,max_attempts,initial_delay_seconds,backoff,concurrency,notification) VALUES(?,?,?,?,?,?,?)',
      [
        result.lastID,
        settings.timeout_seconds,
        settings.max_attempts,
        settings.initial_delay_seconds,
        settings.backoff,
        settings.concurrency,
        settings.notification,
      ],
    );
    return result.lastID;
  }
}

/** Internal fresh-v2 only. Preview reads source; transaction apply only edits owned DB metadata. */
export class GitWorkspaceDiscovery {
  private readonly tokenKey: Buffer;
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly leases: WorkspaceLeaseService,
    options: { tokenKey?: Buffer } = {},
  ) {
    if (store.dataRoot !== roots.dataRoot || store.dataRoot !== leases.dataRoot)
      fail('WORKSPACE_PATH_INVALID');
    this.tokenKey = options.tokenKey
      ? Buffer.from(options.tokenKey)
      : randomBytes(32);
    if (this.tokenKey.length < 32) fail('INVALID_REQUEST', 400);
  }
  private async workspace(id: number, ready = true) {
    const row = ready
      ? await this.store.assertAccessible(positiveId(id), true)
      : await this.store.workspace(positiveId(id));
    if (row.type !== 'GIT') fail('WORKSPACE_TYPE_UNSUPPORTED', 422);
    return row;
  }
  async policy(
    id: number,
    tx: WorkspaceStore = this.store,
  ): Promise<DiscoveryPolicy> {
    const ws = await tx.workspace(positiveId(id));
    if (ws.type !== 'GIT') fail('WORKSPACE_TYPE_UNSUPPORTED', 422);
    const row = (
      await tx.all<any>(
        'SELECT * FROM WorkspaceDiscoveryPolicies WHERE workspace_id=?',
        [id],
      )
    )[0];
    return row
      ? {
          workspace_id: id,
          enabled: !!row.enabled,
          includes: JSON.parse(row.includes),
          excludes: JSON.parse(row.excludes),
          languages: JSON.parse(row.languages),
          version: row.version,
          last_reconciled_at: row.last_reconciled_at,
        }
      : {
          workspace_id: id,
          enabled: false,
          includes: ['**/*'],
          excludes: [],
          languages: [...LANGUAGES],
          version: 0,
          last_reconciled_at: null,
        };
  }
  async savePolicy(id: number, input: DiscoveryPolicyWrite) {
    if (
      !input ||
      typeof input.enabled !== 'boolean' ||
      !Number.isSafeInteger(input.expected_version) ||
      input.expected_version < 0 ||
      !Array.isArray(input.includes) ||
      !input.includes.length ||
      !Array.isArray(input.excludes) ||
      input.includes.length + input.excludes.length > 128 ||
      !Array.isArray(input.languages) ||
      !input.languages.length ||
      input.languages.some((language) => !LANGUAGES.includes(language))
    )
      fail('DISCOVERY_POLICY_INVALID', 400);
    const includes = input.includes.map(relativeGlob),
      excludes = input.excludes.map(relativeGlob),
      languages = [...new Set(input.languages)];
    return this.leases.withWorkspace(id, 'DISCOVERY_POLICY', async () =>
      this.store.transaction(async (tx) => {
        await this.workspace(id);
        const current = await this.policy(id, tx);
        if (current.version !== input.expected_version)
          fail('DISCOVERY_VERSION_CONFLICT');
        await tx.run(
          'INSERT INTO WorkspaceDiscoveryPolicies(workspace_id,enabled,includes,excludes,languages,version) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET enabled=excluded.enabled,includes=excluded.includes,excludes=excluded.excludes,languages=excluded.languages,version=excluded.version',
          [
            id,
            input.enabled ? 1 : 0,
            JSON.stringify(includes),
            JSON.stringify(excludes),
            JSON.stringify(languages),
            current.version + 1,
          ],
        );
        return this.policy(id, tx);
      }),
    );
  }
  private async capture(
    id: number,
    tx: WorkspaceStore = this.store,
  ): Promise<Capture> {
    return {
      workspace: await tx.workspace(id),
      policy: await this.policy(id, tx),
      tasks: await tx.all<TaskCapture>(
        'SELECT t.id,t.version,t.name,t.enabled,t.origin,t.discovered_workspace_id,t.discovery_key,t.discovery_definition,t.discovery_state,s.relative_entrypoint,s.language FROM Tasks t JOIN TaskSources s ON s.task_id=t.id AND s.workspace_id=t.workspace_id WHERE t.workspace_id=? ORDER BY t.id',
        [id],
      ),
      triggers: await tx.all<TriggerCapture>(
        'SELECT tr.id,tr.task_id,tr.type,tr.origin,tr.enabled,tr.version,tr.discovery_key,c.expression,c.timezone,c.misfire_policy FROM TaskTriggers tr JOIN Tasks t ON t.id=tr.task_id LEFT JOIN CronTriggers c ON c.trigger_id=tr.id WHERE t.workspace_id=? ORDER BY tr.id',
        [id],
      ),
      suppressions: await tx.all<Suppression>(
        'SELECT workspace_id,discovery_key,relative_entrypoint,reason,version FROM WorkspaceDiscoverySuppressions WHERE workspace_id=? ORDER BY discovery_key',
        [id],
      ),
    };
  }
  private async scan(
    root: string,
    inventory: Inventory,
    policy: DiscoveryPolicy,
    duringDiscovery?: () => Promise<void>,
  ) {
    const files: DiscoveredEntry[] = [],
      diagnostics: DiscoveryDiagnostic[] = [];
    if (!policy.enabled) return { files, diagnostics };
    const deadline = Date.now() + 30000;
    let visited = 0;
    let observed = false;
    for (const item of inventory.entries) {
      if (Date.now() > deadline) fail('SOURCE_UNVERIFIED');
      if (++visited % 64 === 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
      if (
        item.kind !== 'file' ||
        item.path.split('/').some((part) => ignored.has(part))
      )
        continue;
      let language: TaskLanguage;
      try {
        language = taskLanguage(item.path);
      } catch {
        continue;
      }
      if (
        !policy.languages.includes(language) ||
        !policy.includes.some((glob) => matchesGlob(glob, item.path)) ||
        policy.excludes.some((glob) => matchesGlob(glob, item.path))
      )
        continue;
      const source = normalizedSource({
        type: 'WORKSPACE_ENTRYPOINT',
        workspace_id: policy.workspace_id,
        relative_entrypoint: item.path,
        language,
        cwd_mode: 'ENTRYPOINT_DIR',
        cwd_relative_path: null,
      });
      const filename = path.join(root, source.relative_entrypoint);
      const handle = await fs.open(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let text = '';
      try {
        const before = await handle.stat();
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          (process.getuid && before.uid !== process.getuid())
        )
          fail('WORKSPACE_PATH_FORBIDDEN');
        const buffer = Buffer.alloc(Math.min(65536, before.size));
        const read = await handle.read(buffer, 0, buffer.length, 0);
        text = buffer.subarray(0, read.bytesRead).toString('utf8');
        if (
          !sameFileIdentity(before, await handle.stat()) ||
          !sameFileIdentity(before, await fs.lstat(filename))
        )
          fail('SOURCE_UNVERIFIED');
      } finally {
        await handle.close();
      }
      if (!observed) {
        observed = true;
        await duringDiscovery?.();
      }
      const names = [
        ...text.matchAll(/^\s*(?:\/\/|#|\*)\s*name\s*:\s*([^\r\n]*)/gim),
      ].map((match) => match[1].trim());
      const schedules = [
        ...text.matchAll(/^\s*(?:\/\/|#|\*)\s*cron\s*:\s*([^\r\n]*)/gim),
      ].map((match) => match[1].trim());
      const name = names[0] ?? item.path,
        schedule = schedules[0] || null;
      if (
        names.length > 1 ||
        schedules.length > 1 ||
        !name ||
        name.length > 255 ||
        /[\x00-\x1f\x7f]/.test(name)
      )
        diagnostics.push({
          code: 'DISCOVERY_METADATA_INVALID',
          path: item.path,
          blocking: true,
        });
      if (schedule)
        try {
          cronNext(schedule, 'UTC', new Date());
        } catch {
          diagnostics.push({
            code: 'CRON_DEFINITION_INVALID',
            path: item.path,
            blocking: true,
          });
        }
      files.push({
        key: discoveryKey(item.path),
        path: item.path,
        language,
        name,
        schedule,
        checksum: item.sha256!,
      });
    }
    if (!observed) await duringDiscovery?.();
    return {
      files: files.sort((a, b) =>
        Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
      ),
      diagnostics,
    };
  }
  async prepareUnderLease(
    workspaceId: number,
    lease: WorkspaceLease,
    options: {
      syncRunId?: number;
      publication?: DiscoveryPublication;
      duringDiscovery?: () => Promise<void>;
    } = {},
  ): Promise<DiscoveryPlan> {
    if (lease.workspaceId !== positiveId(workspaceId))
      fail('WORKSPACE_LEASE_REQUIRED');
    await lease.assertHeld();
    const captured = await this.store.transaction(() =>
      this.capture(workspaceId),
    );
    const ws = captured.workspace;
    if (ws.type !== 'GIT') fail('WORKSPACE_TYPE_UNSUPPORTED', 422);
    let syncOwnerToken: string | undefined;
    if (options.syncRunId !== undefined) {
      const run = (
        await this.store.all<{
          workspace_id: number;
          source_generation: number;
          status: string;
          owner_token: string | null;
        }>(
          'SELECT workspace_id,source_generation,status,owner_token FROM WorkspaceSyncRuns WHERE id=?',
          [positiveId(options.syncRunId)],
        )
      )[0];
      if (
        !run ||
        run.workspace_id !== workspaceId ||
        run.source_generation !== ws.source_generation ||
        !['RUNNING', 'RECOVERY_REQUIRED'].includes(run.status) ||
        !run.owner_token ||
        ws.storage_state !== 'PRESENT' ||
        !['READY', 'RECOVERY_REQUIRED'].includes(ws.lifecycle_state)
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
      if (
        (
          await this.store.all(
            "SELECT id FROM WorkspaceOperations WHERE workspace_id=? AND status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED')",
            [workspaceId],
          )
        ).length
      )
        fail('WORKSPACE_BUSY');
      syncOwnerToken = run.owner_token;
    } else await this.workspace(workspaceId);
    const owned = await this.roots.requireOwned(ws);
    await assertWorkspaceJournalIsolation(this.store, this.roots, workspaceId);
    const inventory = await scanWorkspace(owned.root, 'GIT');
    const gitRow = (
      await this.store.all<GitWorkspaceRow>(
        'SELECT * FROM GitWorkspaces WHERE workspace_id=?',
        [workspaceId],
      )
    )[0];
    if (!gitRow) fail('WORKSPACE_TYPE_INVALID');
    const git = await inspectGitWorkspace(
      this.store,
      this.store.dataRoot,
      ws,
      gitRow,
      { repair: false, leaseFds: lease.processLeaseFds },
    );
    const publication = options.publication ?? {
      source_generation: ws.source_generation,
      content_revision: ws.content_revision,
      inventory_hash: ws.content_inventory_hash!,
      after_commit: gitRow.applied_commit || git.head,
    };
    if (
      publication.source_generation !== ws.source_generation ||
      !Number.isSafeInteger(publication.content_revision) ||
      publication.content_revision < ws.content_revision ||
      !/^[a-f0-9]{64}$/.test(publication.inventory_hash) ||
      publication.inventory_hash !== inventory.hash ||
      !/^[a-f0-9]{40,64}$/.test(publication.after_commit) ||
      (options.syncRunId !== undefined &&
        publication.after_commit !== git.head) ||
      (options.syncRunId === undefined &&
        (publication.content_revision !== ws.content_revision ||
          inventory.hash !== ws.content_inventory_hash))
    )
      fail('SOURCE_SUPERSEDED');
    const { files, diagnostics } = await this.scan(
      owned.root,
      inventory,
      captured.policy,
      options.duringDiscovery,
    );
    const actions: DiscoveryAction[] = [],
      byKey = new Map(
        captured.tasks
          .filter((task) => task.origin === 'DISCOVERED')
          .map((task) => [task.discovery_key!, task]),
      ),
      manual = new Map(
        captured.tasks
          .filter((task) => task.origin === 'MANUAL')
          .map((task) => [task.relative_entrypoint, task]),
      ),
      suppressed = new Map(
        captured.suppressions.map((item) => [item.discovery_key, item]),
      );
    const selected = new Set(files.map((file) => file.key));
    for (const task of byKey.values())
      if (
        task.discovered_workspace_id !== workspaceId ||
        task.discovery_key !== discoveryKey(task.relative_entrypoint)
      )
        diagnostics.push({
          code: 'DISCOVERY_IDENTITY_INVALID',
          path: task.relative_entrypoint,
          blocking: true,
        });
    const runtimeProofs = new Map<string, Promise<string | null>>();
    for (const file of files) {
      const old = byKey.get(file.key),
        user = manual.get(file.path),
        suppression = suppressed.get(file.key);
      let action: DiscoveryAction['action'];
      if (suppression) action = 'IGNORE';
      else if (!old && user) action = 'PRESERVE_USER';
      else if (!old) action = 'CREATE';
      else if (old.discovery_state === 'RETIRED') {
        action = 'PRESERVE_USER';
        diagnostics.push({
          code: 'SOURCE_RETURNED',
          path: file.path,
          blocking: false,
        });
      } else {
        const prior = baseline(old);
        action =
          prior.name !== file.name ||
          prior.schedule !== file.schedule ||
          prior.checksum !== file.checksum ||
          prior.language !== file.language
            ? 'UPDATE'
            : 'PRESERVE_USER';
      }
      actions.push({
        discovery_key: file.key,
        path: file.path,
        action,
        task_id: old?.id ?? user?.id ?? null,
      });
      if (action === 'IGNORE' || (!old && user)) continue;
      const kind = runtimeKind(file.language);
      const binding = old
        ? (
            await this.store.all<{
              kind: string;
              python_environment_id: number | null;
              node_environment_id: number | null;
            }>('SELECT * FROM TaskRuntimeBindings WHERE task_id=?', [old.id])
          )[0]
        : undefined;
      if (binding && binding.kind !== kind) {
        diagnostics.push({
          code: 'TASK_RUNTIME_KIND_MISMATCH',
          path: file.path,
          blocking: true,
        });
        continue;
      }
      const defaults = (
        await this.store.all<{
          python_environment_id: number | null;
          node_environment_id: number | null;
        }>(
          'SELECT * FROM WorkspaceRuntimeDefaults WHERE workspace_id=? AND kind=?',
          [workspaceId, kind],
        )
      )[0];
      const environmentId =
        kind === 'PYTHON'
          ? binding?.python_environment_id ??
            defaults?.python_environment_id ??
            null
          : kind === 'NODE'
          ? binding?.node_environment_id ??
            defaults?.node_environment_id ??
            null
          : null;
      const cacheKey = `${kind}:${environmentId}:${file.language}`;
      if (!runtimeProofs.has(cacheKey))
        runtimeProofs.set(
          cacheKey,
          new ManagedRuntimeAdapter(this.store)
            .inspect(kind, environmentId, file.language)
            .then(() => null)
            .catch((error) => errorCode(error)),
        );
      const unavailable = await runtimeProofs.get(cacheKey)!;
      if (unavailable)
        diagnostics.push({
          code: unavailable,
          path: file.path,
          blocking: false,
        });
    }
    if (captured.policy.enabled)
      for (const task of byKey.values())
        if (!selected.has(task.discovery_key!))
          actions.push({
            discovery_key: task.discovery_key!,
            path: task.relative_entrypoint,
            action: 'RETIRE',
            task_id: task.id,
          });
    await lease.assertHeld();
    if (
      (await scanWorkspace(owned.root, 'GIT')).hash !== inventory.hash ||
      (
        await inspectGitWorkspace(this.store, this.store.dataRoot, ws, gitRow, {
          repair: false,
          leaseFds: lease.processLeaseFds,
        })
      ).head !== git.head
    )
      fail('SOURCE_SUPERSEDED');
    return {
      workspaceId,
      policy: captured.policy,
      publication,
      captured,
      fingerprint: fingerprint(captured),
      files,
      actions,
      diagnostics,
      inventory,
      commit: git.head,
      syncRunId: options.syncRunId,
      syncOwnerToken,
    };
  }
  private sign(value: object) {
    const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
    return (
      encoded +
      '.' +
      createHmac('sha256', this.tokenKey).update(encoded).digest('base64url')
    );
  }
  private token(value: unknown): any {
    if (typeof value !== 'string' || value.length > 4096)
      fail('DISCOVERY_PREVIEW_STALE');
    const [encoded, signature, extra] = value.split('.');
    if (!encoded || !signature || extra) fail('DISCOVERY_PREVIEW_STALE');
    const expected = createHmac('sha256', this.tokenKey)
      .update(encoded)
      .digest();
    const actual = Buffer.from(signature, 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      fail('DISCOVERY_PREVIEW_STALE');
    try {
      const token = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8'),
      );
      if (
        !token ||
        token.version !== 1 ||
        !Number.isSafeInteger(token.expires) ||
        token.expires <= Date.now()
      )
        fail('DISCOVERY_PREVIEW_STALE');
      return token;
    } catch {
      fail('DISCOVERY_PREVIEW_STALE');
    }
  }
  async preview(
    workspaceId: number,
    expected?: { expected_version: number; expected_content_revision: number },
  ) {
    return this.leases.withWorkspace(
      workspaceId,
      'DISCOVERY_PREVIEW',
      async (lease) => {
        const plan = await this.prepareUnderLease(workspaceId, lease);
        if (
          expected &&
          (expected.expected_version !== plan.captured.workspace.version ||
            expected.expected_content_revision !==
              plan.captured.workspace.content_revision)
        )
          fail('SOURCE_SUPERSEDED');
        const expires = Date.now() + 300000;
        return {
          preview_token: this.sign({
            version: 1,
            workspaceId,
            workspaceVersion: plan.captured.workspace.version,
            sourceGeneration: plan.publication.source_generation,
            contentRevision: plan.publication.content_revision,
            inventoryHash: plan.publication.inventory_hash,
            commit: plan.commit,
            fingerprint: plan.fingerprint,
            expires,
          }),
          workspace_id: workspaceId,
          source_generation: plan.publication.source_generation,
          content_revision: plan.publication.content_revision,
          commit: plan.commit,
          policy_version: plan.policy.version,
          expires_at: new Date(expires).toISOString(),
          actions: plan.actions,
          diagnostics: plan.diagnostics,
        };
      },
    );
  }
  async apply(
    workspaceId: number,
    input: { preview_token: string; expected_version: number },
  ) {
    const token = this.token(input?.preview_token);
    if (token.workspaceId !== workspaceId) fail('DISCOVERY_PREVIEW_STALE');
    return this.leases.withWorkspace(
      workspaceId,
      'DISCOVERY_APPLY',
      async (lease) => {
        const plan = await this.prepareUnderLease(workspaceId, lease);
        if (
          token.sourceGeneration !== plan.publication.source_generation ||
          token.contentRevision !== plan.publication.content_revision ||
          token.inventoryHash !== plan.publication.inventory_hash ||
          token.commit !== plan.commit
        )
          fail('SOURCE_SUPERSEDED');
        if (
          input.expected_version !== plan.captured.workspace.version ||
          token.workspaceVersion !== plan.captured.workspace.version ||
          token.fingerprint !== plan.fingerprint
        )
          fail('DISCOVERY_PREVIEW_STALE');
        return this.store.transaction((tx) =>
          this.applyPlanInTransaction(tx, plan),
        );
      },
    );
  }
  private async cron(
    tx: WorkspaceStore,
    taskId: number,
    entry: DiscoveredEntry,
    previous?: TriggerCapture,
  ) {
    if (previous?.origin === 'USER') return;
    if (!entry.schedule) {
      if (previous)
        await tx.run(
          "DELETE FROM TaskTriggers WHERE id=? AND origin='DISCOVERY'",
          [previous.id],
        );
      return;
    }
    if (
      previous &&
      previous.expression === entry.schedule &&
      previous.timezone === 'UTC' &&
      previous.misfire_policy === 'SKIP'
    )
      return;
    let id = previous?.id;
    if (!id)
      id = (
        await tx.run(
          "INSERT INTO TaskTriggers(task_id,type,origin,enabled,discovery_key,createdAt,updatedAt) VALUES(?,'CRON','DISCOVERY',1,'source-cron',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
          [taskId],
        )
      ).lastID;
    else
      await tx.run(
        "UPDATE TaskTriggers SET version=version+1,updatedAt=CURRENT_TIMESTAMP WHERE id=? AND origin='DISCOVERY'",
        [id],
      );
    await tx.run(
      "INSERT INTO CronTriggers(trigger_id,expression,timezone,misfire_policy,next_fire_at,createdAt,updatedAt) VALUES(?,?,'UTC','SKIP',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(trigger_id) DO UPDATE SET expression=excluded.expression,timezone=excluded.timezone,misfire_policy=excluded.misfire_policy,next_fire_at=excluded.next_fire_at,updatedAt=CURRENT_TIMESTAMP",
      [
        id,
        entry.schedule,
        cronNext(entry.schedule, 'UTC', new Date()).toISOString(),
      ],
    );
  }
  private async retire(
    tx: WorkspaceStore,
    task: TaskCapture,
    publication: DiscoveryPublication,
    reason: string,
  ) {
    const definition = baseline(task);
    const retirement = {
      workspace_id: task.discovered_workspace_id,
      source_generation: publication.source_generation,
      content_revision: publication.content_revision,
      inventory_hash: publication.inventory_hash,
      after_commit: publication.after_commit,
      discovery_key: task.discovery_key,
      relative_entrypoint: task.relative_entrypoint,
      reason,
    };
    if (
      task.discovery_state !== 'RETIRED' ||
      task.enabled !== 0 ||
      JSON.stringify(definition.retirement) !== JSON.stringify(retirement)
    )
      await tx.run(
        "UPDATE Tasks SET enabled=0,discovery_state='RETIRED',discovery_definition=?,version=version+1,updatedAt=CURRENT_TIMESTAMP WHERE id=?",
        [JSON.stringify({ ...definition, retirement }), task.id],
      );
    await tx.run(
      "DELETE FROM TaskTriggers WHERE task_id=? AND origin='DISCOVERY' AND discovery_key='source-cron'",
      [task.id],
    );
    return task.discovery_state !== 'RETIRED';
  }
  /** Caller owns the same real Workspace EX lease; this method performs no filesystem or OS-lock operations. */
  async applyPlanInTransaction(
    tx: WorkspaceStore,
    plan: DiscoveryPlan,
  ): Promise<DiscoveryResult> {
    if (tx !== this.store || plan.workspaceId !== plan.captured.workspace.id)
      fail('DISCOVERY_PREVIEW_STALE');
    const current = await this.capture(plan.workspaceId, tx);
    if (
      current.workspace.source_generation !==
        plan.captured.workspace.source_generation ||
      current.workspace.content_revision !==
        plan.captured.workspace.content_revision ||
      current.workspace.content_inventory_hash !==
        plan.captured.workspace.content_inventory_hash
    )
      fail('SOURCE_SUPERSEDED');
    if (fingerprint(current) !== plan.fingerprint)
      fail('DISCOVERY_PREVIEW_STALE');
    if (plan.syncRunId !== undefined) {
      const run = (
        await tx.all<{
          owner_token: string;
          status: string;
          workspace_id: number;
        }>(
          'SELECT owner_token,status,workspace_id FROM WorkspaceSyncRuns WHERE id=?',
          [plan.syncRunId],
        )
      )[0];
      if (
        !run ||
        run.owner_token !== plan.syncOwnerToken ||
        run.workspace_id !== plan.workspaceId ||
        !['RUNNING', 'RECOVERY_REQUIRED'].includes(run.status)
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
    } else await this.workspace(plan.workspaceId);
    if (plan.diagnostics.some((diagnostic) => diagnostic.blocking))
      fail('DISCOVERY_RECONCILIATION_FAILED');
    const result: DiscoveryResult = {
      policy_version: plan.policy.version,
      created: 0,
      updated: 0,
      retired: 0,
      ignored: 0,
      diagnostics: plan.diagnostics,
    };
    const files = new Map(plan.files.map((file) => [file.key, file])),
      tasks = new Map(plan.captured.tasks.map((task) => [task.id, task])),
      triggers = new Map(
        plan.captured.triggers
          .filter((trigger) => trigger.discovery_key === 'source-cron')
          .map((trigger) => [trigger.task_id, trigger]),
      );
    for (const action of plan.actions) {
      const task = action.task_id ? tasks.get(action.task_id) : undefined,
        file = files.get(action.discovery_key);
      if (action.action === 'CREATE' && file) {
        const id = await DiscoveryTaskAdapter.create(
          tx,
          plan.workspaceId,
          file,
        );
        await this.cron(tx, id, file);
        result.created++;
      } else if (action.action === 'UPDATE' && task && file) {
        const definition = baseline(task);
        await tx.run(
          'UPDATE Tasks SET name=?,discovery_definition=?,version=version+1,updatedAt=CURRENT_TIMESTAMP WHERE id=?',
          [
            task.name === definition.name ? file.name : task.name,
            JSON.stringify({
              ...definition,
              version: 1,
              relative_entrypoint: file.path,
              name: file.name,
              schedule: file.schedule,
              language: file.language,
              checksum: file.checksum,
            }),
            task.id,
          ],
        );
        await this.cron(tx, task.id, file, triggers.get(task.id));
        result.updated++;
      } else if (action.action === 'RETIRE' && task) {
        if (
          await this.retire(
            tx,
            task,
            plan.publication,
            plan.inventory.entries.some(
              (entry) => entry.path === task.relative_entrypoint,
            )
              ? 'FILTERED_OUT'
              : 'SOURCE_MISSING',
          )
        )
          result.retired++;
      } else if (action.action === 'IGNORE') {
        if (
          task?.origin === 'DISCOVERED' &&
          (await this.retire(tx, task, plan.publication, 'USER_IGNORED'))
        )
          result.retired++;
        result.ignored++;
      }
    }
    if (plan.policy.version > 0)
      await tx.run(
        'UPDATE WorkspaceDiscoveryPolicies SET last_reconciled_at=?,last_result=? WHERE workspace_id=? AND version=?',
        [
          new Date().toISOString(),
          JSON.stringify(result),
          plan.workspaceId,
          plan.policy.version,
        ],
      );
    if (plan.syncRunId === undefined)
      await tx.run(
        'UPDATE GitWorkspaces SET last_verified_commit=? WHERE workspace_id=?',
        [plan.commit, plan.workspaceId],
      );
    return result;
  }
  async suppress(
    workspaceId: number,
    input: {
      discovery_key: string;
      expected_policy_version: number;
      reason?: string;
    },
  ) {
    if (
      !input ||
      !/^[a-f0-9]{64}$/.test(input.discovery_key) ||
      typeof (input.reason ?? 'USER_IGNORED') !== 'string' ||
      !(input.reason ?? 'USER_IGNORED').length ||
      (input.reason ?? 'USER_IGNORED').length > 255 ||
      /[\x00-\x1f\x7f]/.test(input.reason ?? 'USER_IGNORED')
    )
      fail('DISCOVERY_POLICY_INVALID', 400);
    return this.leases.withWorkspace(
      workspaceId,
      'DISCOVERY_SUPPRESS',
      async (lease) => {
        const plan = await this.prepareUnderLease(workspaceId, lease);
        if (plan.policy.version !== input.expected_policy_version)
          fail('DISCOVERY_VERSION_CONFLICT');
        const file = plan.files.find(
            (entry) => entry.key === input.discovery_key,
          ),
          task = plan.captured.tasks.find(
            (entry) =>
              entry.discovery_key === input.discovery_key &&
              entry.origin === 'DISCOVERED',
          );
        const relative = file?.path ?? task?.relative_entrypoint;
        if (!relative || discoveryKey(relative) !== input.discovery_key)
          fail('DISCOVERY_ENTRY_NOT_FOUND');
        return this.store.transaction(async (tx) => {
          if (
            fingerprint(await this.capture(workspaceId, tx)) !==
            plan.fingerprint
          )
            fail('DISCOVERY_PREVIEW_STALE');
          await tx.run(
            'INSERT INTO WorkspaceDiscoverySuppressions(workspace_id,discovery_key,relative_entrypoint,reason) VALUES(?,?,?,?) ON CONFLICT(workspace_id,discovery_key) DO UPDATE SET reason=excluded.reason,version=WorkspaceDiscoverySuppressions.version+1',
            [
              workspaceId,
              input.discovery_key,
              relative,
              input.reason ?? 'USER_IGNORED',
            ],
          );
          if (task)
            await this.retire(tx, task, plan.publication, 'USER_IGNORED');
          return (
            await tx.all<Suppression>(
              'SELECT * FROM WorkspaceDiscoverySuppressions WHERE workspace_id=? AND discovery_key=?',
              [workspaceId, input.discovery_key],
            )
          )[0];
        });
      },
    );
  }
  async unsuppress(
    workspaceId: number,
    input: { discovery_key: string; expected_policy_version: number },
  ) {
    if (!input || !/^[a-f0-9]{64}$/.test(input.discovery_key))
      fail('DISCOVERY_POLICY_INVALID', 400);
    return this.leases.withWorkspace(
      workspaceId,
      'DISCOVERY_UNSUPPRESS',
      async () =>
        this.store.transaction(async (tx) => {
          await this.workspace(workspaceId);
          if (
            (await this.policy(workspaceId, tx)).version !==
            input.expected_policy_version
          )
            fail('DISCOVERY_VERSION_CONFLICT');
          await tx.run(
            'DELETE FROM WorkspaceDiscoverySuppressions WHERE workspace_id=? AND discovery_key=?',
            [workspaceId, input.discovery_key],
          );
        }),
    );
  }
  async restoreRetired(taskId: number, expectedVersion: number) {
    const initial = await loadTaskDefinition(this.store, taskId);
    return this.leases.withWorkspace(
      initial.task.workspace_id,
      'DISCOVERY_RESTORE',
      async (lease) => {
        const plan = await this.prepareUnderLease(
          initial.task.workspace_id,
          lease,
        );
        const task = plan.captured.tasks.find((item) => item.id === taskId);
        if (!task || task.version !== expectedVersion)
          fail('TASK_VERSION_CONFLICT');
        if (
          task.origin !== 'DISCOVERED' ||
          task.discovery_state !== 'RETIRED' ||
          plan.captured.suppressions.some(
            (item) => item.discovery_key === task.discovery_key,
          )
        )
          fail('TASK_NOT_READY');
        const file = plan.files.find((item) => item.key === task.discovery_key);
        if (
          !file ||
          plan.diagnostics.some(
            (item) => item.blocking && item.path === file.path,
          )
        )
          fail('TASK_NOT_READY');
        const resources = new TaskResourceResolver(
          this.store,
          this.roots,
          this.leases,
        );
        // Ordinary execution correctly refuses RETIRED Tasks. Explicit restore
        // validates the same immutable resources without weakening that guard.
        const selected = await resources.definition(taskId);
        await new ManagedRuntimeAdapter(this.store).inspect(
          selected.runtime.kind,
          selected.runtime.environmentId,
          selected.source.language,
        );
        const revisions = new WorkspaceRevisionReader(this.store, this.roots);
        for (const config of selected.configs)
          await revisions.readRevision(config.revision);
        await this.store.transaction(async (tx) => {
          if (
            fingerprint(await this.capture(plan.workspaceId, tx)) !==
            plan.fingerprint
          )
            fail('DISCOVERY_PREVIEW_STALE');
          const definition: Record<string, unknown> = {
            ...baseline(task),
            version: 1,
            relative_entrypoint: file.path,
            name: file.name,
            schedule: file.schedule,
            language: file.language,
            checksum: file.checksum,
          };
          delete definition.retirement;
          await tx.run(
            "UPDATE Tasks SET discovery_state='ACTIVE',enabled=0,discovery_definition=?,version=version+1,updatedAt=CURRENT_TIMESTAMP WHERE id=?",
            [JSON.stringify(definition), taskId],
          );
          await this.cron(
            tx,
            taskId,
            file,
            plan.captured.triggers.find(
              (item) =>
                item.task_id === taskId && item.discovery_key === 'source-cron',
            ),
          );
        });
        return loadTaskDefinition(this.store, taskId);
      },
    );
  }
}
