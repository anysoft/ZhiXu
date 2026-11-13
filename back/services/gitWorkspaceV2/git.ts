import fs from 'fs/promises';
import path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import config from '../../config';
import type { GitCredential } from '../../data/gitCredential';
import GitCredentialResolver, {
  GitAccessContext,
} from '../gitCredentialResolver';
import { normalizeRepositoryUrl } from '../../shared/gitProvider';
import { WorkspaceGuard } from '../workspaceLocks';
import { WorkspaceStore } from '../workspaceV2/store';
import { WorkspaceRootResolver } from '../workspaceV2/roots';
import { WorkspaceLease } from '../workspaceV2/lease';
import {
  inspectGitWorkspace,
  verifyGitRepositoryAsset,
  validateWorkspaceRef,
} from '../workspaceV2/gitStorage';
import {
  scanWorkspace,
  relativeWorkspacePath,
  workspaceLimits,
  OWNER_MARKER,
} from '../workspaceV2/inventory';
import { openRegular } from '../backup/files';
import { inheritedLeaseFds } from '../backup/inheritedLeases';
import { errorCode, positiveId } from '../workspaceV2/errors';
import type {
  WorkspaceRow,
  GitWorkspaceRow,
  Inventory,
  FaultHook,
} from '../workspaceV2/types';

export interface GitRepositoryRow {
  id: number;
  remote_url: string;
  normalized_url: string;
  default_credential_id: number | null;
  storage_state: string;
  storage_path: string | null;
}
export interface WorkspaceGitProof {
  workspaceVersion: number;
  sourceGeneration: number;
  contentRevision: number;
  inventoryHash: string;
  rootKey: string;
  rootDevice: number;
  rootInode: number;
  rootOwnerToken: string;
  adminKey: string;
  adminDevice: number;
  adminInode: number;
  indexSha256: string;
  configurationSha256: string;
}
export interface WorkspaceGitInspection {
  workspaceId: number;
  repositoryId: number;
  head: string;
  before: string;
  indexSha: string;
  refType: GitWorkspaceRow['ref_type'];
  refName: string;
  privateBranch: string | null;
  inventory: Inventory;
  proof: WorkspaceGitProof;
}
export interface WorkspaceGitPlan {
  workspaceId: number;
  repositoryId: number;
  before: string;
  target: string;
  refType: GitWorkspaceRow['ref_type'];
  refName: string;
  diagnostic: string | null;
  changedPaths: string[];
  status: 'NO_CHANGE' | 'FF_READY' | 'BLOCKED';
  proof: WorkspaceGitProof;
}
export interface WorkspaceGitOptions {
  signal?: {
    readonly aborted: boolean;
    addEventListener?: (
      name: string,
      action: () => void,
      options?: { once: boolean },
    ) => void;
    removeEventListener?: (name: string, action: () => void) => void;
  };
  timeoutMs?: number;
}
export interface WorkspaceGitApplyOptions extends WorkspaceGitOptions {
  beforeMutation?: (plan: WorkspaceGitPlan) => Promise<void>;
  duringCheckout?: (plan: WorkspaceGitPlan) => Promise<void>;
  afterHEAD?: (actual: WorkspaceGitInspection) => Promise<void>;
}
export type WorkspaceGitAccessResolver = (
  repository: Readonly<GitRepositoryRow>,
) => Promise<GitAccessContext>;

/** Only safe reason codes escape this internal Git boundary. */
export class WorkspaceGitError extends Error {
  constructor(readonly error_code: string, readonly status = 409) {
    super(error_code);
    this.name = 'WorkspaceGitError';
  }
}
function stop(code: string, status = 409): never {
  throw new WorkspaceGitError(code, status);
}
const sha = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const objectId = (value: string) => {
  const result = value.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result)) stop('MISSING_OBJECT');
  return result;
};

/** Compose existing managed Git identity, credential and supervised-process algorithms. */
export class WorkspaceGitAdapter {
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    readonly options: {
      accessResolver?: WorkspaceGitAccessResolver;
      fault?: FaultHook;
    } = {},
  ) {
    if (store.dataRoot !== roots.dataRoot) stop('WORKSPACE_PATH_INVALID');
  }
  private async lease(
    lease: WorkspaceLease,
    kind: 'repository' | 'workspace',
    id: number,
  ) {
    positiveId(id);
    if (
      lease.workspaceId !== id ||
      lease.lockPath !==
        path.join(this.store.dataRoot, '.locks', `${kind}-${id}.lock`)
    )
      stop('WORKSPACE_LEASE_REQUIRED');
    await lease.assertHeld();
  }
  private localEnvironment(): NodeJS.ProcessEnv {
    return {
      PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ALLOW_PROTOCOL: 'file',
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_ATTR_NOSYSTEM: '1',
    };
  }
  /** Candidate API command adapters retain the same checked argv and FD supervisor. */
  withCommands<T>(
    leases: WorkspaceLease[],
    options: WorkspaceGitOptions,
    action: (
      run: (
        args: string[],
        cwd: string,
        environment?: NodeJS.ProcessEnv,
        allowFailure?: boolean,
      ) => Promise<{ code: number; stdout: string; stderr: string }>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.supervised(leases, options, action);
  }

  private async supervised<T>(
    leases: WorkspaceLease[],
    options: WorkspaceGitOptions,
    action: (
      run: (
        args: string[],
        cwd: string,
        environment?: NodeJS.ProcessEnv,
        allowFailure?: boolean,
      ) => Promise<{ code: number; stdout: string; stderr: string }>,
    ) => Promise<T>,
  ) {
    for (const lease of leases) await lease.assertHeld();
    if (options.signal?.aborted) stop('SYNC_CANCELLED');
    const fds = [
      ...new Set([
        ...leases.flatMap((lease) => lease.processLeaseFds),
        ...inheritedLeaseFds(),
      ]),
    ];
    const guard = new WorkspaceGuard(
      spawn(
        '/usr/bin/python3',
        [
          '-I',
          '-S',
          path.join(config.rootPath, 'shell/git_workspace_lock.py'),
          '[]',
          JSON.stringify({
            owner_type: 'workspace-v2',
            operation: 'git-sync',
            inherited: fds.map((_, index) => index + 3),
          }),
        ],
        { stdio: ['pipe', 'pipe', 'pipe', ...fds] },
      ) as ChildProcessWithoutNullStreams,
    );
    let closing: Promise<void> | undefined;
    const release = () => closing ?? (closing = guard.release());
    const cancel = () => {
      void release().catch(() => undefined);
    };
    try {
      const ready = await guard.receive();
      if (!ready?.ready) stop('GIT_SUPERVISOR_FAILED');
      options.signal?.addEventListener?.('abort', cancel, { once: true });
      if (options.signal?.aborted) stop('SYNC_CANCELLED');
      const timeout = options.timeoutMs ?? 300000;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 1800000)
        stop('SYNC_POLICY_INVALID');
      return await action(
        async (
          args,
          cwd,
          environment = this.localEnvironment(),
          allowFailure = false,
        ) => {
          if (options.signal?.aborted) stop('SYNC_CANCELLED');
          // This private command builder owns all command-line configuration.
          // Later arguments cannot weaken these checks with another -c value.
          if (
            args.some(
              (arg) =>
                arg.startsWith('-c') ||
                arg === '--config-env' ||
                arg.startsWith('--config-env='),
            )
          )
            stop('INVALID_GIT_ADMIN');
          let result;
          try {
            result = await guard.run(
              [
                '--no-optional-locks',
                '--literal-pathspecs',
                '-c',
                'core.hooksPath=/dev/null',
                '-c',
                'core.fsmonitor=false',
                '-c',
                'core.trustctime=true',
                '-c',
                'core.checkStat=default',
                '-c',
                'core.ignoreStat=false',
                '-c',
                'gc.auto=0',
                '-c',
                'maintenance.auto=false',
                ...args,
              ],
              cwd,
              environment,
              timeout,
              'git',
              4 * 1024 * 1024,
            );
          } catch {
            if (options.signal?.aborted) stop('SYNC_CANCELLED');
            stop('GIT_SUPERVISOR_FAILED');
          }
          if (options.signal?.aborted) stop('SYNC_CANCELLED');
          if (result.code === 124) stop('GIT_TIMEOUT', 504);
          if (result.code === 125 || result.truncated) stop('GIT_OUTPUT_LIMIT');
          if (result.code && !allowFailure) stop('GIT_OPERATION_FAILED');
          return result;
        },
      );
    } finally {
      options.signal?.removeEventListener?.('abort', cancel);
      await release();
    }
  }
  private async digest(file: string) {
    const handle = await openRegular(file, false);
    try {
      const before = await handle.stat(),
        hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false }))
        hash.update(chunk);
      const after = await handle.stat(),
        named = await fs.lstat(file);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        named.dev !== after.dev ||
        named.ino !== after.ino ||
        named.isSymbolicLink() ||
        after.nlink !== 1
      )
        stop('WORKSPACE_RECOVERY_REQUIRED');
      return hash.digest('hex');
    } finally {
      await handle.close();
    }
  }
  private async repository(id: number, lease: WorkspaceLease) {
    await this.lease(lease, 'repository', id);
    const row = (
      await this.store.all<GitRepositoryRow>(
        'SELECT * FROM Repositories WHERE id=?',
        [id],
      )
    )[0];
    if (!row) stop('REPOSITORY_NOT_FOUND', 404);
    try {
      const proof = await verifyGitRepositoryAsset(
        this.store,
        this.store.dataRoot,
        id,
        {
          leaseFds: lease.processLeaseFds,
          objectFailureCode: 'MISSING_OBJECT',
        },
      );
      return { row, ...proof };
    } catch (error) {
      if (errorCode(error) === 'MISSING_OBJECT') stop('MISSING_OBJECT');
      stop('INVALID_GIT_ADMIN');
    }
  }
  private async strictConfiguration(bare: string, lease: WorkspaceLease) {
    return this.supervised([lease], {}, async (run) => {
      const result = await run(
        [
          'config',
          '--file',
          path.join(bare, 'config'),
          '--no-includes',
          '--null',
          '--list',
        ],
        bare,
      );
      const entries = result.stdout
        .split('\0')
        .filter(Boolean)
        .map((value) => {
          const split = value.indexOf('\n');
          return {
            key: value.slice(0, split).toLowerCase(),
            value: value.slice(split + 1),
          };
        });
      for (const { key } of entries)
        if (
          /^include(?:if)?\./.test(key) ||
          /^url\./.test(key) ||
          /^credential\./.test(key) ||
          /^filter\..*\.(?:clean|smudge|process)$/.test(key) ||
          /^diff\..*\.(?:command|textconv)$/.test(key) ||
          /^remote\..*\.(?:uploadpack|receivepack|proxy|vcs|promisor|partialclonefilter)$/.test(
            key,
          ) ||
          /^http\./.test(key) ||
          [
            'core.sshcommand',
            'core.gitproxy',
            'core.alternaterefscommand',
            'diff.external',
            'extensions.partialclone',
            'extensions.worktreeconfig',
          ].includes(key)
        )
          stop('INVALID_GIT_ADMIN');
      return entries;
    });
  }
  private async access(
    repository: GitRepositoryRow,
  ): Promise<GitAccessContext> {
    if (this.options.accessResolver) {
      const access = await this.options.accessResolver(repository);
      if (access.remote !== repository.remote_url) {
        await access.cleanup();
        stop('INVALID_REMOTE');
      }
      return access;
    }
    let identity;
    try {
      identity = normalizeRepositoryUrl(repository.remote_url);
    } catch {
      stop('INVALID_REMOTE');
    }
    if (identity.normalized_url !== repository.normalized_url)
      stop('INVALID_REMOTE');
    let credential: GitCredential | null = null;
    let secret: { token?: string; private_key?: string; passphrase?: string } =
      {};
    if (repository.default_credential_id) {
      const row = (
        await this.store.all<GitCredential & { secret: string | null }>(
          'SELECT * FROM GitCredentials WHERE id=?',
          [repository.default_credential_id],
        )
      )[0];
      if (!row || row.status !== 'enabled') stop('AUTH_FAILED');
      credential = row;
      try {
        const parsed: unknown = JSON.parse(row.secret || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          stop('AUTH_FAILED');
        for (const [name, value] of Object.entries(parsed)) {
          if (
            !['token', 'private_key', 'passphrase'].includes(name) ||
            typeof value !== 'string' ||
            value.length > 1024 * 1024
          )
            stop('AUTH_FAILED');
          secret[name as keyof typeof secret] = value;
        }
      } catch {
        stop('AUTH_FAILED');
      }
    }
    try {
      return await new GitCredentialResolver().resolve(
        credential,
        secret,
        repository.remote_url,
      );
    } catch {
      stop('AUTH_FAILED');
    }
  }

  /** Fetch only the shared bare object/ref domain; no Workspace is touched. */
  async fetch(
    repositoryId: number,
    repositoryLease: WorkspaceLease,
    options: WorkspaceGitOptions = {},
  ) {
    const repository = await this.repository(repositoryId, repositoryLease);
    await this.strictConfiguration(repository.bare, repositoryLease);
    const access = await this.access(repository.row);
    try {
      const environment = this.localEnvironment();
      // The existing resolver owns credential helpers. Unrelated host loaders,
      // proxy settings and executable search paths are not inherited by Git.
      for (const [key, value] of Object.entries(access.env))
        if (/^(?:GIT_|SSH_ASKPASS|SSH_ASKPASS_REQUIRE|DISPLAY$)/.test(key))
          environment[key] = value;
      await this.supervised([repositoryLease], options, async (run) => {
        const operation = run(
          [
            '--git-dir',
            repository.bare,
            'fetch',
            '--atomic',
            '--prune',
            '--no-tags',
            '--no-recurse-submodules',
            '--no-write-fetch-head',
            '--',
            access.remote,
            '+refs/heads/*:refs/remotes/origin/*',
            '+refs/tags/*:refs/tags/*',
          ],
          repository.bare,
          environment,
          true,
        );
        try {
          await this.options.fault?.('DURING_FETCH', { repositoryId });
        } catch (error) {
          await operation.catch(() => undefined);
          throw error;
        }
        const result = await operation;
        if (result.code) {
          // Classify internally, and never expose transport output or credentials.
          if (
            /authentication failed|permission denied|could not read username|host key verification failed/i.test(
              result.stderr,
            )
          )
            stop('AUTH_FAILED');
          stop('FETCH_FAILED');
        }
      });
      await this.repository(repositoryId, repositoryLease);
      return { repositoryId };
    } finally {
      await access.cleanup();
    }
  }

  async verifyRef(
    repositoryId: number,
    refType: GitWorkspaceRow['ref_type'],
    refName: string,
    repositoryLease: WorkspaceLease,
  ) {
    try {
      validateWorkspaceRef(refType, refName);
    } catch {
      stop('INVALID_REF');
    }
    const repository = await this.repository(repositoryId, repositoryLease);
    await this.strictConfiguration(repository.bare, repositoryLease);
    return this.supervised([repositoryLease], {}, async (run) => {
      if (
        refType !== 'commit' &&
        (
          await run(
            [
              'check-ref-format',
              refType === 'branch'
                ? `refs/heads/${refName}`
                : `refs/tags/${refName}`,
            ],
            repository.bare,
            undefined,
            true,
          )
        ).code
      )
        stop('INVALID_REF');
      const ref =
        refType === 'branch'
          ? `refs/remotes/origin/${refName}`
          : refType === 'tag'
          ? `refs/tags/${refName}`
          : refName;
      const result = await run(
        [
          '--git-dir',
          repository.bare,
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${ref}^{commit}`,
        ],
        repository.bare,
        undefined,
        true,
      );
      if (result.code) stop('REF_NOT_FOUND');
      return objectId(result.stdout);
    });
  }

  /** Read-only physical proof. Recovery callers may inspect a fenced Workspace. */
  async inspect(
    workspaceId: number,
    workspaceLease: WorkspaceLease,
  ): Promise<WorkspaceGitInspection> {
    await this.lease(workspaceLease, 'workspace', workspaceId);
    const row = await this.store.workspace(workspaceId);
    const gitRow = (
      await this.store.all<GitWorkspaceRow>(
        'SELECT * FROM GitWorkspaces WHERE workspace_id=?',
        [workspaceId],
      )
    )[0];
    if (row.type !== 'GIT' || !gitRow) stop('WORKSPACE_TYPE_INVALID');
    if (row.storage_state !== 'PRESENT') stop('WORKSPACE_NOT_READY');
    const owned = await this.roots.requireOwned(row),
      root = this.roots.path(row);
    let asset, summary;
    try {
      asset = await verifyGitRepositoryAsset(
        this.store,
        this.store.dataRoot,
        gitRow.repository_id,
        {
          leaseFds: workspaceLease.processLeaseFds,
          objectFailureCode: 'MISSING_OBJECT',
        },
      );
      await this.strictConfiguration(asset.bare, workspaceLease);
      summary = await inspectGitWorkspace(
        this.store,
        this.store.dataRoot,
        row,
        gitRow,
        { repair: false, leaseFds: workspaceLease.processLeaseFds },
      );
    } catch (error) {
      if (errorCode(error) === 'MISSING_OBJECT') stop('MISSING_OBJECT');
      stop('INVALID_GIT_ADMIN');
    }
    const admin = path.join(asset.bare, 'worktrees', summary.git_admin_key),
      adminStat = await fs.lstat(admin);
    const inventory = await scanWorkspace(root, 'GIT');
    const indexSha256 = await this.digest(path.join(admin, 'index'));
    const configurationSha256 = await this.digest(
      path.join(asset.bare, 'config'),
    );
    await workspaceLease.assertHeld();
    await this.roots.requireOwned(row);
    return {
      workspaceId,
      repositoryId: gitRow.repository_id,
      head: summary.head,
      before: summary.head,
      indexSha: indexSha256,
      refType: gitRow.ref_type,
      refName: gitRow.ref_name,
      privateBranch: gitRow.private_branch,
      inventory,
      proof: {
        workspaceVersion: row.version,
        sourceGeneration: row.source_generation,
        contentRevision: row.content_revision,
        inventoryHash: inventory.hash,
        rootKey: row.root_key,
        rootDevice: owned.identity.dev,
        rootInode: owned.identity.ino,
        rootOwnerToken: owned.identity.owner_token,
        adminKey: summary.git_admin_key,
        adminDevice: adminStat.dev,
        adminInode: adminStat.ino,
        indexSha256,
        configurationSha256,
      },
    };
  }

  private async targetTree(
    target: string,
    bare: string,
    leases: WorkspaceLease[],
  ) {
    return this.supervised(leases, {}, async (run) => {
      const result = await run(
        ['--git-dir', bare, 'ls-tree', '-r', '-l', '-z', target],
        bare,
      );
      const limits = workspaceLimits(),
        paths: string[] = [],
        directories = new Set<string>(),
        portableComponents = new Map<string, string>();
      let bytes = 0;
      for (const record of result.stdout.split('\0').filter(Boolean)) {
        const match = /^(\d{6}) (\w+) ([a-f0-9]+) +(\d+|-)\t([\s\S]+)$/.exec(
          record,
        );
        if (
          !match ||
          !['100644', '100755'].includes(match[1]) ||
          match[2] !== 'blob'
        )
          stop('UNSAFE_TARGET_TREE');
        const name = match[5];
        try {
          relativeWorkspacePath(name);
        } catch {
          stop('UNSAFE_TARGET_TREE');
        }
        if (
          Buffer.byteLength(name) > limits.maxRelativePathBytes ||
          name.split('/').length > limits.maxDirectoryDepth
        )
          stop('WORKSPACE_QUOTA_EXCEEDED');
        const size = Number(match[4]);
        if (!Number.isSafeInteger(size) || size > limits.maxSourceFileBytes)
          stop('WORKSPACE_FILE_TOO_LARGE');
        bytes += size;
        const parts = name.split('/');
        // A valid Git tree can contain aliases that the checkout filesystem
        // stores as one name. Compare every prefix so directory aliases and
        // file/directory ancestors are rejected as well as complete filenames.
        for (let index = 1; index <= parts.length; index++) {
          const exact = parts.slice(0, index).join('/');
          const portable = exact
            .normalize('NFD')
            .toUpperCase()
            .toLowerCase()
            .normalize('NFD');
          const previous = portableComponents.get(portable);
          if (previous !== undefined && previous !== exact)
            stop('UNSAFE_TARGET_TREE');
          portableComponents.set(portable, exact);
        }
        for (let index = 1; index < parts.length; index++)
          directories.add(parts.slice(0, index).join('/'));
        paths.push(name);
        if (
          paths.length + directories.size > limits.maxWorkspaceEntries ||
          bytes > limits.maxWorkspaceBytes
        )
          stop('WORKSPACE_QUOTA_EXCEEDED');
      }
      return paths;
    });
  }

  async plan(
    workspaceId: number,
    repositoryLease: WorkspaceLease,
    workspaceLease: WorkspaceLease,
    options: { targetCommit?: string } = {},
  ): Promise<WorkspaceGitPlan> {
    const current = await this.inspect(workspaceId, workspaceLease);
    const repository = await this.repository(
      current.repositoryId,
      repositoryLease,
    );
    try {
      validateWorkspaceRef(current.refType, current.refName);
    } catch {
      stop('INVALID_REF');
    }
    const root = this.roots.path(await this.store.workspace(workspaceId));
    const gitRow = (
      await this.store.all<GitWorkspaceRow>(
        'SELECT * FROM GitWorkspaces WHERE workspace_id=?',
        [workspaceId],
      )
    )[0];
    return this.supervised(
      [repositoryLease, workspaceLease],
      {},
      async (run) => {
        if (
          current.refType !== 'commit' &&
          (
            await run(
              [
                'check-ref-format',
                current.refType === 'branch'
                  ? `refs/heads/${current.refName}`
                  : `refs/tags/${current.refName}`,
              ],
              repository.bare,
              undefined,
              true,
            )
          ).code
        )
          stop('INVALID_REF');
        // Tags and commit references remain the originally resolved immutable pin.
        const ref =
          options.targetCommit === undefined
            ? current.refType === 'branch'
              ? `refs/remotes/origin/${current.refName}`
              : gitRow.resolved_commit
            : objectId(options.targetCommit);
        if (current.refType !== 'branch' && ref !== gitRow.resolved_commit)
          stop('SOURCE_SUPERSEDED');
        const resolved = await run(
          [
            '--git-dir',
            repository.bare,
            'rev-parse',
            '--verify',
            `${ref}^{commit}`,
          ],
          repository.bare,
          undefined,
          true,
        );
        if (resolved.code) stop('REF_NOT_FOUND');
        const target = objectId(resolved.stdout),
          targetPaths = await this.targetTree(target, repository.bare, [
            repositoryLease,
            workspaceLease,
          ]);
        const explicit = [
          '--git-dir',
          path.join(repository.bare, 'worktrees', current.proof.adminKey),
          '--work-tree',
          root,
        ];
        const changed = await run(
          [
            ...explicit,
            'diff',
            '--name-only',
            '--no-renames',
            '-z',
            current.head,
            target,
            '--',
          ],
          root,
        );
        const changedPaths = changed.stdout.split('\0').filter(Boolean);
        let diagnostic: string | null = null;
        if (
          (await run([...explicit, 'ls-files', '--unmerged', '-z'], root))
            .stdout
        )
          diagnostic = 'GIT_CONFLICT';
        else if (
          (
            await run(
              [
                ...explicit,
                'diff',
                '--cached',
                '--quiet',
                '--no-ext-diff',
                'HEAD',
                '--',
              ],
              root,
              undefined,
              true,
            )
          ).code
        )
          diagnostic = 'STAGED_CHANGES';
        else if (
          (await run([...explicit, 'ls-files', '-v', '-z'], root)).stdout
            .split('\0')
            .some((record) => /^[a-zS] /.test(record))
        )
          diagnostic = 'DIRTY_WORKTREE';
        else if (
          (
            await run(
              [...explicit, 'diff', '--quiet', '--no-ext-diff', '--'],
              root,
              undefined,
              true,
            )
          ).code
        )
          diagnostic = 'DIRTY_WORKTREE';
        else {
          // Include ignored files: merge must never overwrite an ignored user file.
          const untracked = (
            await run([...explicit, 'ls-files', '--others', '-z'], root)
          ).stdout
            .split('\0')
            .filter((name) => name && name !== OWNER_MARKER);
          if (untracked.length)
            diagnostic = untracked.some((name) =>
              targetPaths.some(
                (targetPath) =>
                  name === targetPath ||
                  name.startsWith(targetPath + '/') ||
                  targetPath.startsWith(name + '/'),
              ),
            )
              ? 'UNTRACKED_COLLISION'
              : 'DIRTY_WORKTREE';
        }
        if (!diagnostic && current.head !== target) {
          const counts = (
            await run(
              [
                ...explicit,
                'rev-list',
                '--left-right',
                '--count',
                `${current.head}...${target}`,
                '--',
              ],
              root,
            )
          ).stdout
            .trim()
            .split(/\s+/)
            .map(Number);
          if (
            counts.length !== 2 ||
            counts.some((count) => !Number.isSafeInteger(count) || count < 0)
          )
            stop('MISSING_OBJECT');
          if (counts[0])
            diagnostic = counts[1] ? 'DIVERGED' : 'LOCAL_ONLY_COMMITS';
        }
        return {
          workspaceId,
          repositoryId: current.repositoryId,
          before: current.head,
          target,
          refType: current.refType,
          refName: current.refName,
          diagnostic,
          changedPaths,
          status: diagnostic
            ? 'BLOCKED'
            : current.head === target
            ? 'NO_CHANGE'
            : 'FF_READY',
          proof: current.proof,
        };
      },
    );
  }

  async changedPaths(
    workspaceId: number,
    before: string,
    target: string,
    repositoryLease: WorkspaceLease,
    workspaceLease: WorkspaceLease,
  ) {
    const current = await this.inspect(workspaceId, workspaceLease);
    const repository = await this.repository(
      current.repositoryId,
      repositoryLease,
    );
    const left = objectId(before),
      right = objectId(target);
    return this.supervised(
      [repositoryLease, workspaceLease],
      {},
      async (run) => {
        const result = await run(
          [
            '--git-dir',
            repository.bare,
            'diff',
            '--no-ext-diff',
            '--name-only',
            '--no-renames',
            '-z',
            left,
            right,
            '--',
          ],
          repository.bare,
        );
        const names = result.stdout.split('\0').filter(Boolean);
        for (const name of names) {
          try {
            relativeWorkspacePath(name);
          } catch {
            stop('UNSAFE_TARGET_TREE');
          }
        }
        return names;
      },
    );
  }

  async apply(
    plan: WorkspaceGitPlan,
    repositoryLease: WorkspaceLease,
    workspaceLease: WorkspaceLease,
    options: WorkspaceGitApplyOptions = {},
  ): Promise<WorkspaceGitInspection> {
    if (plan.diagnostic || plan.status === 'BLOCKED')
      stop(plan.diagnostic || 'DIRTY_WORKTREE');
    const repository = await this.repository(
      plan.repositoryId,
      repositoryLease,
    );
    const current = await this.inspect(plan.workspaceId, workspaceLease);
    if (
      current.repositoryId !== plan.repositoryId ||
      current.head !== plan.before ||
      current.refType !== plan.refType ||
      current.refName !== plan.refName ||
      JSON.stringify(current.proof) !== JSON.stringify(plan.proof)
    )
      stop('SOURCE_SUPERSEDED');
    if (plan.status === 'NO_CHANGE') return current;
    const fresh = await this.plan(
      plan.workspaceId,
      repositoryLease,
      workspaceLease,
    );
    if (
      fresh.status !== 'FF_READY' ||
      fresh.target !== plan.target ||
      fresh.before !== plan.before ||
      fresh.diagnostic
    )
      stop(fresh.diagnostic || 'SOURCE_SUPERSEDED');
    await options.beforeMutation?.(plan);
    await this.options.fault?.('BEFORE_GIT_MUTATION', {
      workspaceId: plan.workspaceId,
      before: plan.before,
      target: plan.target,
    });
    const root = this.roots.path(await this.store.workspace(plan.workspaceId));
    await this.supervised(
      [repositoryLease, workspaceLease],
      options,
      async (run) => {
        const operation = run(
          [
            '--git-dir',
            path.join(repository.bare, 'worktrees', plan.proof.adminKey),
            '--work-tree',
            root,
            'merge',
            '--ff-only',
            '--no-edit',
            '--no-overwrite-ignore',
            plan.target,
          ],
          root,
        );
        // The real supervised Git request has been sent before this checkpoint.
        try {
          await options.duringCheckout?.(plan);
          await this.options.fault?.('DURING_GIT_CHECKOUT', {
            workspaceId: plan.workspaceId,
            before: plan.before,
            target: plan.target,
          });
        } catch (error) {
          await operation.catch(() => undefined);
          throw error;
        }
        await operation;
      },
    );
    const actual = await this.inspect(plan.workspaceId, workspaceLease);
    if (actual.head !== plan.target) stop('WORKSPACE_RECOVERY_REQUIRED');
    const verified = await this.plan(
      plan.workspaceId,
      repositoryLease,
      workspaceLease,
      { targetCommit: plan.target },
    );
    if (
      verified.diagnostic ||
      verified.status !== 'NO_CHANGE' ||
      verified.before !== plan.target ||
      verified.target !== plan.target
    )
      stop('WORKSPACE_RECOVERY_REQUIRED');
    await options.afterHEAD?.(actual);
    await this.options.fault?.('AFTER_GIT_HEAD', {
      workspaceId: plan.workspaceId,
      before: plan.before,
      target: plan.target,
    });
    return actual;
  }
}
