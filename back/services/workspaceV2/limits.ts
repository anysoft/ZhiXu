import { fail } from './errors';

/** Candidate deployment budgets; actual enforcement is server-side in each component. */
export interface WorkspaceLimits {
  maxSourceFileBytes: number;
  editTextMaxBytes: number;
  viewTextMaxBytes: number;
  maxWorkspaceBytes: number;
  maxWorkspaceEntries: number;
  maxDirectoryDepth: number;
  maxRelativePathBytes: number;
  searchMaxEntries: number;
  searchMaxBytes: number;
  searchMaxFileBytes: number;
  searchMaxMatches: number;
  searchDeadlineMs: number;
  inventoryDeadlineMs: number;
  backupSnapshotBytes: number;
  backupRetainedBytes: number;
  temporaryMaxBytes: number;
  minimumFreeBytes: number;
  archiveDrainTimeoutMs: number;
}
export const DEFAULT_LIMITS: Readonly<WorkspaceLimits> = Object.freeze({
  maxSourceFileBytes: 64 * 1024 * 1024,
  editTextMaxBytes: 2 * 1024 * 1024,
  viewTextMaxBytes: 10 * 1024 * 1024,
  maxWorkspaceBytes: 1024 * 1024 * 1024,
  maxWorkspaceEntries: 20_000,
  maxDirectoryDepth: 64,
  maxRelativePathBytes: 4096,
  searchMaxEntries: 10_000,
  searchMaxBytes: 32 * 1024 * 1024,
  searchMaxFileBytes: 256 * 1024,
  searchMaxMatches: 200,
  searchDeadlineMs: 3000,
  inventoryDeadlineMs: 30_000,
  backupSnapshotBytes: 16 * 1024 * 1024 * 1024,
  backupRetainedBytes: 64 * 1024 * 1024 * 1024,
  temporaryMaxBytes: 32 * 1024 * 1024 * 1024,
  minimumFreeBytes: 2 * 1024 * 1024 * 1024,
  archiveDrainTimeoutMs: 300_000,
});
export function workspaceLimits(
  input: Partial<WorkspaceLimits> = {},
): WorkspaceLimits {
  const result = { ...DEFAULT_LIMITS, ...input };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1)
      fail('WORKSPACE_QUOTA_EXCEEDED', 422);
    // Isolated component options may lower budgets; increasing reviewed ceilings
    // needs an explicit future capacity/configuration change, not a request field.
    const limit = DEFAULT_LIMITS[key as keyof WorkspaceLimits];
    if (value > limit) fail('WORKSPACE_QUOTA_EXCEEDED', 422);
  }
  return result;
}
