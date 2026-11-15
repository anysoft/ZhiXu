// S5 copy of the original S1.B safety assertions, using only explicit compiled artifacts.
const {
  artifactModule,
  candidateIdentity,
  releaseRoot,
} = require('./artifact-support.cjs');
// Private, retained S1.B qualification domains. No default app data or user roots.
const fs = require('node:fs/promises');
const { runtimeArtifactOptions } = require('../s5r-offline-options.cjs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const {
  projectRoot,
  schemaPath,
  git,
  seedRepository,
} = require('./linux-disaster-base.cjs');
const { WorkspaceStore } = artifactModule('services/workspaceV2/store');
const { WorkspaceRootResolver } = artifactModule('services/workspaceV2/roots');
const { WorkspaceLeaseService } = artifactModule('services/workspaceV2/lease');
const { PlatformBackupBarrier } = artifactModule('services/backup/barrier');
const { WorkspaceBackupService } = artifactModule(
  'services/workspaceV2/backup',
);
const { syncDirectory } = artifactModule('services/backup/files');
const MARKER = '.s5-linux-instance-owner.json';
const CASE_MARKER = '.s5-linux-case-owner.json';
const RUN_MARKER = '.s5-linux-run-owner.json';
const sha256 = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');
async function hashFile(file) {
  const h = crypto.createHash('sha256');
  const handle = await fs.open(
    file,
    require('node:fs').constants.O_RDONLY |
      require('node:fs').constants.O_NOFOLLOW,
  );
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1) throw Error('S1B_UNSAFE_HASH_INPUT');
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      h.update(chunk);
    return h.digest('hex');
  } finally {
    await handle.close();
  }
}
async function privateMarker(file, value) {
  const h = await fs.open(file, 'wx', 0o600);
  try {
    await h.writeFile(JSON.stringify(value, null, 2) + '\n');
    await h.sync();
  } finally {
    await h.close();
  }
  await syncDirectory(path.dirname(file));
}
async function ownedDirectory(root) {
  const st = await fs.lstat(root);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.mode & 0o077 ||
    (process.getuid && st.uid !== process.getuid()) ||
    (await fs.realpath(root)) !== root
  )
    throw Error('S1B_DIRECTORY_NOT_OWNED');
  return st;
}
async function marker(root, name) {
  const st = await ownedDirectory(root);
  const file = path.join(root, name);
  const meta = await fs.lstat(file);
  if (
    !meta.isFile() ||
    meta.isSymbolicLink() ||
    meta.nlink !== 1 ||
    meta.mode & 0o077 ||
    (process.getuid && meta.uid !== process.getuid())
  )
    throw Error('S1B_OWNER_MARKER_UNSAFE');
  const m = JSON.parse(await fs.readFile(file, 'utf8'));
  if (
    m.version !== 1 ||
    m.root !== root ||
    m.dev !== st.dev ||
    m.ino !== st.ino ||
    !/^[a-f0-9-]{36}$/.test(m.token)
  )
    throw Error('S1B_OWNER_MARKER_MISMATCH');
  return m;
}
async function allocateBase() {
  if (process.env.ZHIXU_S5_DISASTER_SANDBOX) {
    const base = process.env.ZHIXU_S5_DISASTER_SANDBOX;
    await marker(base, RUN_MARKER);
    return base;
  }
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), 's5-linux-run-'),
  );
  await fs.chmod(base, 0o700);
  const st = await fs.lstat(base);
  await privateMarker(path.join(base, RUN_MARKER), {
    version: 1,
    root: base,
    dev: st.dev,
    ino: st.ino,
    token: crypto.randomUUID(),
  });
  return base;
}
async function assertOwnedInstance(instanceRoot) {
  const m = await marker(instanceRoot, MARKER);
  if (
    path.dirname(instanceRoot) !== m.caseRoot ||
    !path.basename(instanceRoot).startsWith('instance-')
  )
    throw Error('S1B_INSTANCE_OUTSIDE_CASE');
  const c = await marker(m.caseRoot, CASE_MARKER);
  if (path.dirname(m.caseRoot) !== c.runRoot)
    throw Error('S1B_CASE_OUTSIDE_RUN');
  await marker(c.runRoot, RUN_MARKER);
  if (
    process.env.ZHIXU_S5_DISASTER_SANDBOX &&
    c.runRoot !== process.env.ZHIXU_S5_DISASTER_SANDBOX
  )
    throw Error('S1B_INSTANCE_OUTSIDE_CURRENT_RUN');
  return m;
}
// GNU make 4.4's jobserver FIFO is a transient build object, never a
// Workspace asset. Only the S5 metrics caller opts in to stat/count it.
async function measuredRuntimeJobserverFifo(root, file, initial) {
  if (!initial.isFIFO() || typeof process.getuid !== 'function' ||
      initial.uid !== process.getuid() || initial.nlink !== 1) return false;
  const relative = path.relative(root, file);
  if (!/^instance-[A-Za-z0-9_-]{1,80}\/data\/tmp\/runtime\/python\/operation-[1-9][0-9]*\/tmp\/GMfifo[0-9]+$/.test(relative.split(path.sep).join('/')))
    return false;
  const parts = relative.split(path.sep);
  try { await assertOwnedInstance(path.join(root, parts[0])); }
  catch { throw Error('S5_METRICS_RUNTIME_OWNER_REQUIRED'); }
  let current = root;
  for (const part of ['', ...parts.slice(0, -1)]) {
    if (part) current = path.join(current, part);
    const st = await fs.lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() ||
        (st.mode & 0o022) || await fs.realpath(current) !== current)
      return false;
  }
  const after = await fs.lstat(file);
  return after.isFIFO() && after.dev === initial.dev && after.ino === initial.ino &&
    after.uid === initial.uid && after.mode === initial.mode && after.nlink === 1;
}
async function treeUsage(root, { runtimeBuildMetrics = false } = {}) {
  let bytes = 0,
    files = 0,
    directories = 0,
    allocatedBytes = 0,
    temporaryFifos = 0;
  async function visit(p) {
    const st = await fs.lstat(p);
    if (runtimeBuildMetrics) allocatedBytes += st.blocks * 512;
    if (st.isSymbolicLink()) {
      bytes += st.size;
      files++;
      return;
    }
    if (st.isDirectory()) {
      directories++;
      for (const name of await fs.readdir(p)) await visit(path.join(p, name));
    } else {
      if (!st.isFile()) {
        if (!runtimeBuildMetrics || !(await measuredRuntimeJobserverFifo(root, p, st)))
          throw Error('S1B_UNKNOWN_SPECIAL_FILE');
        // lstat only: never open the FIFO or follow it. Its allocation and
        // object count still contribute to metrics and the byte budget.
        bytes += Math.max(st.size, st.blocks * 512);
        files++;
        temporaryFifos++;
        return;
      }
      bytes += st.size;
      files++;
    }
  }
  try {
    await visit(root);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return runtimeBuildMetrics
    ? { bytes, files, directories, allocated_bytes: allocatedBytes, temporary_fifo_count: temporaryFifos }
    : { bytes, files, directories };
}
async function createS1BFixture(
  t,
  { caseId = 'qualification', existingRoot } = {},
) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(caseId))
    throw Error('S1B_CASE_ID_INVALID');
  const base = await allocateBase();
  const root =
    existingRoot || (await fs.mkdtemp(path.join(base, caseId + '-')));
  if (existingRoot) {
    const prior = await marker(root, CASE_MARKER);
    if (prior.runRoot !== base || path.dirname(root) !== base)
      throw Error('S1B_RESUME_OUTSIDE_CURRENT_RUN');
  } else {
    await fs.chmod(root, 0o700);
    const st = await fs.lstat(root);
    await privateMarker(path.join(root, CASE_MARKER), {
      version: 1,
      root,
      runRoot: base,
      token: crypto.randomUUID(),
      dev: st.dev,
      ino: st.ino,
    });
  }
  const evidenceRoot = path.join(root, 'evidence'),
    transferRoot = path.join(root, 'transfer');
  if (existingRoot) {
    await ownedDirectory(evidenceRoot);
    await ownedDirectory(transferRoot);
  } else {
    await fs.mkdir(evidenceRoot, { mode: 0o700 });
    await fs.mkdir(transferRoot, { mode: 0o700 });
  }
  const instances = [],
    secrets = new Set();
  let sequence = (await fs.readdir(evidenceRoot)).length;
  const redact = (value) => {
    const text = JSON.stringify(value, (_k, v) =>
      typeof v === 'bigint' ? String(v) : v,
    );
    for (const secret of secrets)
      if (secret && text.includes(secret))
        throw Error('S1B_EVIDENCE_SECRET_REJECTED');
    return JSON.parse(text);
  };
  const sandbox = {
    root,
    runRoot: base,
    evidenceRoot,
    transferRoot,
    projectRoot,
    schemaPath,
    hashFile,
    treeUsage,
    registerSecret(value) {
      if (typeof value !== 'string' || value.length < 8)
        throw Error('S1B_SECRET_SENTINEL_INVALID');
      secrets.add(value);
      return value;
    },
    async record(id, details = {}) {
      if (!/^[A-Za-z0-9_-]{1,140}$/.test(id))
        throw Error('S1B_EVIDENCE_ID_INVALID');
      const facts = redact(details);
      const evidence = {
        case_id: id,
        recorded_at: new Date().toISOString(),
        environment: {
          os: process.platform,
          architecture: process.arch,
          node: process.version,
        },
        ...facts,
        candidate: candidateIdentity(),
      };
      const hash = sha256(JSON.stringify(evidence));
      const file = path.join(
        evidenceRoot,
        String(++sequence).padStart(3, '0') + '-' + id + '.json',
      );
      await privateMarker(file, { ...evidence, evidence_sha256: hash });
      return { file, evidence_sha256: hash };
    },
    async measure(label, action) {
      const start = performance.now(),
        before = await treeUsage(root, { runtimeBuildMetrics: true }),
        cpuBefore = process.cpuUsage(),
        fdBefore =
          process.platform === 'linux'
            ? (await fs.readdir('/proc/self/fd')).length
            : null;
      let peak = before.bytes,
        peakAllocated = before.allocated_bytes,
        peakFiles = before.files,
        peakFifos = before.temporary_fifo_count;
      let sampling = false;
      const timer = setInterval(() => {
        if (sampling) return;
        sampling = true;
        treeUsage(root, { runtimeBuildMetrics: true })
          .then((x) => {
            peak = Math.max(peak, x.bytes);
            peakAllocated = Math.max(peakAllocated, x.allocated_bytes);
            peakFiles = Math.max(peakFiles, x.files);
            peakFifos = Math.max(peakFifos, x.temporary_fifo_count);
          })
          .finally(() => {
            sampling = false;
          });
      }, 250);
      timer.unref();
      try {
        const result = await action();
        const after = await treeUsage(root, { runtimeBuildMetrics: true });
        peak = Math.max(peak, after.bytes);
        peakAllocated = Math.max(peakAllocated, after.allocated_bytes);
        peakFiles = Math.max(peakFiles, after.files);
        peakFifos = Math.max(peakFifos, after.temporary_fifo_count);
        await sandbox.record('metric-' + label, {
          status: 'PASS',
          duration_ms: performance.now() - start,
          before_disk: before,
          final_disk: after,
          sampled_peak_disk_bytes: peak,
          sampled_peak_allocated_bytes: peakAllocated,
          sampled_peak_file_count: peakFiles,
          sampled_peak_temporary_fifo_count: peakFifos,
          sample_interval_ms: 250,
          process_peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
          process_rss_bytes: process.memoryUsage().rss,
          controller_cpu_microseconds: process.cpuUsage(cpuBefore),
          controller_fd_before: fdBefore,
          controller_fd_after:
            process.platform === 'linux'
              ? (
                  await fs.readdir('/proc/self/fd')
                ).length
              : null,
          rss_scope:
            'actual controller Node process high-water mark; child-tree metrics belong to the external S5 runner',
        });
        return result;
      } finally {
        clearInterval(timer);
        while (sampling) await new Promise((r) => setTimeout(r, 5));
      }
    },
    async createInstance(name) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(name))
        throw Error('S5_INSTANCE_NAME_INVALID');
      const instanceRoot = path.join(root, 'instance-' + name);
      await fs.mkdir(instanceRoot, { mode: 0o700 });
      const identity = await fs.lstat(instanceRoot);
      await privateMarker(path.join(instanceRoot, MARKER), {
        version: 1,
        root: instanceRoot,
        caseRoot: root,
        token: crypto.randomUUID(),
        dev: identity.dev,
        ino: identity.ino,
      });
      const dataRoot = path.join(instanceRoot, 'data');
      const resources = [];
      let closed = false,
        session;
      const instance = {
        name,
        root: instanceRoot,
        dataRoot,
        runtimeRoot: path.join(dataRoot, 'runtime'),
        backupRoot: path.join(instanceRoot, 'backups'),
        controlRoot: dataRoot + '.platform-control',
        databasePath: path.join(dataRoot, 'db/database.sqlite'),
        dbPath: path.join(dataRoot, 'db/database.sqlite'),
        projectRoot,
        schemaPath,
        app: undefined,
        store: undefined,
        track(resource) {
          resources.push(resource);
          return resource;
        },
        async request(
          method,
          url,
          body,
          key,
          authenticated = true,
          extraHeaders = {},
        ) {
          if (authenticated && !session) await instance.authenticate();
          const response = await fetch(instance.app.origin + '/api' + url, {
            method,
            headers: {
              ...(body === undefined
                ? {}
                : { 'Content-Type': 'application/json' }),
              ...(method === 'GET' ? {} : { Origin: instance.app.origin }),
              ...(authenticated
                ? {
                    Authorization: 'Bearer ' + session.token,
                    'X-CSRF-Token': session.csrf,
                  }
                : {}),
              ...(key ? { 'Idempotency-Key': key } : {}),
              ...extraHeaders,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          const payload = await response.json();
          if (
            ![200, 202].includes(response.status) ||
            payload.code !== response.status
          ) {
            const error = Error('S5_LINUX_APPLICATION_HTTP_REJECTED');
            error.error_code =
              typeof payload.error_code === 'string'
                ? payload.error_code
                : 'S5_HTTP_REJECTED';
            error.http_status = response.status;
            throw error;
          }
          return payload.data;
        },
        async authenticate() {
          let password = instance.ownerPassword;
          if (!password) {
            const restored = await instance.store.all(
              "SELECT DISTINCT value FROM WorkspaceProfileVariables WHERE name='S1B_SECRET' AND is_secret=1 AND operation='SET'",
            );
            if (restored.length !== 1 || typeof restored[0].value !== 'string')
              throw Error('S5_RESTORED_OWNER_SECRET_REQUIRED');
            password = restored[0].value;
          }
          sandbox.registerSecret(password);
          const system = await instance.request(
            'GET',
            '/system',
            undefined,
            undefined,
            false,
          );
          if (!system.initialized)
            await instance.request(
              'POST',
              '/user/init',
              { username: 's5-owner', password },
              undefined,
              false,
              { 'X-CSRF-Token': system.csrf_token },
            );
          const login = await instance.request(
            'POST',
            '/user/login',
            { username: 's5-owner', password },
            undefined,
            false,
          );
          if (
            typeof login.token !== 'string' ||
            typeof login.csrf_token !== 'string'
          )
            throw Error('S5_REAL_PANEL_LOGIN_REQUIRED');
          sandbox.registerSecret(login.token);
          sandbox.registerSecret(login.csrf_token);
          session = { token: login.token, csrf: login.csrf_token };
        },
        async launchApplication(initialize) {
          const { V2Application } = artifactModule('applicationV2/application');
          instance.app = await V2Application.launch({
            runtimeArtifacts: runtimeArtifactOptions(),
            dataRoot,
            backupRoot: instance.backupRoot,
            projectRoot,
            artifactRoot: path.join(
              projectRoot,
              'static/build/applicationV2/contracts',
            ),
            frontendRoot: path.join(projectRoot, 'static/dist-v2'),
            initialize,
            background: true,
            host: '127.0.0.1',
            port: 0,
          });
          session = undefined;
          const services = instance.app.services;
          instance.store = services.store;
          instance.roots = services.roots;
          instance.leases = services.leases;
          instance.barrier = services.leases.barrier;
          const health = await instance.request(
            'GET',
            '/health',
            undefined,
            undefined,
            false,
          );
          if (
            health.mode !== 'v2' ||
            health.ready !== true ||
            !instance.app.localWrites
          )
            throw Error('S5_REAL_APP_ADMISSION_REQUIRED');
          await sandbox.record(
            'linux-app-' +
              name +
              (initialize ? '-initialize' : '-restored-restart'),
            {
              status: 'PASS',
              controller_pid: process.pid,
              http_status: 200,
              actual_application: true,
              actual_http: true,
              local_write_admission: true,
              phases: instance.app.phases,
              candidate: candidateIdentity(),
            },
          );
        },
        async waitRun(id, timeoutMs = 60000) {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const row = await instance.app.services.execution.get(id);
            if (
              [
                'SUCCESS',
                'FAILED',
                'SKIPPED',
                'CANCELLED',
                'INTERRUPTED',
                'RECOVERY_REQUIRED',
              ].includes(row.status)
            )
              return row;
            if (Date.now() > deadline) throw Error('S5_REAL_APP_RUN_DEADLINE');
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        },
        async useStore(restored) {
          await instance.store.close();
          if (restored !== instance.store) await restored.close();
          await instance.launchApplication(false);
          return instance.store;
        },
        async close() {
          if (closed) return;
          closed = true;
          if (instance.app) await instance.app.close();
          for (const resource of resources.reverse())
            if (resource && typeof resource.close === 'function')
              await resource.close();
          if (!instance.app) await instance.store?.close();
        },
      };
      instance.execution = {
        async submit(taskId, options = {}) {
          const submitted = await instance.request(
            'POST',
            '/tasks/' + taskId + '/run',
            { wait_mode: options.waitMode ?? 'WAIT' },
            options.submissionKey,
          );
          return instance.app.services.execution.get(submitted.id);
        },
        wait: (id, timeoutMs) => instance.waitRun(id, timeoutMs),
        attempts: (id) => instance.app.services.execution.attempts(id),
        logs: (id) => instance.app.services.execution.logs(id),
        get: (id) => instance.app.services.execution.get(id),
        recover: () => instance.app.services.execution.recover(),
        async cancel(id) {
          await instance.request('POST', '/task-runs/' + id + '/cancel', {});
          return instance.app.services.execution.get(id);
        },
      };
      instances.push(instance);
      await instance.launchApplication(true);
      if (name === 'B') {
        // Root replacement must run offline. Prove the real application closes its FD first.
        await instance.app.close();
        instance.app = undefined;
        instance.store = await WorkspaceStore.open(
          instance.databasePath,
          instance.dataRoot,
        );
        await sandbox.record('linux-B-offline-restore-admission', {
          status: 'PASS',
          controller_pid: process.pid,
          actual_application_closed: true,
          backend_owner_released_before_restore: true,
        });
      }
      return instance;
    },
    async safeDestroy(instance, { archivePath } = {}) {
      const proof = await assertOwnedInstance(instance.root);
      if (
        !archivePath ||
        !path.resolve(archivePath).startsWith(transferRoot + path.sep)
      )
        throw Error('S1B_INDEPENDENT_TRANSFER_REQUIRED');
      const archive = await fs.lstat(archivePath);
      if (
        !archive.isFile() ||
        archive.isSymbolicLink() ||
        archive.nlink !== 1 ||
        archive.size < 1 ||
        (await fs.realpath(archivePath)) !== archivePath
      )
        throw Error('S1B_TRANSFER_NOT_OWNED');
      const archiveHash = await hashFile(archivePath);
      await instance.close();
      const check = await WorkspaceStore.open(
        instance.databasePath,
        instance.dataRoot,
      );
      try {
        const backup = new WorkspaceBackupService(
          check,
          instance.roots,
          instance.leases,
          instance.backupRoot,
        );
        await backup.withCatalogLock(() =>
          backup.barrier.snapshot(
            () => backup.idle(),
            async () => {
              const active = await check.all(
                "SELECT id FROM TaskRuns WHERE status IN ('RESOLVING','RUNNING','RECOVERY_REQUIRED')",
              );
              const operations = await check.all(
                "SELECT id FROM RuntimeOperations WHERE status IN ('PENDING','RUNNING')",
              );
              if (active.length || operations.length)
                throw Error('S1B_ACTIVE_OWNER_PREVENTS_DESTRUCTION');
              for (const ws of await check.all(
                "SELECT id FROM Workspaces WHERE storage_state='PRESENT'",
              )) {
                // Admission EX is already held: prove the SAME Workspace inode
                // is free without recursively requesting mutation SH.
                const locks = await instance.roots.directory('.locks', true);
                const lease = await artifactModule(
                  'services/runtimeProcess',
                ).RuntimeLease.acquire(
                  {
                    lock: async () =>
                      path.join(locks, 'workspace-' + ws.id + '.lock'),
                  },
                  ws.id,
                );
                await lease.release();
              }
            },
            2000,
          ),
        );
      } finally {
        await check.close();
      }
      const before = await treeUsage(instance.root);
      const latest = await assertOwnedInstance(instance.root);
      if (
        JSON.stringify(latest) !== JSON.stringify(proof) ||
        archiveHash !== (await hashFile(archivePath))
      )
        throw Error('S1B_DESTROY_PROOF_CHANGED');
      if (
        instance.root === projectRoot ||
        instance.root === os.homedir() ||
        !instance.root.startsWith(root + path.sep)
      )
        throw Error('S1B_UNSAFE_DESTRUCTION');
      await fs.rm(instance.root, { recursive: true });
      await syncDirectory(root);
      for (const p of [
        instance.root,
        instance.dataRoot,
        instance.runtimeRoot,
        instance.controlRoot,
        instance.backupRoot,
      ]) {
        const exists = await fs.lstat(p).catch((e) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        });
        if (exists) throw Error('S1B_A_NOT_DESTROYED');
      }
      return sandbox.record('destroy-' + instance.name, {
        status: 'PASS',
        input:
          'owned isolated instance and independently authenticated portable archive',
        expected:
          'all instance/data/runtime/control/catalog/remote paths absent',
        actual: 'ABSENT',
        assertions: [
          'canonical sandbox and owner/dev/ino unchanged',
          'transfer regular single-link archive outside A',
          'closed services and actual exclusive platform/Workspace leases',
          'no active Run or Runtime operation',
          'all A paths absent',
        ],
        before_asset_usage: before,
        archive_sha256: archiveHash,
        owner_identity_sha256: sha256(JSON.stringify(proof)),
        exit_code: 0,
      });
    },
    async close() {
      for (const instance of instances.reverse()) await instance.close();
    },
  };
  if (!existingRoot)
    process.stdout.write('S5 retained scenario: ' + root + '\n');
  if (t) t.after(() => sandbox.close());
  return sandbox;
}
module.exports = {
  createS1BFixture,
  assertOwnedInstance,
  hashFile,
  treeUsage,
  sha256,
  privateMarker,
  allocateBase,
  projectRoot,
  schemaPath,
  git,
  seedRepository,
};
