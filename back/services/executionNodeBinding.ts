import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import config from '../config';
import { ExecutionContext, ExecutionError } from '../shared/execution';
import { atomicPrivateWrite, syncDirectory } from '../shared/configAssets';
import { MaterializationLease } from './configMaterialization';
import ExecutionPaths from './executionPaths';
import HookExecutor from './hookExecutor';

interface BindingJournal {
  version: 1;
  root: string;
  destination: string;
  staging: string;
  identity?: { ino: number; dev: number };
}
const stat = (file: string) =>
  fs.lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
/** Exclusive Worktree lease protects an owned, recoverable root module binding. */
export default class ExecutionNodeBinding {
  constructor(
    private paths = new ExecutionPaths(),
    private options: {
      journalPrefix?: 'worktree' | 'workspace';
      checkpoint?: (
        phase: string,
        details: Record<string, unknown>,
      ) => Promise<void>;
    } = {},
  ) {}
  private async journal(worktreeId: number) {
    return path.join(
      await this.paths.directory('tmp/execution/node-bindings', true),
      `${this.options.journalPrefix ?? 'worktree'}-${worktreeId}.json`,
    );
  }
  async recover(worktreeId: number, root: string, lease: MaterializationLease) {
    await lease.assertHeld();
    if (
      !lease.exclusive ||
      lease.resourceKey !== this.paths.resourceKey(worktreeId)
    )
      throw new ExecutionError('NODE_BINDING_LEASE_REQUIRED');
    const file = await this.journal(worktreeId);
    if (!(await stat(file))) return;
    await this.options.checkpoint?.('NODE_BEFORE_CLEANUP', {
      resourceId: worktreeId,
    });
    const journal = (await this.paths.readJson(file)) as BindingJournal;
    if (
      journal.version !== 1 ||
      journal.root !== root ||
      typeof journal.destination !== 'string' ||
      !path.isAbsolute(journal.destination) ||
      !/^\.platform-node-[a-f0-9-]{36}$/.test(journal.staging)
    )
      throw new ExecutionError('NODE_BINDING_RECOVERY_REQUIRED');
    for (const name of ['node_modules', journal.staging]) {
      const target = path.join(root, name),
        current = await stat(target);
      if (!current) continue;
      if (
        !journal.identity ||
        !current.isSymbolicLink() ||
        current.ino !== journal.identity.ino ||
        current.dev !== journal.identity.dev ||
        (await fs.readlink(target)) !== journal.destination
      )
        throw new ExecutionError('NODE_BINDING_RECOVERY_REQUIRED');
      await fs.unlink(target);
      await syncDirectory(root);
    }
    await fs.unlink(file);
    await syncDirectory(path.dirname(file));
    await this.options.checkpoint?.('NODE_CLEANUP_COMPLETE', {
      resourceId: worktreeId,
    });
  }
  async prepare(context: ExecutionContext, lease: MaterializationLease) {
    return this.prepareResource(
      context.source.worktreeId,
      context.workspace.workspaceRoot,
      context.runtime.nodeModulesRoot,
      lease,
    );
  }
  /** Generic resource entry; old Worktree callers retain their default journal/key. */
  async prepareResource(
    id: number,
    root: string,
    destination: string | undefined,
    lease: MaterializationLease,
  ) {
    await this.recover(id, root, lease);
    if (!destination) return { cleanup: async () => {} };
    // Imported local files can reside anywhere in the Worktree, not only next
    // to the entrypoint. Reject nested module trees without following symlinks.
    const pending = [root];
    while (pending.length) {
      const directory = pending.pop()!;
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        if (entry.name === 'node_modules')
          throw new ExecutionError('NODE_MODULES_CONFLICT');
        if (entry.name !== '.git' && entry.isDirectory())
          pending.push(path.join(directory, entry.name));
      }
    }
    const file = await this.journal(id),
      staging = '.platform-node-' + randomUUID();
    const journal: BindingJournal = { version: 1, root, destination, staging };
    await atomicPrivateWrite(file, JSON.stringify(journal));
    await this.options.checkpoint?.('NODE_JOURNAL_DURABLE', { resourceId: id });
    try {
      const temporary = path.join(root, staging);
      await fs.symlink(destination, temporary);
      await syncDirectory(root);
      const identity = await fs.lstat(temporary);
      journal.identity = { ino: identity.ino, dev: identity.dev };
      await atomicPrivateWrite(file, JSON.stringify(journal));
      await this.options.checkpoint?.('NODE_STAGING_DURABLE', {
        resourceId: id,
      });
      const installed = await new HookExecutor(lease.processLeaseFds ?? []).run(
        '/usr/bin/python3',
        [
          '-I',
          '-S',
          path.join(config.rootPath, 'shell/config_link.py'),
          temporary,
          path.join(root, 'node_modules'),
        ],
        root,
        { PATH: '/usr/bin:/bin' },
        5,
        async () => {},
      );
      if (installed.code !== 0)
        throw new ExecutionError('NODE_BINDING_INSTALL_FAILED');
      await fs.unlink(temporary);
      await syncDirectory(root);
      await this.options.checkpoint?.('NODE_INSTALLED', { resourceId: id });
      return { cleanup: () => this.recover(id, root, lease) };
    } catch (error) {
      await this.recover(id, root, lease);
      throw error;
    }
  }
}
