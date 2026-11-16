import fs from 'fs/promises';
import path from 'path';
import { WorkspaceStore } from './store';
import { WorkspaceRootResolver } from './roots';
import {
  hashWorkspaceRecords,
  scanWorkspace,
  OWNER_MARKER,
  relativeWorkspacePath,
} from './inventory';
import type { InventoryEntry } from './types';
import type { WorkspaceManifestEntry } from './manifest';
import {
  WorkspaceGitAdapter,
  WorkspaceGitAccessResolver,
} from '../gitWorkspaceV2/git';
import {
  openRegular,
  privateDirectory,
  privateJson,
  readJson,
  writeAll,
} from '../backup/files';
import { fail } from './errors';

export interface LightweightGitOptions {
  accessResolver?: WorkspaceGitAccessResolver;
  gitToolsRoot?: string;
}
export interface LightweightGitMetadata {
  version: 1;
  repositories: {
    repository_id: number;
    remote_url: string;
    base_commits: string[];
    refs: { name: string; oid: string }[];
    symbolic_head: string | null;
    detached_head: string | null;
    bundle: string | null;
  }[];
  workspaces: {
    workspace_id: number;
    repository_id: number;
    storage_key: string;
    head: string;
    ref_type: 'branch' | 'tag' | 'commit';
    ref_name: string;
    private_branch: string | null;
    index_patch: string | null;
    working_patch: string | null;
    untracked_root: string;
    marker: string;
    inventory: InventoryEntry[];
    inventory_hash: string;
    excluded_paths: string[];
  }[];
}

const oid = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const refName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.startsWith('refs/') &&
  !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) &&
  !value.includes('..') &&
  !value.includes('@{') &&
  !value.includes('//') &&
  !value.endsWith('/') &&
  !value.endsWith('.lock');
const regenerable = new Set([
  'node_modules',
  '__pycache__',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  'coverage',
  '.pnpm-store',
  'build',
  'dist',
]);
const asObject = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function payloadError(): never {
  return fail('BACKUP_LIGHTWEIGHT_INVALID');
}

async function copyFile(
  source: string,
  target: string,
  expected?: InventoryEntry,
) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const input = await openRegular(source, false),
    output = await fs.open(target, 'wx', 0o600);
  try {
    const stat = await input.stat();
    if (expected && stat.size !== expected.size) payloadError();
    for await (const chunk of input.createReadStream({ autoClose: false }))
      await writeAll(output, chunk as Buffer);
    await output.sync();
  } finally {
    await input.close();
    await output.close();
  }
}

function filteredInventory(
  entry: WorkspaceManifestEntry,
  ignored: Set<string>,
): { inventory: InventoryEntry[]; excluded_paths: string[] } {
  const protectedHistory =
    entry.preservation_holds.some(
      (hold) => asObject(hold) && hold.released_at === null,
    ) ||
    entry.source_references.some(
      (source) => source.availability === 'RETIRED_MISSING_EXPECTED',
    );
  const protectedPaths = entry.source_references.map(
    (source) => source.relative_entrypoint,
  );
  const omitted = new Set<string>();
  if (!protectedHistory)
    for (const file of entry.content_inventory) {
      if (file.kind !== 'file' || !ignored.has(file.path)) continue;
      const parts = file.path.split('/');
      const at = parts.findIndex((part) => regenerable.has(part));
      if (at < 0) continue;
      const prefix = parts.slice(0, at + 1).join('/');
      if (
        protectedPaths.some((p) => p === prefix || p.startsWith(prefix + '/'))
      )
        continue;
      omitted.add(file.path);
    }
  const keptFiles = entry.content_inventory.filter(
    (item) => item.kind === 'file' && !omitted.has(item.path),
  );
  const inventory = entry.content_inventory.filter((item) => {
    if (item.kind === 'file') return !omitted.has(item.path);
    if (keptFiles.some((file) => file.path.startsWith(item.path + '/')))
      return true;
    if ([...omitted].some((file) => file.startsWith(item.path + '/'))) {
      omitted.add(item.path);
      return false;
    }
    return true; // Existing empty user directories remain part of the Workspace.
  });
  return { inventory, excluded_paths: [...omitted].sort() };
}

/** Git-native deltas; backup orchestration, encryption and publication stay in the existing engine. */
export class LightweightGitService {
  private readonly git: WorkspaceGitAdapter;
  constructor(
    readonly store: WorkspaceStore,
    readonly options: LightweightGitOptions = {},
  ) {
    this.git = new WorkspaceGitAdapter(
      store,
      new WorkspaceRootResolver(store.dataRoot),
      options,
    );
  }

  async fullWarnings(entries: WorkspaceManifestEntry[]): Promise<string[]> {
    const warnings = new Set<string>();
    for (const entry of entries) {
      if (entry.workspace_type !== 'GIT' || entry.storage_state !== 'PRESENT')
        continue;
      const root = path.join(this.store.dataRoot, entry.storage_key);
      await this.git.withCommands([], {}, async (run) => {
        const index = (await run(['ls-files', '--stage', '-z'], root)).stdout;
        if (index.split('\0').some((line) => /^160000 /.test(line)))
          warnings.add('FULL_GIT_SUBMODULE_EXTERNAL_DATA_WARNING');
      });
      for (const record of entry.content_inventory) {
        if (record.kind !== 'file') continue;
        if (path.posix.basename(record.path) === '.gitattributes') {
          const text = await fs.readFile(path.join(root, record.path), 'utf8');
          if (/(?:^|\s)filter\s*=\s*lfs(?:\s|$)/m.test(text))
            warnings.add('FULL_GIT_LFS_EXTERNAL_DATA_WARNING');
        } else if (record.size > 0 && record.size < 1024) {
          const file = await openRegular(path.join(root, record.path), false);
          try {
            const first = Buffer.alloc(80);
            await file.read(first, 0, first.length, 0);
            if (
              first
                .toString()
                .startsWith('version https://git-lfs.github.com/spec/v1\n')
            )
              warnings.add('FULL_GIT_LFS_EXTERNAL_DATA_WARNING');
          } finally {
            await file.close();
          }
        }
      }
    }
    return [...warnings].sort();
  }

  async capture(
    payloadRoot: string,
    entries: WorkspaceManifestEntry[],
  ): Promise<LightweightGitMetadata> {
    await privateDirectory(payloadRoot, true);
    if ((await this.fullWarnings(entries)).length)
      fail('BACKUP_LIGHTWEIGHT_EXTERNAL_GIT_UNSUPPORTED');
    const metadata: LightweightGitMetadata = {
      version: 1,
      repositories: [],
      workspaces: [],
    };
    const repositories = await this.store.all<{
      id: number;
      remote_url: string;
    }>(
      "SELECT id,remote_url FROM Repositories WHERE storage_state='READY' ORDER BY id",
    );
    for (const repository of repositories) {
      const bare = path.join(
        this.store.dataRoot,
        `git/repository-${repository.id}.git`,
      );
      const related = entries.filter(
        (entry) => entry.git?.repository_id === repository.id,
      );
      const details = await this.git.withCommands([], {}, async (run) => {
        const refs = (
          await run(
            [
              '--git-dir',
              bare,
              'for-each-ref',
              '--format=%(refname) %(objectname)',
            ],
            bare,
          )
        ).stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [name, object] = line.split(' ');
            if (!refName(name) || !oid(object)) payloadError();
            return { name, oid: object };
          });
        const bases = new Set(
          refs
            .filter((ref) => ref.name.startsWith('refs/remotes/origin/'))
            .map((ref) => ref.oid),
        );
        for (const entry of related)
          if (entry.git) bases.add(entry.git.resolved_commit);
        const symbolic = await run(
          ['--git-dir', bare, 'symbolic-ref', '-q', 'HEAD'],
          bare,
          undefined,
          true,
        );
        const detached = symbolic.code
          ? (
              await run(
                ['--git-dir', bare, 'rev-parse', '--verify', 'HEAD'],
                bare,
              )
            ).stdout.trim()
          : null;
        return {
          refs,
          bases,
          symbolic_head: symbolic.code ? null : symbolic.stdout.trim(),
          detached_head: detached,
        };
      });
      if (!details.bases.size) {
        // An unused freshly cloned bare repository may not yet have origin/*.
        // Confirm an advertised local base rather than guessing which heads are unpublished.
        try {
          await this.git.withRemoteCommands(
            repository.id,
            {},
            async (run, remote) => {
              const result = await run(
                ['ls-remote', '--heads', '--tags', '--', remote],
                bare,
                true,
              );
              if (result.code)
                fail('BACKUP_LIGHTWEIGHT_REMOTE_BASE_UNAVAILABLE');
              const local = new Set(details.refs.map((ref) => ref.oid));
              for (const line of result.stdout.trim().split('\n')) {
                const object = line.split(/\s/)[0];
                if (oid(object) && local.has(object)) details.bases.add(object);
              }
            },
          );
        } catch {
          fail('BACKUP_LIGHTWEIGHT_REMOTE_BASE_UNAVAILABLE');
        }
        if (!details.bases.size)
          fail('BACKUP_LIGHTWEIGHT_REMOTE_BASE_UNAVAILABLE');
      }
      let bundle: string | null = null;
      await this.git.withCommands([], {}, async (run) => {
        const exclusions = [...details.bases].map((base) => '^' + base);
        const count = await run(
          ['--git-dir', bare, 'rev-list', '--count', '--all', ...exclusions],
          bare,
        );
        if (Number(count.stdout.trim()) > 0) {
          bundle = `repository-${repository.id}.bundle`;
          await run(
            [
              '--git-dir',
              bare,
              'bundle',
              'create',
              path.join(payloadRoot, bundle),
              '--all',
              ...exclusions,
            ],
            bare,
          );
          await fs.chmod(path.join(payloadRoot, bundle), 0o600);
          await run(
            [
              '--git-dir',
              bare,
              'bundle',
              'verify',
              path.join(payloadRoot, bundle),
            ],
            bare,
          );
        }
      });
      metadata.repositories.push({
        repository_id: repository.id,
        remote_url: repository.remote_url,
        base_commits: [...details.bases].sort(),
        refs: details.refs,
        symbolic_head: details.symbolic_head,
        detached_head: details.detached_head,
        bundle,
      });
    }
    for (const entry of entries) {
      if (entry.workspace_type !== 'GIT' || entry.storage_state !== 'PRESENT')
        continue;
      if (!entry.git || !('head' in entry.git)) payloadError();
      const root = path.join(this.store.dataRoot, entry.storage_key);
      const relative = `workspace-${entry.workspace_id}`;
      await privateDirectory(path.join(payloadRoot, relative), true);
      const untracked_root = relative + '/untracked';
      await privateDirectory(path.join(payloadRoot, untracked_root), true);
      const captured = await this.git.withCommands([], {}, async (run) => {
        if ((await run(['ls-files', '--unmerged', '-z'], root)).stdout)
          fail('BACKUP_LIGHTWEIGHT_INDEX_UNSUPPORTED');
        const ignored = new Set(
          (
            await run(
              ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
              root,
            )
          ).stdout
            .split('\0')
            .filter(Boolean),
        );
        const selected = filteredInventory(entry, ignored);
        const tracked = new Set(
          (await run(['ls-files', '--cached', '-z'], root)).stdout
            .split('\0')
            .filter(Boolean),
        );
        const patches: {
          index_patch: string | null;
          working_patch: string | null;
        } = { index_patch: null, working_patch: null };
        for (const [key, args, name] of [
          ['index_patch', ['--cached', 'HEAD'], 'index.patch'],
          ['working_patch', [], 'working.patch'],
        ] as const) {
          const file = relative + '/' + name;
          await run(
            [
              'diff',
              ...args,
              '--binary',
              '--full-index',
              '--no-ext-diff',
              '--no-textconv',
              '--output=' + path.join(payloadRoot, file),
              '--',
            ],
            root,
          );
          if ((await fs.stat(path.join(payloadRoot, file))).size) {
            await fs.chmod(path.join(payloadRoot, file), 0o600);
            patches[key] = file;
          } else await fs.unlink(path.join(payloadRoot, file));
        }
        return { ...selected, ...patches, tracked };
      });
      for (const file of captured.inventory)
        if (file.kind === 'file' && !captured.tracked.has(file.path))
          await copyFile(
            path.join(root, file.path),
            path.join(payloadRoot, untracked_root, file.path),
            file,
          );
      const marker = relative + '/owner.json';
      await privateJson(
        path.join(payloadRoot, marker),
        await readJson(path.join(root, OWNER_MARKER)),
      );
      metadata.workspaces.push({
        workspace_id: entry.workspace_id,
        repository_id: entry.git.repository_id,
        storage_key: entry.storage_key,
        head: entry.git.head,
        ref_type: entry.git.ref_type,
        ref_name: entry.git.ref_name,
        private_branch: entry.git.private_branch,
        index_patch: captured.index_patch,
        working_patch: captured.working_patch,
        untracked_root,
        marker,
        inventory: captured.inventory,
        inventory_hash: hashWorkspaceRecords(captured.inventory),
        excluded_paths: captured.excluded_paths,
      });
    }
    await this.validate(payloadRoot, metadata, entries);
    return metadata;
  }

  async validate(
    payloadRoot: string,
    input: unknown,
    entries: WorkspaceManifestEntry[],
  ): Promise<void> {
    if (
      !asObject(input) ||
      input.version !== 1 ||
      !Array.isArray(input.repositories) ||
      !Array.isArray(input.workspaces)
    )
      payloadError();
    const metadata = input as unknown as LightweightGitMetadata;
    const repositories = await this.store.all<{
      id: number;
      remote_url: string;
    }>(
      "SELECT id,remote_url FROM Repositories WHERE storage_state='READY' ORDER BY id",
    );
    if (
      repositories.length !== metadata.repositories.length ||
      metadata.repositories.length > 20000
    )
      payloadError();
    const ids = new Set<number>();
    for (const item of metadata.repositories) {
      if (
        !asObject(item) ||
        !positive(item.repository_id) ||
        ids.has(item.repository_id) ||
        !repositories.some(
          (repo) =>
            repo.id === item.repository_id &&
            repo.remote_url === item.remote_url,
        )
      )
        payloadError();
      ids.add(item.repository_id);
      if (
        !Array.isArray(item.base_commits) ||
        !item.base_commits.length ||
        item.base_commits.some((base) => !oid(base)) ||
        !Array.isArray(item.refs) ||
        item.refs.length > 20000
      )
        payloadError();
      const names = new Set<string>();
      for (const ref of item.refs) {
        if (
          !asObject(ref) ||
          !refName(ref.name) ||
          !oid(ref.oid) ||
          names.has(ref.name)
        )
          payloadError();
        names.add(ref.name);
      }
      if (item.symbolic_head !== null && !refName(item.symbolic_head))
        payloadError();
      if (item.detached_head !== null && !oid(item.detached_head))
        payloadError();
      if (item.bundle !== null) {
        if (item.bundle !== `repository-${item.repository_id}.bundle`)
          payloadError();
        const file = await openRegular(path.join(payloadRoot, item.bundle));
        try {
          const header = Buffer.alloc(16);
          await file.read(header, 0, header.length, 0);
          if (!/^# v[23] git bundle\n/.test(header.toString())) payloadError();
        } finally {
          await file.close();
        }
      }
    }
    const expected = entries.filter(
      (entry) =>
        entry.workspace_type === 'GIT' && entry.storage_state === 'PRESENT',
    );
    if (metadata.workspaces.length !== expected.length) payloadError();
    ids.clear();
    for (const item of metadata.workspaces) {
      const prior = expected.find(
        (entry) => entry.workspace_id === item.workspace_id,
      );
      if (
        !asObject(item) ||
        !positive(item.workspace_id) ||
        ids.has(item.workspace_id) ||
        !prior?.git ||
        !('head' in prior.git)
      )
        payloadError();
      ids.add(item.workspace_id);
      if (
        item.repository_id !== prior.git.repository_id ||
        item.storage_key !== prior.storage_key ||
        item.head !== prior.git.head ||
        item.ref_type !== prior.git.ref_type ||
        item.ref_name !== prior.git.ref_name ||
        item.private_branch !== prior.git.private_branch ||
        !oid(item.head)
      )
        payloadError();
      if (
        !Array.isArray(item.inventory) ||
        !Array.isArray(item.excluded_paths) ||
        item.inventory.length > 20000
      )
        payloadError();
      const paths = new Set<string>();
      for (const file of item.inventory) {
        if (!asObject(file) || typeof file.path !== 'string') payloadError();
        relativeWorkspacePath(file.path);
        if (
          paths.has(file.path) ||
          !prior.content_inventory.some(
            (saved) => JSON.stringify(saved) === JSON.stringify(file),
          )
        )
          payloadError();
        paths.add(file.path);
      }
      const excluded = prior.content_inventory
        .filter((file) => !paths.has(file.path))
        .map((file) => file.path)
        .sort();
      if (
        JSON.stringify(excluded) !== JSON.stringify(item.excluded_paths) ||
        hashWorkspaceRecords(item.inventory) !== item.inventory_hash
      )
        payloadError();
      for (const source of prior.source_references)
        if (
          source.availability === 'PRESENT' &&
          !paths.has(source.relative_entrypoint)
        )
          payloadError();
      const relative = `workspace-${item.workspace_id}`;
      if (
        item.marker !== relative + '/owner.json' ||
        item.untracked_root !== relative + '/untracked'
      )
        payloadError();
      const marker = await readJson(path.join(payloadRoot, item.marker));
      if (
        marker.workspace_id !== item.workspace_id ||
        marker.root_key !== item.storage_key ||
        marker.type !== 'GIT' ||
        marker.owner_token !== prior.root_identity.owner_token
      )
        payloadError();
      for (const key of ['index_patch', 'working_patch'] as const) {
        const value = item[key];
        if (value === null) continue;
        if (
          value !==
          relative +
            '/' +
            (key === 'index_patch' ? 'index.patch' : 'working.patch')
        )
          payloadError();
        const file = await openRegular(path.join(payloadRoot, value));
        await file.close();
      }
      const untracked = await scanWorkspace(
        path.join(payloadRoot, item.untracked_root),
        'LOCAL',
      );
      for (const file of untracked.entries) {
        const saved = item.inventory.find(
          (entry) => entry.path === file.path && entry.kind === file.kind,
        );
        if (!saved || saved.size !== file.size || saved.sha256 !== file.sha256)
          payloadError();
      }
    }
  }

  async rebuild(
    payloadRoot: string,
    metadata: LightweightGitMetadata,
  ): Promise<void> {
    const dataRoot = this.store.dataRoot;
    for (const repository of metadata.repositories) {
      const bare = path.join(
        dataRoot,
        `git/repository-${repository.repository_id}.git`,
      );
      await privateDirectory(path.dirname(bare), true);
      if (await fs.lstat(bare).catch(() => null))
        fail('RESTORE_LIGHTWEIGHT_CANDIDATE_NOT_EMPTY');
      await this.git.withCommands([], {}, async (run) => {
        await run(
          [
            'init',
            '--bare',
            '--object-format=' +
              (repository.base_commits[0].length === 64 ? 'sha256' : 'sha1'),
            bare,
          ],
          dataRoot,
        );
      });
      try {
        await this.git.withRemoteCommands(
          repository.repository_id,
          {
            workspaceId: metadata.workspaces.find(
              (entry) => entry.repository_id === repository.repository_id,
            )?.workspace_id,
          },
          async (run, remote) => {
            const result = await run(
              [
                '--git-dir',
                bare,
                'fetch',
                '--atomic',
                '--no-tags',
                '--no-recurse-submodules',
                '--no-write-fetch-head',
                '--',
                remote,
                '+refs/heads/*:refs/remotes/origin/*',
                '+refs/tags/*:refs/tags/*',
              ],
              bare,
              true,
            );
            if (result.code)
              fail('RESTORE_LIGHTWEIGHT_REMOTE_UNAVAILABLE_USE_FULL');
            for (const base of repository.base_commits) {
              const found = await run(
                ['--git-dir', bare, 'cat-file', '-e', base + '^{commit}'],
                bare,
                true,
              );
              if (!found.code) continue;
              const fetched = await run(
                [
                  '--git-dir',
                  bare,
                  'fetch',
                  '--no-recurse-submodules',
                  '--no-write-fetch-head',
                  '--',
                  remote,
                  base,
                ],
                bare,
                true,
              );
              if (
                fetched.code ||
                (
                  await run(
                    ['--git-dir', bare, 'cat-file', '-e', base + '^{commit}'],
                    bare,
                    true,
                  )
                ).code
              )
                fail('RESTORE_LIGHTWEIGHT_BASE_MISSING_USE_FULL');
            }
          },
        );
      } catch (error) {
        const code = (error as { error_code?: string }).error_code;
        if (code?.startsWith('RESTORE_LIGHTWEIGHT_')) throw error;
        fail('RESTORE_LIGHTWEIGHT_REMOTE_UNAVAILABLE_USE_FULL');
      }
      await this.git.withCommands([], {}, async (run) => {
        if (repository.bundle) {
          const bundle = path.join(payloadRoot, repository.bundle);
          await run(['--git-dir', bare, 'bundle', 'verify', bundle], bare);
          await run(
            [
              '--git-dir',
              bare,
              'fetch',
              '--no-write-fetch-head',
              '--',
              bundle,
              '+refs/*:refs/*',
            ],
            bare,
          );
        }
        for (const ref of repository.refs)
          await run(['--git-dir', bare, 'update-ref', ref.name, ref.oid], bare);
        if (repository.symbolic_head)
          await run(
            [
              '--git-dir',
              bare,
              'symbolic-ref',
              'HEAD',
              repository.symbolic_head,
            ],
            bare,
          );
        else if (repository.detached_head)
          await run(
            [
              '--git-dir',
              bare,
              'update-ref',
              '--no-deref',
              'HEAD',
              repository.detached_head,
            ],
            bare,
          );
        await run(['--git-dir', bare, 'fsck', '--full', '--no-dangling'], bare);
      });
      await this.store.run(
        'UPDATE Repositories SET storage_path=? WHERE id=?',
        [bare, repository.repository_id],
      );
    }
    for (const item of metadata.workspaces) {
      const root = path.join(dataRoot, item.storage_key);
      await privateDirectory(path.dirname(root), true);
      if (await fs.lstat(root).catch(() => null))
        fail('RESTORE_LIGHTWEIGHT_CANDIDATE_NOT_EMPTY');
      const bare = path.join(
        dataRoot,
        `git/repository-${item.repository_id}.git`,
      );
      await this.git.withCommands([], {}, async (run) => {
        const args = item.private_branch
          ? ['--force', root, item.private_branch]
          : ['--detach', root, item.head];
        await run(['--git-dir', bare, 'worktree', 'add', ...args], dataRoot);
        await fs.chmod(root, 0o700);
        const actual = (
          await run(['rev-parse', '--verify', 'HEAD'], root)
        ).stdout.trim();
        if (actual !== item.head) fail('RESTORE_LIGHTWEIGHT_HEAD_MISMATCH');
        if (item.index_patch)
          await run(
            [
              'apply',
              '--index',
              '--binary',
              '--whitespace=nowarn',
              path.join(payloadRoot, item.index_patch),
            ],
            root,
          );
        if (item.working_patch)
          await run(
            [
              'apply',
              '--binary',
              '--whitespace=nowarn',
              path.join(payloadRoot, item.working_patch),
            ],
            root,
          );
      });
      await privateJson(
        path.join(root, OWNER_MARKER),
        await readJson(path.join(payloadRoot, item.marker)),
      );
      const untracked = await scanWorkspace(
        path.join(payloadRoot, item.untracked_root),
        'LOCAL',
      );
      for (const file of untracked.entries)
        if (file.kind === 'file')
          await copyFile(
            path.join(payloadRoot, item.untracked_root, file.path),
            path.join(root, file.path),
          );
      for (const entry of item.inventory)
        if (entry.kind === 'directory') {
          await fs.mkdir(path.join(root, entry.path), {
            recursive: true,
            mode: 0o700,
          });
          await fs.chmod(path.join(root, entry.path), entry.mode);
        }
      for (const entry of item.inventory)
        if (entry.kind === 'file')
          await fs.chmod(path.join(root, entry.path), entry.mode);
      const final = await scanWorkspace(root, 'GIT');
      if (
        final.hash !== item.inventory_hash ||
        JSON.stringify(final.entries) !== JSON.stringify(item.inventory)
      )
        fail('RESTORE_LIGHTWEIGHT_INVENTORY_MISMATCH');
      const row = await this.store.workspace(item.workspace_id);
      if (row.content_inventory_hash !== final.hash)
        await this.store.run(
          'UPDATE Workspaces SET content_inventory_hash=?,file_count=?,total_bytes=?,content_revision=content_revision+1,version=version+1 WHERE id=?',
          [final.hash, final.fileCount, final.totalBytes, item.workspace_id],
        );
    }
  }
}
