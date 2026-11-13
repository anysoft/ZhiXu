import { createHash } from 'crypto';
import ExecutionPaths from '../executionPaths';
import { ExecutionError } from '../../shared/execution';
import { WorkspaceRootResolver } from '../workspaceV2/roots';

/** Explicit candidate root; run-owner locks remain separate from Workspace resource locks. */
export class WorkspaceExecutionPaths extends ExecutionPaths {
  constructor(dataRoot: string) {
    super(new WorkspaceRootResolver(dataRoot).dataRoot);
  }
  resourceKey(id: number) {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new ExecutionError('WORKSPACE_NOT_FOUND');
    return createHash('sha256').update(`workspace:${id}`).digest('hex');
  }
  async worktree(_id: number): Promise<never> {
    throw new ExecutionError('WORKSPACE_LEASE_REQUIRED');
  }
}
