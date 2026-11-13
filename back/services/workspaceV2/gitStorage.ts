import fs from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import config from '../../config';
import { RepositoryPathResolver } from '../../shared/workspacePaths';
import { WorkspaceGuard } from '../workspaceLocks';
import { inheritedLeaseFds } from '../backup/inheritedLeases';
import { openRegular, syncDirectory, writeAll } from '../backup/files';
import { randomUUID } from 'crypto';
import { fail, positiveId } from './errors';
import { OWNER_MARKER } from './inventory';
import { WorkspaceStore } from './store';
import { WorkspaceRootResolver } from './roots';
import { WorkspaceLeaseService } from './lease';
import type { GitWorkspaceRow, WorkspaceRow } from './types';

interface RepositoryRow {
  id: number;
  host: string | null;
  storage_state: string;
  storage_path: string | null;
}
export interface GitLease {
  readonly processLeaseFds: number[];
  assertHeld(): Promise<void>;
}
export interface GitWorkspaceInput {
  repositoryId: number;
  refType: 'branch' | 'tag' | 'commit';
  refName: string;
}
export interface GitWorkspaceSummary {
  repository_id: number;
  storage_key: string;
  ref_type: GitWorkspaceRow['ref_type'];
  ref_name: string;
  private_branch: string | null;
  resolved_commit: string;
  head: string;
  applied_commit: string | null;
  last_verified_commit: string | null;
  git_admin_key: string;
  dirty: boolean;
  porcelain: string;
}

export interface GitReclaimProof extends GitWorkspaceSummary {
  git_admin_device: number;
  git_admin_inode: number;
}

function commit(value: string) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))
    fail('WORKSPACE_RECOVERY_REQUIRED');
  return value;
}
export function validateWorkspaceRef(
  type: GitWorkspaceInput['refType'],
  name: string,
) {
  if (
    !['branch', 'tag', 'commit'].includes(type) ||
    !name ||
    name.startsWith('-') ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(name) ||
    name.includes('..') ||
    name.includes('@{') ||
    name.endsWith('/') ||
    name.includes('//')
  )
    fail('INVALID_REQUEST', 400);
  if (type === 'commit' && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(name))
    fail('INVALID_REQUEST', 400);
}

export function gitRepositoryKey(repo: RepositoryRow) {
  positiveId(repo.id);
  return `git/repository-${repo.id}.git`;
}

/** Existing POSIX supervisor retains inherited admission/repository/Workspace FDs. */
async function withGit<T>(
  cwd: string,
  leaseFds: number[],
  action: (
    run: (
      args: string[],
      at?: string,
      allowFailure?: boolean,
    ) => Promise<{ code: number; stdout: string }>,
  ) => Promise<T>,
): Promise<T> {
  const fds = [...new Set([...leaseFds, ...inheritedLeaseFds()])];
  const guard = new WorkspaceGuard(
    spawn(
      'python3',
      [
        '-I',
        '-S',
        path.join(config.rootPath, 'shell/git_workspace_lock.py'),
        '[]',
        JSON.stringify({
          owner_type: 'workspace-v2',
          operation: 'git-storage',
          inherited: fds.map((_, i) => i + 3),
        }),
      ],
      { stdio: ['pipe', 'pipe', 'pipe', ...fds] },
    ) as ChildProcessWithoutNullStreams,
  );
  try {
    const ready: unknown = await guard.receive();
    if (
      !ready ||
      typeof ready !== 'object' ||
      !('ready' in ready) ||
      ready.ready !== true
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
    return await action(async (args, at = cwd, allowFailure = false) => {
      const result = await guard.run(
        [
          '--no-optional-locks',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          ...args,
        ],
        at,
        {
          PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_ALLOW_PROTOCOL: 'file',
        },
        30000,
        'git',
        4 * 1024 * 1024,
      );
      if (result.code && !allowFailure) fail('WORKSPACE_RECOVERY_REQUIRED');
      return { code: result.code, stdout: result.stdout.trimEnd() };
    });
  } finally {
    await guard.release();
  }
}

async function readSmall(file: string) {
  const handle = await openRegular(file, false);
  try {
    if ((await handle.stat()).size > 65536) fail('WORKSPACE_RECOVERY_REQUIRED');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function replaceRegistration(file: string, content: string) {
  const handle = await openRegular(file, false);
  const before = await handle.stat();
  await handle.close();
  const temporary = file + '.workspace-v2-' + randomUUID();
  const output = await fs.open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await writeAll(output, Buffer.from(content));
    await output.chmod(before.mode & 0o777);
    await output.sync();
  } finally {
    await output.close();
  }
  try {
    const now = await fs.lstat(file);
    if (
      now.dev !== before.dev ||
      now.ino !== before.ino ||
      now.isSymbolicLink() ||
      now.nlink !== 1
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function repository(
  store: WorkspaceStore,
  dataRoot: string,
  id: number,
  relocated = false,
) {
  const rows = await store.all<RepositoryRow>(
    'SELECT id,host,storage_state,storage_path FROM Repositories WHERE id=?',
    [positiveId(id)],
  );
  if (!rows[0]) fail('REPOSITORY_NOT_FOUND', 404);
  if (rows[0].storage_state !== 'READY') fail('WORKSPACE_NOT_READY');
  const key = gitRepositoryKey(rows[0]);
  const bare = path.join(dataRoot, key);
  if (
    !relocated &&
    rows[0].storage_path &&
    path.resolve(rows[0].storage_path) !== bare
  )
    fail('WORKSPACE_RECOVERY_REQUIRED');
  const resolver = new RepositoryPathResolver(dataRoot);
  await resolver.assertSafe(bare);
  const stat = await fs.lstat(bare);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    fail('WORKSPACE_RECOVERY_REQUIRED');
  if (
    await fs
      .lstat(path.join(bare, 'objects/info/alternates'))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      })
  )
    fail('WORKSPACE_RECOVERY_REQUIRED');
  return { row: rows[0], key, bare, resolver };
}

async function safeConfiguration(
  bare: string,
  cwd: string,
  fds: number[],
  objectFailureCode = 'WORKSPACE_RECOVERY_REQUIRED',
) {
  await withGit(cwd, fds, async (run) => {
    const text = (
      await run([
        'config',
        '--file',
        path.join(bare, 'config'),
        '--no-includes',
        '--null',
        '--list',
      ])
    ).stdout;
    for (const item of text.split('\0').filter(Boolean)) {
      const key = item.split('\n')[0].toLowerCase();
      if (
        /^include(if)?\./.test(key) ||
        /^filter\..*\.(clean|smudge|process)$/.test(key) ||
        /^diff\..*\.(command|textconv)$/.test(key) ||
        [
          'core.worktree',
          'extensions.worktreeconfig',
          'diff.external',
          'core.alternaterefscommand',
        ].includes(key)
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
    }
    if (
      (await run(['--git-dir', bare, 'rev-parse', '--is-bare-repository']))
        .stdout !== 'true'
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
    const objects = await run(
      ['--git-dir', bare, 'fsck', '--full', '--strict'],
      undefined,
      true,
    );
    if (objects.code) fail(objectFailureCode);
  });
}

/** Verifies a copied root without dereferencing the previous host's absolute .git path. */
export async function inspectGitWorkspace(
  store: WorkspaceStore,
  dataRoot: string,
  row: WorkspaceRow,
  gitRow: GitWorkspaceRow,
  options: {
    repair: boolean;
    relocated?: boolean;
    rootOverride?: string;
    leaseFds?: number[];
  },
): Promise<GitWorkspaceSummary> {
  if (
    row.type !== 'GIT' ||
    gitRow.workspace_id !== row.id ||
    gitRow.workspace_type !== 'GIT'
  )
    fail('WORKSPACE_TYPE_INVALID');
  const roots = new WorkspaceRootResolver(dataRoot);
  const root = options.rootOverride ?? roots.path(row);
  // Marker identity is checked by the root owner. Copy/restore calls rebuildOwner
  // before this step; create's staging is protected by its separate stage proof.
  const { key, bare, resolver } = await repository(
    store,
    dataRoot,
    gitRow.repository_id,
    options.repair || options.relocated,
  );
  await resolver.assertSafe(root);
  await resolver.assertSafe(path.join(root, '.git'));
  await safeConfiguration(bare, dataRoot, options.leaseFds ?? []);
  const pointer = (await readSmall(path.join(root, '.git'))).trim();
  if (!/^gitdir: [^\r\n]+$/.test(pointer)) fail('WORKSPACE_RECOVERY_REQUIRED');
  const adminKey = path.basename(pointer.slice(8));
  if (
    !/^[A-Za-z0-9_.-]+$/.test(adminKey) ||
    adminKey === '.' ||
    adminKey === '..'
  )
    fail('WORKSPACE_RECOVERY_REQUIRED');
  const admin = path.join(bare, 'worktrees', adminKey);
  await resolver.assertSafe(admin);
  const adminStat = await fs.lstat(admin);
  if (!adminStat.isDirectory() || adminStat.isSymbolicLink())
    fail('WORKSPACE_RECOVERY_REQUIRED');
  const common = (await readSmall(path.join(admin, 'commondir'))).trim();
  if (path.resolve(admin, common) !== bare) fail('WORKSPACE_RECOVERY_REQUIRED');
  const headText = (await readSmall(path.join(admin, 'HEAD'))).trim();
  if (gitRow.ref_type === 'branch') {
    if (
      gitRow.private_branch !== `ws-${row.id}` ||
      headText !== `ref: refs/heads/${gitRow.private_branch}`
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
  } else if (
    gitRow.private_branch !== null ||
    commit(headText) !== gitRow.resolved_commit
  )
    fail('WORKSPACE_RECOVERY_REQUIRED');
  const backPointer = (await readSmall(path.join(admin, 'gitdir'))).trim();
  if (!options.repair && !options.relocated) {
    if (
      path.resolve(root, pointer.slice(8)) !== admin ||
      path.resolve(admin, backPointer) !== path.join(root, '.git')
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
  } else if (options.repair) {
    // The copied marker/row and private branch provide ownership. Only the safe
    // admin basename is used; the old absolute path is never followed.
    await replaceRegistration(
      path.join(root, '.git'),
      'gitdir: ' + path.relative(root, admin) + '\n',
    );
    await replaceRegistration(
      path.join(admin, 'gitdir'),
      path.join(root, '.git') + '\n',
    );
    await store.run('UPDATE Repositories SET storage_path=? WHERE id=?', [
      bare,
      gitRow.repository_id,
    ]);
  }
  return withGit(dataRoot, options.leaseFds ?? [], async (run) => {
    const explicit = ['--git-dir', admin, '--work-tree', root];
    const head = commit(
      (
        await run([...explicit, 'rev-parse', '--verify', 'HEAD'], root)
      ).stdout.trim(),
    );
    if (gitRow.ref_type !== 'branch' && head !== gitRow.resolved_commit)
      fail('WORKSPACE_RECOVERY_REQUIRED');
    const porcelain = (
      await run(
        [
          ...explicit,
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
        ],
        root,
      )
    ).stdout
      .split('\0')
      .filter((part) => part && part !== `?? ${OWNER_MARKER}`)
      .join('\0');
    return {
      repository_id: gitRow.repository_id,
      storage_key: key,
      ref_type: gitRow.ref_type,
      ref_name: gitRow.ref_name,
      private_branch: gitRow.private_branch,
      resolved_commit: gitRow.resolved_commit,
      head,
      applied_commit: gitRow.applied_commit,
      last_verified_commit: gitRow.last_verified_commit,
      git_admin_key: adminKey,
      dirty: porcelain.length > 0,
      porcelain,
    };
  });
}

/** Initial checkout ownership only: no fetch, sync scheduler, discovery or task wiring. */
export class GitWorkspaceStorageAdapter {
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly leases: WorkspaceLeaseService,
  ) {}

  async get(id: number) {
    const rows = await this.store.all<GitWorkspaceRow>(
      'SELECT * FROM GitWorkspaces WHERE workspace_id=?',
      [positiveId(id)],
    );
    if (!rows[0]) fail('WORKSPACE_TYPE_INVALID');
    return rows[0];
  }

  async prepare(row: WorkspaceRow, input: GitWorkspaceInput, lease: GitLease) {
    validateWorkspaceRef(input.refType, input.refName);
    await lease.assertHeld();
    const existing = await this.store.all<GitWorkspaceRow>(
      'SELECT * FROM GitWorkspaces WHERE workspace_id=?',
      [row.id],
    );
    if (existing[0]) {
      if (
        existing[0].repository_id !== input.repositoryId ||
        existing[0].ref_type !== input.refType ||
        existing[0].ref_name !== input.refName
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
      return existing[0];
    }
    const { bare } = await repository(
      this.store,
      this.roots.dataRoot,
      input.repositoryId,
    );
    await safeConfiguration(bare, this.roots.dataRoot, lease.processLeaseFds);
    const resolved = await withGit(
      this.roots.dataRoot,
      lease.processLeaseFds,
      async (run) => {
        const refs =
          input.refType === 'branch'
            ? [
                `refs/remotes/origin/${input.refName}`,
                `refs/heads/${input.refName}`,
              ]
            : [
                input.refType === 'tag'
                  ? `refs/tags/${input.refName}`
                  : input.refName,
              ];
        for (const ref of refs) {
          const result = await run(
            [
              '--git-dir',
              bare,
              'rev-parse',
              '--verify',
              '--end-of-options',
              `${ref}^{commit}`,
            ],
            undefined,
            true,
          );
          if (!result.code) return commit(result.stdout.trim());
        }
        fail('REF_NOT_FOUND', 404);
      },
    );
    await this.store.run(
      `INSERT INTO GitWorkspaces(workspace_id,repository_id,ref_type,ref_name,private_branch,resolved_commit)
      VALUES(?,?,?,?,?,?)`,
      [
        row.id,
        input.repositoryId,
        input.refType,
        input.refName,
        input.refType === 'branch' ? `ws-${row.id}` : null,
        resolved,
      ],
    );
    return this.get(row.id);
  }

  async populate(
    row: WorkspaceRow,
    gitRow: GitWorkspaceRow,
    target: string,
    lease: GitLease,
  ) {
    await lease.assertHeld();
    const { bare } = await repository(
      this.store,
      this.roots.dataRoot,
      gitRow.repository_id,
    );
    if (
      await fs
        .lstat(path.join(target, '.git'))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        })
    ) {
      const recovered = await inspectGitWorkspace(
        this.store,
        this.roots.dataRoot,
        row,
        gitRow,
        {
          repair: false,
          rootOverride: target,
          leaseFds: lease.processLeaseFds,
        },
      );
      if (recovered.head !== gitRow.resolved_commit || recovered.dirty)
        fail('WORKSPACE_RECOVERY_REQUIRED');
      return;
    }
    if ((await fs.readdir(target)).length) fail('WORKSPACE_RECOVERY_REQUIRED');
    await withGit(this.roots.dataRoot, lease.processLeaseFds, async (run) => {
      await run([
        '--git-dir',
        bare,
        'worktree',
        'add',
        ...(gitRow.private_branch
          ? ['-b', gitRow.private_branch]
          : ['--detach']),
        '--',
        target,
        gitRow.resolved_commit,
      ]);
    });
    const stat = await fs.lstat(target);
    await fs.chmod(target, stat.mode & 0o700);
  }

  async verify(row: WorkspaceRow, lease: GitLease, repair = false) {
    await lease.assertHeld();
    await this.roots.requireOwned(row);
    const gitRow = await this.get(row.id);
    return inspectGitWorkspace(this.store, this.roots.dataRoot, row, gitRow, {
      repair,
      leaseFds: lease.processLeaseFds,
    });
  }

  async reclaimProof(
    row: WorkspaceRow,
    lease: GitLease,
  ): Promise<GitReclaimProof> {
    const summary = await this.verify(row, lease);
    const { bare } = await repository(
      this.store,
      this.roots.dataRoot,
      summary.repository_id,
    );
    const stat = await fs.lstat(
      path.join(bare, 'worktrees', summary.git_admin_key),
    );
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail('WORKSPACE_RECOVERY_REQUIRED');
    return {
      ...summary,
      git_admin_device: stat.dev,
      git_admin_inode: stat.ino,
    };
  }

  async detach(row: WorkspaceRow, lease: GitLease, proof?: GitReclaimProof) {
    await lease.assertHeld();
    const gitRow = await this.get(row.id);
    const summary = proof ?? (await this.reclaimProof(row, lease));
    if (
      summary.repository_id !== gitRow.repository_id ||
      summary.private_branch !== gitRow.private_branch ||
      !/^[A-Za-z0-9_.-]+$/.test(summary.git_admin_key) ||
      ['.', '..'].includes(summary.git_admin_key)
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
    const { bare, resolver } = await repository(
      this.store,
      this.roots.dataRoot,
      gitRow.repository_id,
    );
    const admin = path.join(bare, 'worktrees', summary.git_admin_key);
    await resolver.assertSafe(path.dirname(admin));
    const adminStat = await fs
      .lstat(admin)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
    if (adminStat) {
      if (
        !adminStat.isDirectory() ||
        adminStat.isSymbolicLink() ||
        adminStat.dev !== summary.git_admin_device ||
        adminStat.ino !== summary.git_admin_inode ||
        (process.getuid && adminStat.uid !== process.getuid())
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
      // Only registered Git administrative names are owned by this adapter.
      // Unknown additions survive and force explicit recovery.
      const allowed = new Set([
        'HEAD',
        'index',
        'commondir',
        'gitdir',
        'ORIG_HEAD',
        'COMMIT_EDITMSG',
        'logs',
        'logs/HEAD',
        'locked',
        'refs',
      ]);
      const entries: {
        file: string;
        dev: number;
        ino: number;
        directory: boolean;
      }[] = [];
      const walk = async (relative = ''): Promise<void> => {
        for (const name of await fs.readdir(path.join(admin, relative))) {
          const key = relative ? `${relative}/${name}` : name;
          if (!allowed.has(key)) fail('WORKSPACE_RECOVERY_REQUIRED');
          const file = path.join(admin, key);
          const stat = await fs.lstat(file);
          if (
            stat.isSymbolicLink() ||
            (!stat.isFile() && !stat.isDirectory()) ||
            (stat.isFile() && stat.nlink !== 1) ||
            (process.getuid && stat.uid !== process.getuid())
          )
            fail('WORKSPACE_RECOVERY_REQUIRED');
          if (stat.isDirectory()) await walk(key);
          entries.push({
            file,
            dev: stat.dev,
            ino: stat.ino,
            directory: stat.isDirectory(),
          });
        }
      };
      await walk();
      // Source quarantine + durable admin identity allow idempotent continuation
      // after a process dies between removing the ref and removing admin files.
      await withGit(this.roots.dataRoot, lease.processLeaseFds, async (run) => {
        if (gitRow.private_branch) {
          const current = await run(
            [
              '--git-dir',
              bare,
              'rev-parse',
              '--verify',
              `refs/heads/${gitRow.private_branch}`,
            ],
            undefined,
            true,
          );
          if (!current.code) {
            if (commit(current.stdout.trim()) !== summary.head)
              fail('WORKSPACE_RECOVERY_REQUIRED');
            await run([
              '--git-dir',
              bare,
              'update-ref',
              '-d',
              `refs/heads/${gitRow.private_branch}`,
              summary.head,
            ]);
          }
        }
      });
      for (const entry of entries) {
        const stat = await fs.lstat(entry.file);
        if (
          stat.dev !== entry.dev ||
          stat.ino !== entry.ino ||
          stat.isSymbolicLink()
        )
          fail('WORKSPACE_RECOVERY_REQUIRED');
        if (entry.directory) await fs.rmdir(entry.file);
        else await fs.unlink(entry.file);
        await syncDirectory(path.dirname(entry.file));
      }
      const final = await fs.lstat(admin);
      if (
        final.dev !== summary.git_admin_device ||
        final.ino !== summary.git_admin_inode
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
      await fs.rmdir(admin);
      await syncDirectory(path.dirname(admin));
    }
  }
}

export interface GitRepositoryAssetProof {
  repository_id: number;
  storage_key: string;
  bare: string;
  device: number;
  inode: number;
}

/** Validates an independently owned bare asset even when no Workspace uses it. */
export async function verifyGitRepositoryAsset(
  store: WorkspaceStore,
  dataRoot: string,
  id: number,
  options: {
    relocated?: boolean;
    leaseFds?: number[];
    /** Candidate sync may distinguish corrupt/missing objects after the same ownership scan. */
    objectFailureCode?: 'MISSING_OBJECT';
  } = {},
): Promise<GitRepositoryAssetProof> {
  const asset = await repository(
    store,
    dataRoot,
    id,
    options.relocated ?? false,
  );
  const before = await fs.lstat(asset.bare);
  for (const name of ['HEAD', 'config']) {
    await readSmall(path.join(asset.bare, name));
  }
  for (const name of ['objects', 'refs']) {
    const stat = await fs.lstat(path.join(asset.bare, name));
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid())
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
  }
  let entries = 0;
  const deadline = Date.now() + 30000;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 128 || Date.now() > deadline)
      fail('WORKSPACE_RECOVERY_REQUIRED');
    for (const name of await fs.readdir(directory)) {
      if (++entries > 1_000_000 || Date.now() > deadline)
        fail('WORKSPACE_RECOVERY_REQUIRED');
      const file = path.join(directory, name);
      const stat = await fs.lstat(file);
      if (
        stat.isSymbolicLink() ||
        (!stat.isFile() && !stat.isDirectory()) ||
        (stat.isFile() && stat.nlink !== 1) ||
        (process.getuid && stat.uid !== process.getuid())
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
      if (stat.isDirectory()) await walk(file, depth + 1);
    }
  };
  await walk(asset.bare, 0);
  if (
    await fs
      .lstat(path.join(asset.bare, 'objects/info/http-alternates'))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      })
  )
    fail('WORKSPACE_RECOVERY_REQUIRED');
  await withGit(dataRoot, options.leaseFds ?? [], async (run) => {
    const configuration = (
      await run([
        'config',
        '--file',
        path.join(asset.bare, 'config'),
        '--no-includes',
        '--null',
        '--list',
      ])
    ).stdout;
    for (const item of configuration.split('\0').filter(Boolean)) {
      const key = item.split('\n')[0].toLowerCase();
      if (
        key === 'extensions.partialclone' ||
        /^remote\..*\.(promisor|partialclonefilter)$/.test(key)
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
    }
  });
  await safeConfiguration(
    asset.bare,
    dataRoot,
    options.leaseFds ?? [],
    options.objectFailureCode,
  );
  const after = await fs.lstat(asset.bare);
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino
  )
    fail('WORKSPACE_RECOVERY_REQUIRED');
  return {
    repository_id: id,
    storage_key: asset.key,
    bare: asset.bare,
    device: after.dev,
    inode: after.ino,
  };
}
