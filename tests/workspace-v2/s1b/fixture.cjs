// Private, retained S1.B qualification domains. No default app data or user roots.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const {
  createDatabase,
  projectRoot,
  schemaPath,
  git,
  seedRepository,
} = require('../fixture.cjs');
const { WorkspaceStore } = require('../../../back/services/workspaceV2/store');
const {
  WorkspaceRootResolver,
} = require('../../../back/services/workspaceV2/roots');
const {
  WorkspaceLeaseService,
} = require('../../../back/services/workspaceV2/lease');
const {
  PlatformBackupBarrier,
} = require('../../../back/services/backup/barrier');
const {
  WorkspaceBackupService,
} = require('../../../back/services/workspaceV2/backup');
const { syncDirectory } = require('../../../back/services/backup/files');
const MARKER = '.s1b-instance-owner.json';
const CASE_MARKER = '.s1b-case-owner.json';
const RUN_MARKER = '.s1b-run-owner.json';
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
  if (process.env.ZHIXU_S1B_SANDBOX) {
    const base = process.env.ZHIXU_S1B_SANDBOX;
    await marker(base, RUN_MARKER);
    return base;
  }
  const base = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), 'zhixu-s1b-'),
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
    process.env.ZHIXU_S1B_SANDBOX &&
    c.runRoot !== process.env.ZHIXU_S1B_SANDBOX
  )
    throw Error('S1B_INSTANCE_OUTSIDE_CURRENT_RUN');
  return m;
}
async function treeUsage(root) {
  let bytes = 0,
    files = 0,
    directories = 0;
  async function visit(p) {
    const st = await fs.lstat(p);
    if (st.isSymbolicLink()) {
      bytes += st.size;
      files++;
      return;
    }
    if (st.isDirectory()) {
      directories++;
      for (const name of await fs.readdir(p)) await visit(path.join(p, name));
    } else {
      if (!st.isFile()) throw Error('S1B_UNKNOWN_SPECIAL_FILE');
      bytes += st.size;
      files++;
    }
  }
  try {
    await visit(root);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { bytes, files, directories };
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
        before = await treeUsage(root);
      let peak = before.bytes;
      let sampling = false;
      const timer = setInterval(() => {
        if (sampling) return;
        sampling = true;
        treeUsage(root)
          .then((x) => {
            peak = Math.max(peak, x.bytes);
          })
          .finally(() => {
            sampling = false;
          });
      }, 250);
      timer.unref();
      try {
        const result = await action();
        const after = await treeUsage(root);
        peak = Math.max(peak, after.bytes);
        await sandbox.record('metric-' + label, {
          status: 'PASS',
          duration_ms: performance.now() - start,
          before_disk: before,
          final_disk: after,
          sampled_peak_disk_bytes: peak,
          sample_interval_ms: 250,
          process_peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
          rss_scope:
            'qualification Node process high-water mark; child tree measured separately by run.cjs',
        });
        return result;
      } finally {
        clearInterval(timer);
        while (sampling) await new Promise((r) => setTimeout(r, 5));
      }
    },
    async createInstance(name) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(name))
        throw Error('S1B_INSTANCE_NAME_INVALID');
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
      const databasePath = await createDatabase(dataRoot);
      const store = await WorkspaceStore.open(databasePath, dataRoot);
      const controlRoot = dataRoot + '.platform-control';
      await fs.mkdir(controlRoot, { mode: 0o700 });
      const barrier = new PlatformBackupBarrier(controlRoot);
      const resources = [];
      let closed = false;
      const instance = {
        name,
        root: instanceRoot,
        dataRoot,
        runtimeRoot: path.join(dataRoot, 'runtime'),
        backupRoot: path.join(instanceRoot, 'backups'),
        controlRoot,
        databasePath,
        dbPath: databasePath,
        projectRoot,
        schemaPath,
        store,
        barrier,
        roots: new WorkspaceRootResolver(dataRoot),
        leases: new WorkspaceLeaseService(dataRoot, barrier),
        track(resource) {
          resources.push(resource);
          return resource;
        },
        async useStore(restored) {
          instance.store = restored;
          return restored;
        },
        async close() {
          if (closed) return;
          closed = true;
          for (const resource of resources.reverse())
            if (resource && typeof resource.close === 'function')
              await resource.close();
          await instance.store.close();
        },
      };
      instances.push(instance);
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
                const lease =
                  await require('../../../back/services/runtimeProcess').RuntimeLease.acquire(
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
