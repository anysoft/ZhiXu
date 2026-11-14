/** Public authority is configured explicitly; request headers never select it. */
export function normalizeV2PublicOrigin(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 2048)
    throw new Error('STARTUP_PUBLIC_ORIGIN_INVALID');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('STARTUP_PUBLIC_ORIGIN_INVALID');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    ['0.0.0.0', '[::]'].includes(parsed.hostname) ||
    (value !== parsed.origin && value !== parsed.origin + '/')
  )
    throw new Error('STARTUP_PUBLIC_ORIGIN_INVALID');
  return parsed.origin;
}
