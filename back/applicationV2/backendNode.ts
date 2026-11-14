/** Backend security floor; managed Task runtimes have separate identities. */
export function assertV2BackendNode(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('BACKEND_NODE_VERSION_UNSUPPORTED');
  const [major, minor, patch] = version.split('.').map(Number);
  if (
    !(
      (major === 22 && (minor > 23 || (minor === 23 && patch >= 5))) ||
      (major === 24 && (minor > 22 || (minor === 22 && patch >= 3)))
    )
  )
    throw new Error('BACKEND_NODE_VERSION_UNSUPPORTED');
}
