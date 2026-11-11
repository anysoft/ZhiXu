/** A JWT payload is a hint for wording only; the server decides validity. */
export function authFailureMessage(
  token: string | null,
  now = Date.now(),
): string {
  if (!token) return 'ui.auth.loginRequired';
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(
        atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, '=')),
      );
      if (
        typeof payload.exp === 'number' &&
        Number.isFinite(payload.exp) &&
        payload.exp * 1000 <= now
      )
        return 'ui.auth.expired';
    }
  } catch {}
  return 'ui.auth.invalid';
}

export function unauthorizedDecision(input: {
  pathname: string;
  publicRequest: boolean;
  loginRequest: boolean;
  requestToken: string | null;
  currentToken: string | null;
}) {
  const { pathname, publicRequest, loginRequest, requestToken, currentToken } =
    input;
  if (pathname.replace(/\/$/, '') === '/initialization') return null;
  if (loginRequest)
    return { reason: 'ui.auth.loginRejected', clear: false, redirect: false };
  if (publicRequest || requestToken !== currentToken) return null;
  if (!requestToken && pathname === '/login') return null;
  return {
    reason: authFailureMessage(requestToken),
    clear: Boolean(requestToken),
    redirect: pathname !== '/login',
  };
}
