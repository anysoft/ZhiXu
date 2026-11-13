import { BackupError } from '../backup/files';
import { errorCode as workspaceErrorCode } from '../workspaceV2/errors';

/** Preserve the backup barrier's typed pause errors at the candidate boundary. */
export function errorCode(error: unknown): string {
  if (error instanceof BackupError && /^[A-Z][A-Z0-9_]+$/.test(error.code))
    return error.code;
  return workspaceErrorCode(error);
}
