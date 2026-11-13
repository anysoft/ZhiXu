/** Errors exported by the internal foundation never include paths or raw child output. */
export class WorkspaceFoundationError extends Error {
  constructor(readonly error_code: string, readonly status = 409) {
    super(error_code);
    this.name = 'WorkspaceFoundationError';
  }
}
export function fail(code: string, status = 409): never {
  throw new WorkspaceFoundationError(code, status);
}
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'error_code' in error) {
    const value = error.error_code;
    if (typeof value === 'string' && /^[A-Z][A-Z0-9_]+$/.test(value))
      return value;
  }
  return 'WORKSPACE_OPERATION_FAILED';
}
export function positiveId(id: number) {
  if (!Number.isSafeInteger(id) || id < 1) fail('WORKSPACE_PATH_INVALID', 400);
  return id;
}
