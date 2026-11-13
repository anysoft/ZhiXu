import fs from 'fs/promises';
import path from 'path';
import { FileHandle } from 'fs/promises';
import { createHash } from 'crypto';
import { PlatformBackupBarrier } from '../backup/barrier';
import { BackupError } from '../backup/files';
import {
  inheritedLeaseFds,
  withInheritedLease,
} from '../backup/inheritedLeases';
import RuntimePathResolver from '../runtimePaths';
import { RuntimeCommand, RuntimeLease } from '../runtimeProcess';
import { errorCode, fail, positiveId } from './errors';
import { WorkspaceRootResolver } from './roots';

class WorkspaceLockPaths extends RuntimePathResolver {
  constructor(
    dataRoot: string,
    private readonly kind: 'workspace' | 'repository',
  ) {
    super(dataRoot);
  }
  async lock(id: number) {
    const directory = await new WorkspaceRootResolver(this.dataRoot).directory(
      '.locks',
      true,
    );
    return path.join(directory, `${this.kind}-${positiveId(id)}.lock`);
  }
}

/** A real FD-backed POSIX lease. Its callback lifetime includes backup admission. */
export class WorkspaceLease {
  readonly resourceKey: string;
  readonly processLeaseFds: number[];
  readonly handle: FileHandle;
  constructor(
    readonly workspaceId: number,
    readonly operation: string,
    readonly lockPath: string,
    private readonly lease: RuntimeLease,
  ) {
    this.handle = lease.handle;
    this.resourceKey = createHash('sha256')
      .update(`workspace:${workspaceId}`)
      .digest('hex');
    this.processLeaseFds = [
      ...new Set([this.handle.fd, ...inheritedLeaseFds()]),
    ];
  }
  async assertHeld() {
    const stat = await this.handle.stat();
    const named = await fs.lstat(this.lockPath);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      named.dev !== stat.dev ||
      named.ino !== stat.ino ||
      named.isSymbolicLink()
    )
      fail('WORKSPACE_RECOVERY_REQUIRED');
  }
  async run(
    program: string,
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
    timeoutSeconds = 30,
  ): Promise<string> {
    await this.assertHeld();
    const command = new RuntimeCommand(
      this.lease,
      timeoutSeconds,
      async () => undefined,
    );
    return command.run(program, args, cwd, environment, true);
  }
}

/** No v9 Worktree key is changed; these locks protect only isolated v2 roots. */
export class WorkspaceLeaseService {
  constructor(
    readonly dataRoot: string,
    readonly barrier: PlatformBackupBarrier,
  ) {}
  private async withResource<T>(
    kind: 'workspace' | 'repository',
    id: number,
    operation: string,
    action: (lease: WorkspaceLease) => Promise<T>,
  ): Promise<T> {
    positiveId(id);
    try {
      return await this.barrier.mutation(async () => {
        const paths = new WorkspaceLockPaths(this.dataRoot, kind);
        const lockPath = await paths.lock(id);
        let lease: RuntimeLease;
        try {
          lease = await RuntimeLease.acquire(paths, id);
        } catch (error: unknown) {
          if (errorCode(error) === 'RUNTIME_BUSY') fail('WORKSPACE_BUSY');
          throw error;
        }
        try {
          return await withInheritedLease(lease.handle.fd, async () => {
            const resource = new WorkspaceLease(id, operation, lockPath, lease);
            await resource.assertHeld();
            return action(resource);
          });
        } finally {
          await lease.release();
        }
      });
    } catch (error: unknown) {
      if (error instanceof BackupError) fail(error.code);
      throw error;
    }
  }
  withWorkspace<T>(
    id: number,
    operation: string,
    action: (lease: WorkspaceLease) => Promise<T>,
  ) {
    return this.withResource('workspace', id, operation, action);
  }
  withRepository<T>(
    id: number,
    operation: string,
    action: (lease: WorkspaceLease) => Promise<T>,
  ) {
    return this.withResource('repository', id, operation, action);
  }
  async probeWorkspace(id: number): Promise<{ busy: boolean }> {
    try {
      await this.withWorkspace(id, 'PROBE', async () => undefined);
      return { busy: false };
    } catch (error: unknown) {
      if (errorCode(error) === 'WORKSPACE_BUSY') return { busy: true };
      throw error;
    }
  }
}
