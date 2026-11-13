import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { GitCredential } from '../data/gitCredential';
import {
  normalizeRepositoryUrl,
  RepositoryIdentity,
} from '../shared/gitProvider';
import GitCredentialResolver, {
  GitAccessContext,
} from '../services/gitCredentialResolver';
import {
  inspectSshCredential,
  publicKeyFingerprint,
} from '../services/sshCredentialKey';
import { privateJson, readJson, syncDirectory } from '../services/backup/files';
import {
  gitRepositoryKey,
  verifyGitRepositoryAsset,
} from '../services/workspaceV2/gitStorage';
import { renameWorkspaceExclusive } from '../services/workspaceV2/roots';
import type { WorkspaceLease } from '../services/workspaceV2/lease';
import { fail, errorCode } from '../services/workspaceV2/errors';
import type { V2Services, RouteMap } from './types';
import * as v from './workspaceValidation';

interface CredentialRow extends GitCredential {
  id: number;
  secret: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface CandidateRepository extends RepositoryIdentity {
  id: number;
  name: string;
  default_credential_id: number | null;
  status: string;
  storage_state: string;
  storage_path: string | null;
  last_fetch_at: string | null;
  last_fetch_status: string | null;
  last_error: string | null;
  default_branch: string | null;
  last_known_remote_head: string | null;
  remote_refs_count: number;
  tags_count: number;
}
interface Secret {
  token?: string;
  private_key?: string;
  passphrase?: string;
}
export interface CandidateGitCapabilities {
  /** Constructor-only fixture capability; HTTP input never selects a transport bypass. */
  normalizeRemote?: (remote: string) => Promise<RepositoryIdentity>;
  accessResolver?: (
    repository: Readonly<CandidateRepository>,
    operation: 'read' | 'push',
  ) => Promise<GitAccessContext>;
}
/** Explicit candidate SQLite adapter around the existing credential and supervised Git algorithms. */
export class CandidateGitResources {
  constructor(
    readonly s: V2Services,
    private readonly capabilities: CandidateGitCapabilities = {},
  ) {}
  async normalize(remote: string) {
    if (this.capabilities.normalizeRemote)
      return this.capabilities.normalizeRemote(remote);
    try {
      return normalizeRepositoryUrl(remote);
    } catch {
      fail('INVALID_REQUEST', 400);
    }
  }
  private async credential(id: number) {
    const row = (
      await this.s.store.all<CredentialRow>(
        'SELECT * FROM GitCredentials WHERE id=?',
        [id],
      )
    )[0];
    if (!row) fail('REPOSITORY_NOT_FOUND', 404);
    return row;
  }
  async credentialDto(id: number) {
    const row = await this.credential(id),
      repositories = (
        await this.s.store.all<{ count: number }>(
          'SELECT COUNT(*) count FROM Repositories WHERE default_credential_id=?',
          [id],
        )
      )[0].count;
    const secret = this.secret(row);
    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      auth_type: row.auth_type,
      username: row.username ?? null,
      public_key: row.public_key ?? null,
      known_hosts: row.known_hosts ?? null,
      capability: row.capability,
      status: row.status,
      last_test_at: v.utcTimestamp(row.last_test_at),
      last_test_result: row.last_test_result ?? null,
      fingerprint: publicKeyFingerprint(row.public_key),
      has_secret: !!(secret.token || secret.private_key),
      used_by: { repositories, total: repositories },
    };
  }
  private secret(row: CredentialRow): Secret {
    try {
      const candidate: unknown = JSON.parse(row.secret || '{}'),
        value = v.object(candidate, ['token', 'private_key', 'passphrase']);
      const result: Secret = {};
      for (const key of ['token', 'private_key', 'passphrase'] as const)
        if (value[key] !== undefined)
          result[key] = v.text(value[key], 1024 * 1024, true);
      return result;
    } catch {
      fail('AUTHENTICATION_REQUIRED', 403);
    }
  }
  async saveCredential(body: unknown, update = false) {
    const input = v.object(body, [
      'id',
      'name',
      'provider',
      'auth_type',
      'username',
      'public_key',
      'known_hosts',
      'capability',
      'status',
      'token',
      'private_key',
      'passphrase',
      'replace_secret',
    ]);
    if (update !== 'id' in input) fail('INVALID_REQUEST', 400);
    const old = update ? await this.credential(v.number(input.id)) : undefined;
    const name = v.text(input.name ?? old?.name, 255).trim();
    if (!name || /[\x00-\x1f\x7f]/.test(name)) fail('INVALID_REQUEST', 400);
    const provider = v.choice(input.provider ?? old?.provider, [
      'github',
      'gitlab',
      'gitee',
      'generic',
    ]);
    const auth_type = v.choice(input.auth_type ?? old?.auth_type, [
      'anonymous',
      'https_token',
      'ssh_key',
    ]);
    const capability = v.choice(input.capability ?? old?.capability ?? 'READ', [
      'READ',
      'WRITE',
    ]);
    const status = v.choice(input.status ?? old?.status ?? 'enabled', [
      'enabled',
      'disabled',
    ]);
    const username = v.text(input.username ?? old?.username ?? '', 255, true),
      known_hosts = v.text(
        input.known_hosts ?? old?.known_hosts ?? '',
        1024 * 1024,
        true,
      );
    if (input.replace_secret !== undefined) v.boolean(input.replace_secret);
    let secret: Secret = old ? this.secret(old) : {};
    if (auth_type === 'anonymous') secret = {};
    else if (
      !old ||
      input.replace_secret === true ||
      old.auth_type !== auth_type
    ) {
      secret =
        auth_type === 'https_token'
          ? { token: v.text(input.token, 1024 * 1024) }
          : {
              private_key: v.text(input.private_key, 1024 * 1024),
              ...(input.passphrase === undefined
                ? {}
                : { passphrase: v.text(input.passphrase, 1024 * 1024, true) }),
            };
    } else if (
      input.token !== undefined ||
      input.private_key !== undefined ||
      input.passphrase !== undefined
    )
      fail('INVALID_REQUEST', 400);
    if (
      auth_type === 'https_token' &&
      (!secret.token?.trim() || /[\r\n\0]/.test(secret.token))
    )
      fail('INVALID_REQUEST', 400);
    let public_key = auth_type === 'ssh_key' ? old?.public_key ?? '' : '';
    if (auth_type === 'ssh_key') {
      if (!secret.private_key?.includes('PRIVATE KEY') || !known_hosts.trim())
        fail('INVALID_REQUEST', 400);
      try {
        public_key = await inspectSshCredential(
          {
            name,
            provider,
            auth_type,
            username,
            known_hosts,
            capability,
            status,
          },
          secret,
        );
      } catch {
        fail('INVALID_REQUEST', 400);
      }
    }
    return this.s.leases.barrier.mutation(async () =>
      this.s.store.transaction(async (tx) => {
        const now = new Date().toISOString(),
          values = [
            name,
            provider,
            auth_type,
            username,
            JSON.stringify(secret),
            public_key,
            known_hosts,
            capability,
            status,
          ];
        let id = old?.id;
        if (id)
          await tx.run(
            'UPDATE GitCredentials SET name=?,provider=?,auth_type=?,username=?,secret=?,public_key=?,known_hosts=?,capability=?,status=?,updatedAt=? WHERE id=?',
            [...values, now, id],
          );
        else
          id = (
            await tx.run(
              'INSERT INTO GitCredentials(name,provider,auth_type,username,secret,public_key,known_hosts,capability,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
              [...values, now, now],
            )
          ).lastID;
        return this.credentialDto(id);
      }),
    );
  }
  async removeCredential(id: number) {
    return this.s.leases.barrier.mutation(async () =>
      this.s.store.transaction(async (tx) => {
        await this.credential(id);
        if (
          (
            await tx.all<{ count: number }>(
              'SELECT COUNT(*) count FROM Repositories WHERE default_credential_id=?',
              [id],
            )
          )[0].count
        )
          fail('WORKSPACE_REFERENCED');
        await tx.run('DELETE FROM GitCredentials WHERE id=?', [id]);
        return { id };
      }),
    );
  }
  async repository(id: number) {
    const row = (
      await this.s.store.all<CandidateRepository>(
        'SELECT * FROM Repositories WHERE id=?',
        [id],
      )
    )[0];
    if (!row) fail('REPOSITORY_NOT_FOUND', 404);
    return row;
  }
  async repositoryDto(id: number) {
    const r = await this.repository(id),
      count = (
        await this.s.store.all<{ count: number }>(
          'SELECT COUNT(*) count FROM GitWorkspaces WHERE repository_id=?',
          [id],
        )
      )[0].count;
    return {
      id: r.id,
      name: r.name,
      provider: r.provider,
      remote_url: r.remote_url,
      normalized_url: r.normalized_url,
      host: r.host,
      path: r.path,
      owner: r.owner,
      repository_name: r.repository_name,
      default_credential_id: r.default_credential_id,
      status: r.status,
      storage_state: r.storage_state,
      last_fetch_at: v.utcTimestamp(r.last_fetch_at),
      last_fetch_status: r.last_fetch_status,
      last_error:
        r.last_error && /^[A-Z][A-Z0-9_]+$/.test(r.last_error)
          ? r.last_error
          : null,
      default_branch: r.default_branch,
      last_known_remote_head: r.last_known_remote_head,
      remote_refs_count: r.remote_refs_count,
      tags_count: r.tags_count,
      used_by: { workspaces: count, total: count },
    };
  }
  async saveRepository(body: unknown, update = false) {
    const input = v.object(body, [
      'id',
      'name',
      'remote_url',
      'default_credential_id',
    ]);
    if (update !== 'id' in input) fail('INVALID_REQUEST', 400);
    const old = update ? await this.repository(v.number(input.id)) : undefined;
    const identity = await this.normalize(
      v.text(input.remote_url ?? old?.remote_url),
    );
    const name = v
      .text(input.name ?? old?.name ?? identity.repository_name, 255)
      .trim();
    if (!name || /[\x00-\x1f\x7f]/.test(name)) fail('INVALID_REQUEST', 400);
    const credentialId =
      input.default_credential_id === null
        ? null
        : input.default_credential_id === undefined
        ? old?.default_credential_id ?? null
        : v.number(input.default_credential_id);
    if (credentialId) {
      const credential = await this.credential(credentialId);
      if (
        credential.status !== 'enabled' ||
        (credential.provider !== 'generic' &&
          credential.provider !== identity.provider)
      )
        fail('INVALID_REQUEST', 400);
    }
    const save = async () =>
      this.s.store.transaction(async (tx) => {
        if (old && old.remote_url !== identity.remote_url) {
          if (
            (
              await tx.all<{ count: number }>(
                'SELECT COUNT(*) count FROM GitWorkspaces WHERE repository_id=?',
                [old.id],
              )
            )[0].count
          )
            fail('WORKSPACE_REFERENCED');
        }
        const values = [
          name,
          identity.provider,
          identity.remote_url,
          identity.normalized_url,
          identity.host,
          identity.path,
          identity.owner,
          identity.repository_name,
          credentialId,
        ];
        let id = old?.id;
        if (id)
          await tx.run(
            'UPDATE Repositories SET name=?,provider=?,remote_url=?,normalized_url=?,host=?,path=?,owner=?,repository_name=?,default_credential_id=?,updatedAt=? WHERE id=?',
            [...values, new Date().toISOString(), id],
          );
        else
          id = (
            await tx.run(
              'INSERT INTO Repositories(name,provider,remote_url,normalized_url,host,path,owner,repository_name,default_credential_id) VALUES(?,?,?,?,?,?,?,?,?)',
              values,
            )
          ).lastID;
        return this.repositoryDto(id);
      });
    return old
      ? this.s.leases.withRepository(old.id, 'REPOSITORY_SAVE', save)
      : this.s.leases.barrier.mutation(save);
  }
  async access(row: CandidateRepository, operation: 'read' | 'push' = 'read') {
    const credential = row.default_credential_id
      ? await this.credential(row.default_credential_id)
      : null;
    if (operation === 'push' && credential?.capability !== 'WRITE')
      fail('GIT_WRITE_REQUIRED', 403);
    if (this.capabilities.accessResolver) {
      const access = await this.capabilities.accessResolver(row, operation);
      if (access.remote !== row.remote_url) {
        await access.cleanup();
        fail('INVALID_REQUEST', 400);
      }
      return access;
    }
    try {
      return await new GitCredentialResolver().resolve(
        credential,
        credential ? this.secret(credential) : {},
        row.remote_url,
        operation,
      );
    } catch {
      fail('GIT_CREDENTIAL_INVALID', 403);
    }
  }
  environment(
    access: GitAccessContext,
    identity?: { name: string; email: string },
  ) {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin:/usr/local/bin',
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_ATTR_NOSYSTEM: '1',
    };
    for (const [key, value] of Object.entries(access.env))
      if (/^(?:GIT_|SSH_ASKPASS|SSH_ASKPASS_REQUIRE|DISPLAY$)/.test(key))
        env[key] = value;
    if (identity)
      Object.assign(env, {
        GIT_AUTHOR_NAME: identity.name,
        GIT_COMMITTER_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_EMAIL: identity.email,
      });
    return env;
  }
  async testRepository(id: number) {
    return this.s.leases.withRepository(
      id,
      'REPOSITORY_TEST',
      async (lease) => {
        const row = await this.repository(id),
          access = await this.access(row);
        try {
          const result = await this.s.git.withCommands(
            [lease],
            { timeoutMs: 30000 },
            (run) =>
              run(
                ['ls-remote', '--symref', '--', access.remote, 'HEAD'],
                this.s.roots.dataRoot,
                this.environment(access),
                true,
              ),
          );
          const status = result.code ? 'unreachable' : 'available';
          await this.s.store.run(
            'UPDATE Repositories SET status=?,last_error=?,updatedAt=? WHERE id=?',
            [
              status,
              result.code ? 'GIT_FETCH_FAILED' : null,
              new Date().toISOString(),
              id,
            ],
          );
          return {
            success: !result.code,
            status,
            error_code: result.code ? 'GIT_FETCH_FAILED' : null,
          };
        } finally {
          await access.cleanup();
        }
      },
    );
  }
  async testCredential(id: number, remote: string) {
    await this.normalize(remote);
    const credential = await this.credential(id);
    return this.s.leases.barrier.mutation(async () => {
      let success = false;
      const access = await new GitCredentialResolver()
        .resolve(credential, this.secret(credential), remote)
        .catch(() => fail('GIT_CREDENTIAL_INVALID', 403));
      try {
        // A private candidate repository lock supplies the inherited admission FD.
        success = await this.s.leases.withRepository(
          id,
          'CREDENTIAL_TEST',
          (lease) =>
            this.s.git.withCommands(
              [lease],
              { timeoutMs: 30000 },
              async (run) =>
                (
                  await run(
                    ['ls-remote', '--', access.remote, 'HEAD'],
                    this.s.roots.dataRoot,
                    this.environment(access),
                    true,
                  )
                ).code === 0,
            ),
        );
      } finally {
        await access.cleanup();
      }
      await this.s.store.run(
        'UPDATE GitCredentials SET last_test_at=?,last_test_result=?,updatedAt=? WHERE id=?',
        [
          new Date().toISOString(),
          success ? 'SUCCESS' : 'GIT_FETCH_FAILED',
          new Date().toISOString(),
          id,
        ],
      );
      return { success, error_code: success ? null : 'GIT_FETCH_FAILED' };
    });
  }
  async initialize(id: number, repair = false) {
    return this.s.leases.withRepository(
      id,
      'REPOSITORY_INITIALIZE',
      async (lease) => {
        const row = await this.repository(id),
          key = gitRepositoryKey(row),
          bare = path.join(this.s.roots.dataRoot, key);
        const parent = await this.s.roots.directory('git', true),
          journalParent = await this.s.roots.directory(
            'tmp/workspace-v2/repositories',
            true,
          ),
          journal = path.join(journalParent, `repository-${id}.json`);
        let stat = await fs.lstat(bare).catch((e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        });
        if (stat && row.storage_state === 'READY') {
          await verifyGitRepositoryAsset(
            this.s.store,
            this.s.roots.dataRoot,
            id,
            { leaseFds: lease.processLeaseFds },
          );
          const pending = await fs
            .lstat(journal)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            });
          if (pending) {
            const proof = await readJson(journal);
            if (
              proof.repository_id !== id ||
              proof.storage_key !== key ||
              proof.dev !== stat.dev ||
              proof.ino !== stat.ino ||
              !proof.token
            )
              fail('WORKSPACE_RECOVERY_REQUIRED');
            await this.fetchLocked(id, lease);
            await fs.unlink(journal);
            await syncDirectory(journalParent);
          }
          return this.repositoryDto(id);
        }
        if (stat) {
          if (!repair) fail('WORKSPACE_RECOVERY_REQUIRED');
          const proof = await readJson(journal).catch(() =>
            fail('WORKSPACE_RECOVERY_REQUIRED'),
          );
          if (
            proof.repository_id !== id ||
            proof.storage_key !== key ||
            proof.dev !== stat.dev ||
            proof.ino !== stat.ino ||
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            stat.mode & 0o077 ||
            !proof.token
          )
            fail('WORKSPACE_RECOVERY_REQUIRED');
        } else {
          if (
            (
              await this.s.store.all<{ count: number }>(
                'SELECT COUNT(*) count FROM GitWorkspaces WHERE repository_id=?',
                [id],
              )
            )[0].count
          )
            fail('WORKSPACE_RECOVERY_REQUIRED');
          await this.s.store.run(
            "UPDATE Repositories SET storage_state='INITIALIZING',storage_path=?,last_error=NULL WHERE id=?",
            [bare, id],
          );
          await fs.mkdir(bare, { mode: 0o700 });
          stat = await fs.lstat(bare);
          await privateJson(journal, {
            repository_id: id,
            storage_key: key,
            dev: stat.dev,
            ino: stat.ino,
            token: randomUUID(),
          });
          await syncDirectory(parent);
        }
        try {
          await this.s.git.withCommands([lease], {}, (run) =>
            run(['init', '--bare', '--', bare], parent),
          );
          await this.s.store.run(
            "UPDATE Repositories SET storage_state='READY',storage_path=?,last_error=NULL WHERE id=?",
            [bare, id],
          );
          await verifyGitRepositoryAsset(
            this.s.store,
            this.s.roots.dataRoot,
            id,
            { leaseFds: lease.processLeaseFds },
          );
          await this.fetchLocked(id, lease);
          await fs.unlink(journal);
          await syncDirectory(journalParent);
          return this.repositoryDto(id);
        } catch (error: unknown) {
          await this.s.store.run(
            "UPDATE Repositories SET last_error=?,storage_state=CASE WHEN storage_state='INITIALIZING' THEN 'ERROR' ELSE storage_state END WHERE id=?",
            [errorCode(error), id],
          );
          throw error;
        }
      },
    );
  }
  private async fetchLocked(id: number, lease: WorkspaceLease) {
    const row = await this.repository(id),
      access = await this.access(row);
    try {
      await verifyGitRepositoryAsset(this.s.store, this.s.roots.dataRoot, id, {
        leaseFds: lease.processLeaseFds,
      });
      const bare = path.join(this.s.roots.dataRoot, gitRepositoryKey(row));
      const result = await this.s.git.withCommands([lease], {}, (run) =>
        run(
          [
            '--git-dir',
            bare,
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
          bare,
          this.environment(access),
          true,
        ),
      );
      if (result.code) {
        await this.s.store.run(
          "UPDATE Repositories SET status='unreachable',last_fetch_status='FAILED',last_error='GIT_FETCH_FAILED' WHERE id=?",
          [id],
        );
        fail('GIT_FETCH_FAILED');
      }
      await verifyGitRepositoryAsset(this.s.store, this.s.roots.dataRoot, id, {
        leaseFds: lease.processLeaseFds,
      });
      const refs = await this.refsLocked(row, lease);
      await this.s.store.run(
        "UPDATE Repositories SET status='available',last_fetch_at=?,last_fetch_status='SUCCESS',last_error=NULL,remote_refs_count=?,tags_count=?,updatedAt=? WHERE id=?",
        [
          new Date().toISOString(),
          refs.filter((ref) => ref.type === 'branch').length,
          refs.filter((ref) => ref.type === 'tag').length,
          new Date().toISOString(),
          id,
        ],
      );
      return this.repositoryDto(id);
    } finally {
      await access.cleanup();
    }
  }
  async fetch(id: number) {
    return this.s.leases.withRepository(id, 'REPOSITORY_FETCH', (lease) =>
      this.fetchLocked(id, lease),
    );
  }
  private async refsLocked(row: CandidateRepository, lease: WorkspaceLease) {
    const bare = path.join(this.s.roots.dataRoot, gitRepositoryKey(row));
    await verifyGitRepositoryAsset(
      this.s.store,
      this.s.roots.dataRoot,
      row.id,
      { leaseFds: lease.processLeaseFds },
    );
    const result = await this.s.git.withCommands([lease], {}, (run) =>
      run(
        [
          '--git-dir',
          bare,
          'for-each-ref',
          '--format=%(refname)%00%(objectname)',
          'refs/remotes/origin/',
          'refs/tags/',
        ],
        bare,
      ),
    );
    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, commit] = line.split('\0');
        return {
          name: ref.replace(/^refs\/(?:remotes\/origin|tags)\//, ''),
          type: ref.startsWith('refs/tags/') ? 'tag' : 'branch',
          commit,
        };
      });
  }
  async refs(id: number) {
    return this.s.leases.withRepository(id, 'REPOSITORY_REFS', async (lease) =>
      this.refsLocked(await this.repository(id), lease),
    );
  }
  async prune(id: number) {
    return this.s.leases.withRepository(
      id,
      'REPOSITORY_PRUNE',
      async (lease) => {
        const row = await this.repository(id),
          bare = path.join(this.s.roots.dataRoot, gitRepositoryKey(row));
        await verifyGitRepositoryAsset(
          this.s.store,
          this.s.roots.dataRoot,
          id,
          { leaseFds: lease.processLeaseFds },
        );
        // Prune only stale remote-tracking refs through the authenticated atomic fetch.
        // Linked-worktree registrations and private branches remain owned by lifecycle.
        await this.fetchLocked(id, lease);
        await syncDirectory(bare);
        return this.repositoryDto(id);
      },
    );
  }
  async removeRepository(id: number) {
    return this.s.leases.withRepository(
      id,
      'REPOSITORY_DELETE',
      async (lease) => {
        const row = await this.repository(id);
        if (
          (
            await this.s.store.all<{ count: number }>(
              'SELECT COUNT(*) count FROM GitWorkspaces WHERE repository_id=?',
              [id],
            )
          )[0].count
        )
          fail('WORKSPACE_REFERENCED');
        if (row.storage_state === 'UNINITIALIZED') {
          const unknown = await fs
            .lstat(path.join(this.s.roots.dataRoot, gitRepositoryKey(row)))
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            });
          if (unknown) fail('WORKSPACE_RECOVERY_REQUIRED');
          await this.s.store.run('DELETE FROM Repositories WHERE id=?', [id]);
          return { id };
        }
        const parent = await this.s.roots.directory(
            'tmp/workspace-v2/repositories',
            true,
          ),
          journalFile = path.join(parent, `delete-${id}.json`);
        type Entry = {
          path: string;
          dev: number;
          ino: number;
          directory: boolean;
          size: number;
          mtime: number;
          ctime: number;
        };
        type Journal = {
          repository_id: number;
          key: string;
          quarantine: string;
          dev: number;
          ino: number;
          entries: Entry[];
        };
        let journal: Journal;
        if (row.storage_state === 'DELETING') {
          const parsed: unknown = await readJson(journalFile);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            fail('WORKSPACE_RECOVERY_REQUIRED');
          journal = parsed as Journal;
          if (
            journal.repository_id !== id ||
            journal.key !== gitRepositoryKey(row) ||
            !/^git\/\.reclaim-repository-[1-9][0-9]*-[0-9a-f-]{36}$/.test(
              journal.quarantine,
            ) ||
            !journal.quarantine.startsWith(`git/.reclaim-repository-${id}-`) ||
            !Array.isArray(journal.entries)
          )
            fail('WORKSPACE_RECOVERY_REQUIRED');
        } else {
          if (row.storage_state !== 'READY')
            fail('WORKSPACE_RECOVERY_REQUIRED');
          const asset = await verifyGitRepositoryAsset(
              this.s.store,
              this.s.roots.dataRoot,
              id,
              { leaseFds: lease.processLeaseFds },
            ),
            root = asset.bare,
            entries: Entry[] = [];
          const registrations = await fs
            .lstat(path.join(root, 'worktrees'))
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            });
          if (
            registrations &&
            (!registrations.isDirectory() ||
              registrations.isSymbolicLink() ||
              (await fs.readdir(path.join(root, 'worktrees'))).length)
          )
            fail('WORKSPACE_REFERENCED');
          const walk = async (relative: string): Promise<void> => {
            const stat = await fs.lstat(path.join(root, relative));
            if (
              stat.isSymbolicLink() ||
              (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) ||
              (process.getuid && stat.uid !== process.getuid())
            )
              fail('WORKSPACE_RECOVERY_REQUIRED');
            if (stat.isDirectory())
              for (const name of await fs.readdir(path.join(root, relative)))
                await walk(relative ? relative + '/' + name : name);
            entries.push({
              path: relative,
              dev: stat.dev,
              ino: stat.ino,
              directory: stat.isDirectory(),
              size: stat.size,
              mtime: stat.mtimeMs,
              ctime: stat.ctimeMs,
            });
            if (entries.length > 5000) fail('WORKSPACE_QUOTA_EXCEEDED', 413);
          };
          await walk('');
          const stat = await fs.lstat(root);
          journal = {
            repository_id: id,
            key: gitRepositoryKey(row),
            quarantine: `git/.reclaim-repository-${id}-${randomUUID()}`,
            dev: stat.dev,
            ino: stat.ino,
            entries,
          };
          if (Buffer.byteLength(JSON.stringify(journal)) > 900000)
            fail('WORKSPACE_QUOTA_EXCEEDED', 413);
          await privateJson(journalFile, journal);
          await this.s.store.run(
            "UPDATE Repositories SET storage_state='DELETING' WHERE id=?",
            [id],
          );
        }
        const source = path.join(this.s.roots.dataRoot, journal.key),
          quarantine = path.join(this.s.roots.dataRoot, journal.quarantine);
        const sourceStat = await fs
          .lstat(source)
          .catch((e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return null;
            throw e;
          });
        let quarantined = await fs
          .lstat(quarantine)
          .catch((e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return null;
            throw e;
          });
        if (sourceStat) {
          if (
            quarantined ||
            sourceStat.dev !== journal.dev ||
            sourceStat.ino !== journal.ino ||
            !sourceStat.isDirectory() ||
            sourceStat.isSymbolicLink()
          )
            fail('WORKSPACE_RECOVERY_REQUIRED');
          await renameWorkspaceExclusive(source, quarantine);
          quarantined = await fs.lstat(quarantine);
        }
        if (quarantined) {
          if (
            quarantined.dev !== journal.dev ||
            quarantined.ino !== journal.ino ||
            !quarantined.isDirectory() ||
            quarantined.isSymbolicLink()
          )
            fail('WORKSPACE_RECOVERY_REQUIRED');
          for (const entry of journal.entries) {
            if (
              typeof entry.path !== 'string' ||
              entry.path
                .split('/')
                .some((part) => part === '..' || part === '.') ||
              path.isAbsolute(entry.path) ||
              entry.path.includes('\\')
            )
              fail('WORKSPACE_RECOVERY_REQUIRED');
            const location = path.join(quarantine, entry.path),
              stat = await fs
                .lstat(location)
                .catch((e: NodeJS.ErrnoException) => {
                  if (e.code === 'ENOENT') return null;
                  throw e;
                });
            if (!stat) continue;
            if (
              stat.dev !== entry.dev ||
              stat.ino !== entry.ino ||
              stat.isSymbolicLink() ||
              stat.isDirectory() !== entry.directory ||
              (!entry.directory &&
                (stat.nlink !== 1 ||
                  stat.size !== entry.size ||
                  stat.mtimeMs !== entry.mtime ||
                  stat.ctimeMs !== entry.ctime))
            )
              fail('WORKSPACE_RECOVERY_REQUIRED');
            if (entry.directory) await fs.rmdir(location);
            else await fs.unlink(location);
          }
        }
        await syncDirectory(path.dirname(source));
        await this.s.store.run('DELETE FROM Repositories WHERE id=?', [id]);
        await fs.unlink(journalFile);
        await syncDirectory(parent);
        return { id };
      },
    );
  }
}
const instances = new WeakMap<object, CandidateGitResources>();
export function candidateGitResources(s: V2Services) {
  let resources = instances.get(s.store);
  if (!resources) {
    resources = new CandidateGitResources(s);
    instances.set(s.store, resources);
  }
  return resources;
}
export function repositoryApiRoutes(
  s: V2Services,
  resources = candidateGitResources(s),
): RouteMap {
  const id = (params: Record<string, string>) => v.pathId(params.id);
  const empty = (body: unknown) => v.object(body ?? {}, []);
  return {
    'GET /git-credentials': async () =>
      Promise.all(
        (
          await s.store.all<{ id: number }>(
            'SELECT id FROM GitCredentials ORDER BY id DESC',
          )
        ).map((row) => resources.credentialDto(row.id)),
      ),
    'GET /git-credentials/:id': async ({ params }) =>
      resources.credentialDto(id(params)),
    'POST /git-credentials': async ({ body }) => resources.saveCredential(body),
    'PUT /git-credentials': async ({ body }) =>
      resources.saveCredential(body, true),
    'DELETE /git-credentials/:id': async ({ params, body }) => {
      empty(body);
      return resources.removeCredential(id(params));
    },
    'POST /git-credentials/:id/test': async ({ params, body }) => {
      const input = v.object(body, ['remote_url'], ['remote_url']);
      return resources.testCredential(id(params), v.text(input.remote_url));
    },
    'POST /repositories/normalize': async ({ body }) => {
      const input = v.object(body, ['remote_url'], ['remote_url']);
      return resources.normalize(v.text(input.remote_url));
    },
    'GET /repositories': async () =>
      Promise.all(
        (
          await s.store.all<{ id: number }>(
            'SELECT id FROM Repositories ORDER BY id DESC',
          )
        ).map((row) => resources.repositoryDto(row.id)),
      ),
    'GET /repositories/:id': async ({ params }) =>
      resources.repositoryDto(id(params)),
    'POST /repositories': async ({ body }) => resources.saveRepository(body),
    'PUT /repositories': async ({ body }) =>
      resources.saveRepository(body, true),
    'POST /repositories/:id/test': async ({ params, body }) => {
      empty(body);
      return resources.testRepository(id(params));
    },
    'POST /repositories/:id/initialize': async ({ params, body }) => {
      empty(body);
      return resources.initialize(id(params));
    },
    'POST /repositories/:id/fetch': async ({ params, body }) => {
      empty(body);
      return resources.fetch(id(params));
    },
    'POST /repositories/:id/prune': async ({ params, body }) => {
      empty(body);
      return resources.prune(id(params));
    },
    'POST /repositories/:id/repair': async ({ params, body }) => {
      empty(body);
      return resources.initialize(id(params), true);
    },
    'GET /repositories/:id/refs': async ({ params }) =>
      resources.refs(id(params)),
    'GET /repositories/:id/status': async ({ params }) =>
      resources.repositoryDto(id(params)),
    'POST /repositories/:id/remote': async ({ params, body }) => {
      const input = v.object(body, ['remote_url'], ['remote_url']);
      return resources.saveRepository(
        { id: id(params), remote_url: input.remote_url },
        true,
      );
    },
    'DELETE /repositories/:id': async ({ params, body }) => {
      empty(body);
      return resources.removeRepository(id(params));
    },
  };
}
