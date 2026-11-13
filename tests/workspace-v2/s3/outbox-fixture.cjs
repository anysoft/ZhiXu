const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createGitFixture } = require('./git-fixture.cjs');
const { TaskService } = require('../../../back/services/taskExecutionV2/task');
const {
  TaskExecutionService,
} = require('../../../back/services/taskExecutionV2/execution');
const {
  WorkspaceEnvironmentService,
} = require('../../../back/services/taskExecutionV2/environment');
const {
  WorkspaceGitUpdateOutbox,
  WorkspaceGitUpdateTriggers,
} = require('../../../back/services/gitWorkspaceV2/outbox');

async function createOutboxFixture(t, options = {}) {
  const started = performance.now();
  const helper = 'S3_OWNED_HELPER_' + randomUUID();
  const program = (version) =>
    'test "$(cat helper.txt)" = ' +
    "'" +
    helper +
    "'" +
    ' || exit 29; printf "S3_TASK_' +
    version +
    '\\n%s\\n" "$OUTBOX_SECRET"; printf "%s\\n" "$PLATFORM_TASK_RUN_ID" >> "$1"\n';
  const f = await createGitFixture(t, {
    caseId: options.caseId || 's3-outbox-' + randomUUID(),
    files: {
      'main.sh': program('INITIAL'),
      'helper.txt': helper,
      ...(options.files ?? {}),
    },
  });
  const record = f.scenario.record.bind(f.scenario);
  f.scenario.record = (id, details) =>
    record(id, {
      duration_ms: performance.now() - started,
      exit_code: 0,
      ...details,
    });
  const effects = path.join(f.scenario.transferRoot, 'actual-task-effects.txt');
  const tasks = new TaskService(f.store, f.roots, f.leases);
  let task = await tasks.create({
    name: 'actual GitUpdate target',
    enabled: true,
    arguments: [effects],
    source: {
      type: 'WORKSPACE_ENTRYPOINT',
      workspace_id: f.row.id,
      relative_entrypoint: 'main.sh',
      language: 'SHELL',
      cwd_mode: 'WORKSPACE_ROOT',
      cwd_relative_path: null,
    },
    execution: { concurrency: 'ALLOW', max_attempts: 1, timeout_seconds: 5 },
  });
  const secret = f.scenario.registerSecret('S3_OUTBOX_SECRET_' + randomUUID());
  task = await new WorkspaceEnvironmentService(
    f.store,
    f.roots,
    f.leases,
  ).replaceTaskVariables(task.task.id, task.task.version, [
    {
      name: 'OUTBOX_SECRET',
      value: secret,
      operation: 'SET',
      status: 'enabled',
      is_secret: true,
    },
  ]);
  const execution = f.track(
    new TaskExecutionService(f.store, f.roots, f.leases),
  );
  const outbox = new WorkspaceGitUpdateOutbox(
    f.store,
    f.roots,
    f.leases,
    execution,
    options.outbox,
  );
  const triggers = new WorkspaceGitUpdateTriggers(f.store, f.roots, f.leases);
  const createTrigger = async (input = {}) => {
    const current = await tasks.get(task.task.id);
    return triggers.create(task.task.id, current.task.version, {
      mode: 'ANY_CHANGE',
      ...input,
    });
  };
  const buildSync = async () => {
    const {
      GitWorkspaceSyncService,
    } = require('../../../back/services/gitWorkspaceV2/sync');
    const {
      GitWorkspaceDiscovery,
    } = require('../../../back/services/gitWorkspaceV2/discovery');
    const sync = f.track(
      new GitWorkspaceSyncService(
        f.store,
        f.roots,
        f.leases,
        f.gitAdapter,
        new GitWorkspaceDiscovery(f.store, f.roots, f.leases),
        outbox,
        options.sync ?? {},
      ),
    );
    await sync.policies.save(f.row.id, {
      expected_version: 1,
      enabled: true,
      mode: 'MANUAL',
      schedule: null,
    });
    return sync;
  };
  return {
    ...f,
    helper,
    program,
    effects,
    task,
    tasks,
    secret,
    execution,
    outbox,
    triggers,
    createTrigger,
    buildSync,
    async effectsLines() {
      return (
        await fs.readFile(effects, 'utf8').catch((error) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        })
      )
        .trim()
        .split('\n')
        .filter(Boolean);
    },
  };
}
module.exports = { createOutboxFixture };
