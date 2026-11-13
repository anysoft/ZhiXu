const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { assertOwnedInstance } = require('./fixture.cjs');
const { runV2Application } = require('../../../back/applicationV2/entry');
const {
  CandidateGitResources,
} = require('../../../back/applicationV2/repositoryResources');

(async () => {
  const [instanceRoot, remoteDev, remoteIno] = process.argv.slice(2);
  await assertOwnedInstance(instanceRoot);
  const remote = path.join(instanceRoot, 'controlled-remote'),
    remoteUrl = pathToFileURL(remote).href;
  const accessResolver = async (row) => {
    await assertOwnedInstance(instanceRoot);
    const stat = await fs.lstat(remote);
    assert.equal(row.remote_url, remoteUrl);
    assert.equal(await fs.realpath(remote), remote);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(String(stat.dev), remoteDev);
    assert.equal(String(stat.ino), remoteIno);
    assert.equal(stat.mode & 0o077, 0);
    return {
      remote: remoteUrl,
      directory: remote,
      secrets: [],
      cleanup: async () => {},
      env: {
        GIT_ALLOW_PROTOCOL: 'file',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    };
  };
  let stop, app;
  const stopping = new Promise((resolve) => {
    stop = resolve;
  });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.on('message', async (message) => {
    try {
      if (message?.command === 'STOP') {
        stop();
        return;
      }
      if (!app || message?.command !== 'FACTS')
        throw Error('ENTRY_WORKER_COMMAND_INVALID');
      const s = app.services;
      process.send({
        request_id: message.request_id,
        facts: {
          pid: process.pid,
          ready: app.ready,
          phases: app.phases,
          syncs: await s.store.all(
            'SELECT id,workspace_id,status,error_code,trigger_source,schedule_slot,after_commit FROM WorkspaceSyncRuns ORDER BY id',
          ),
          outboxes: await s.store.all(
            'SELECT id,workspace_id,sync_run_id,status,attempt_count FROM WorkspaceUpdateOutbox ORDER BY id',
          ),
          events: await s.store.all(
            'SELECT id,status,task_run_id,workspace_update_id FROM TriggerEvents ORDER BY id',
          ),
          runs: await s.store.all(
            'SELECT id,task_id,status,error_code,attempt_count,submission_key FROM TaskRuns ORDER BY id',
          ),
          workspace_free: message.workspace_id
            ? !(await s.leases.probeWorkspace(message.workspace_id)).busy
            : null,
        },
      });
    } catch (error) {
      process.send?.({
        request_id: message?.request_id,
        error_code: /^[A-Z][A-Z0-9_]+$/.test(
          error.error_code ?? error.code ?? '',
        )
          ? error.error_code ?? error.code
          : 'ENTRY_WORKER_FACTS_FAILED',
      });
    }
  });
  await runV2Application(
    {
      dataRoot: path.join(instanceRoot, 'data'),
      backupRoot: path.join(instanceRoot, 'backups'),
      projectRoot: path.resolve(__dirname, '../../..'),
      initialize: false,
      port: 0,
      git: { accessResolver },
      createGitResources: (services) =>
        new CandidateGitResources(services, {
          accessResolver,
          normalizeRemote: async (value) => {
            assert.equal(value, remoteUrl);
            await assertOwnedInstance(instanceRoot);
            return {
              remote_url: value,
              normalized_url: value,
              provider: 'generic',
              host: 'owned-fixture.invalid',
              path: 'entry/scripts',
              owner: 'entry',
              repository_name: 'scripts',
            };
          },
        }),
    },
    stopping,
    (current) => {
      app = current;
      process.send({
        type: 'READY',
        pid: process.pid,
        origin: current.origin,
        ready: current.ready,
        phases: current.phases,
      });
    },
  );
  process.disconnect();
})().catch((error) => {
  process.send?.({
    type: 'FAILED',
    error_code: /^[A-Z][A-Z0-9_]+$/.test(error.error_code ?? error.code ?? '')
      ? error.error_code ?? error.code
      : 'ENTRY_WORKER_FAILED',
  });
  process.exitCode = 1;
  process.disconnect?.();
});
