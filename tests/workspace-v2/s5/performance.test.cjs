const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { httpFixture, shellTask, until } = require('./http-support.cjs');

async function diskBytes(root) {
  let logical = 0;
  let allocated = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const child = await diskBytes(file);
      logical += child.logical;
      allocated += child.allocated;
    } else if (entry.isFile()) {
      const info = await fs.lstat(file);
      logical += info.size;
      allocated += info.blocks * 512;
    }
  }
  return { logical, allocated };
}

test(
  'S5 bounded compiled application workload measures real API latency, queue progress and process resources without invented SLOs',
  { timeout: 240000 },
  async function s5PerformanceQualification(t) {
    const f = await httpFixture(t, 'S5-PERFORMANCE');
    const samples = {},
      runs = [],
      workspaceIds = [],
      taskIds = [];
    let successes = 0,
      unexpectedErrors = 0,
      peakRss = process.memoryUsage().rss;
    const cpuBefore = process.cpuUsage(),
      started = performance.now();
    const fdDirectory =
      process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
    const fdBefore = (await fs.readdir(fdDirectory)).length;
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 50);
    t.after(() => clearInterval(sampler));
    async function measure(name, method, route, body, headers, expected = 200) {
      const at = performance.now();
      const result = await f.request(method, '/api' + route, body, headers);
      (samples[name] ??= []).push(performance.now() - at);
      if (result.status === expected) successes++;
      else unexpectedErrors++;
      assert.equal(
        result.status,
        expected,
        result.body?.error_code || 'UNEXPECTED_HTTP_STATUS',
      );
      return result;
    }
    for (let i = 0; i < 4; i++) {
      const created = await measure(
        'workspace_create',
        'POST',
        '/workspaces',
        { type: 'LOCAL', name: 'S5 measured ' + i },
        { 'Idempotency-Key': randomUUID() },
        202,
      );
      const id = created.body.data.workspace.id;
      workspaceIds.push(id);
      await measure('file_create', 'POST', `/workspaces/${id}/files`, {
        path: 'main.sh',
        content: 'sleep 0.2\nprintf S5_MEASURED_CHILD\\n\n',
        must_not_exist: true,
      });
      const task = await measure(
        'task_create',
        'POST',
        '/tasks',
        shellTask(id, 'S5 measured ' + i),
      );
      taskIds.push(task.body.data.id);
    }
    const workspaceId = workspaceIds[0];
    let file = await measure(
      'file_read',
      'GET',
      `/workspaces/${workspaceId}/files?path=main.sh`,
    );
    for (let i = 0; i < 20; i++) {
      const saved = await measure(
        'file_save',
        'PUT',
        `/workspaces/${workspaceId}/files`,
        {
          path: 'main.sh',
          content: 'sleep 0.2\nprintf S5_MEASURED_CHILD\\n\n# revision ' + i,
          expected_hash: file.body.data.hash,
        },
      );
      assert.ok(saved.body.data.hash);
      file = await measure(
        'file_read',
        'GET',
        `/workspaces/${workspaceId}/files?path=main.sh`,
      );
      await measure(
        'file_tree',
        'GET',
        `/workspaces/${workspaceId}/files/tree`,
      );
      await measure(
        'file_search',
        'GET',
        `/workspaces/${workspaceId}/search?query=main&limit=100`,
      );
    }
    // All definitions are read after edits, so the measured queue does not use a stale source pin.
    for (let i = 0; i < 8; i++) {
      const submitted = await measure(
        'task_submission',
        'POST',
        `/tasks/${taskIds[i % 4]}/run`,
        { wait_mode: 'WAIT' },
        { 'Idempotency-Key': 's5-measured-' + i },
        202,
      );
      runs.push(submitted.body.data.id);
    }
    const completed = [];
    for (const id of runs) {
      const observed = await until(
        () => f.request('GET', '/api/task-runs/' + id),
        (r) =>
          ['SUCCESS', 'FAILED', 'SKIPPED', 'CANCELLED', 'INTERRUPTED'].includes(
            r.body.data?.status,
          ),
        60000,
      );
      assert.equal(
        observed.body.data.status,
        'SUCCESS',
        observed.body.data.error_code,
      );
      completed.push(observed.body.data);
      const attempts = await f.request('GET', `/api/task-runs/${id}/attempts`);
      assert.equal(attempts.body.data.length, 1);
    }
    const backupAt = performance.now();
    const backup = await measure(
      'backup_submission',
      'POST',
      '/backups',
      {},
      undefined,
      202,
    );
    const operationId = backup.body.data.id;
    const operation = await until(
      () => f.request('GET', '/api/backups/operations/' + operationId),
      (r) => ['SUCCESS', 'FAILED'].includes(r.body.data?.status),
      90000,
    );
    assert.equal(
      operation.body.data.status,
      'SUCCESS',
      operation.body.data.error_code,
    );
    samples.backup_complete = [performance.now() - backupAt];
    const measurementRows = [];
    for (const [operation, values] of Object.entries(samples)) {
      const sorted = [...values].sort((a, b) => a - b);
      measurementRows.push({
        operation,
        unit: 'ms',
        samples: values,
        sample_count: sorted.length,
        p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
        p99: null,
        p99_reason: 'FEWER_THAN_100_SAMPLES_NO_TAIL_CLAIM',
      });
    }
    const cpu = process.cpuUsage(cpuBefore),
      disk = await diskBytes(f.h.root);
    const databaseFiles = await fs.readdir(
      path.join(f.app.options.dataRoot, 'db'),
    );
    const databaseSizes = [];
    for (const name of databaseFiles) {
      const info = await fs.lstat(
        path.join(f.app.options.dataRoot, 'db', name),
      );
      if (info.isFile())
        databaseSizes.push({
          kind: name.endsWith('-wal')
            ? 'WAL'
            : name.endsWith('-shm')
            ? 'SHM'
            : 'DATABASE_OR_LOCK',
          bytes: info.size,
        });
    }
    await f.h.record('S5-PERFORMANCE', {
      status: 'PASS',
      measurements: measurementRows,
      workload: {
        workspace_count: 4,
        task_count: 4,
        task_run_count: 8,
        file_save_count: 20,
        same_workspace_queue: true,
        different_workspace_concurrency_requested: true,
        runtime: 'FROZEN_SHELL',
        destructive_resource_pressure: false,
      },
      workspace_ids: workspaceIds,
      task_ids: taskIds,
      task_run_ids: runs,
      terminal_statuses: completed.map((run) => run.status),
      success_count: successes,
      unexpected_error_count: unexpectedErrors,
      success_rate: successes / (successes + unexpectedErrors),
      error_rate: unexpectedErrors / (successes + unexpectedErrors),
      resources: {
        measurement_scope:
          'APPLICATION_AND_TEST_CONTROLLER_PROCESS_NOT_CHILDREN',
        elapsed_ms: performance.now() - started,
        cpu_user_us: cpu.user,
        cpu_system_us: cpu.system,
        peak_sampled_rss_bytes: peakRss,
        sample_interval_ms: 50,
        fd_before: fdBefore,
        fd_after: (await fs.readdir(fdDirectory)).length,
        owned_disk_logical_bytes: disk.logical,
        owned_disk_allocated_bytes: disk.allocated,
        sqlite_sizes: databaseSizes,
        temporary_disk_peak: null,
        temporary_disk_peak_reason: 'NOT_CONTINUOUSLY_SAMPLED',
      },
      slo_policy: 'FUNCTIONAL_INVARIANTS_ONLY_NO_LATENCY_SLO_WAS_DEFINED',
    });
  },
);
