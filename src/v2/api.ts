import { useCallback, useEffect, useRef, useState } from 'react';
export type * from '../../docs/architecture/v2/contracts/api.dto';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: any,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}
let bearer = '',
  csrf = '';
const etags = new Map<string, string>();
export const getEtag = (path: string) => etags.get(path);
export function setSession(value?: { token?: string; csrf_token?: string }) {
  bearer = value?.token || '';
  csrf = value?.csrf_token || '';
}
export function setCsrf(value: string) {
  csrf = value;
}
export const requestKey = () =>
  globalThis.crypto?.randomUUID?.() ||
  `v2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const prefix = () => `${(window as any).__ENV__QlBaseUrl || '/'}api`;
export function query(path: string, values: Record<string, any>) {
  const search = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '')
      search.set(key, String(value));
  });
  return path + (search.size ? '?' + search : '');
}
export async function call<T = any>(
  path: string,
  options: {
    method?: string;
    body?: any;
    key?: string;
    blob?: boolean;
    signal?: AbortSignal;
    ifMatch?: string;
    onMetadata?: (metadata: { etag?: string }) => void;
  } = {},
): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://'))
    throw new ApiError(400, 'INVALID_REQUEST');
  const method = options.method || 'GET',
    headers: Record<string, string> = {
      Accept: options.blob ? 'application/octet-stream' : 'application/json',
    };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (options.key) headers['Idempotency-Key'] = options.key;
  if (options.ifMatch) headers['If-Match'] = options.ifMatch;
  const multipart = options.body instanceof FormData;
  if (options.body !== undefined && !multipart)
    headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(prefix() + path, {
      method,
      headers,
      body:
        options.body === undefined
          ? undefined
          : multipart
          ? options.body
          : JSON.stringify(options.body),
      credentials: 'omit',
      signal: options.signal,
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK_ERROR');
  }
  if (options.blob && response.ok) return (await response.blob()) as T;
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || ![200, 202].includes(result.code)) {
    const raw = result?.error_code || result?.message;
    throw new ApiError(
      response.status,
      typeof raw === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(raw)
        ? raw
        : response.status === 401
        ? 'AUTHENTICATION_REQUIRED'
        : response.status === 403
        ? 'PANEL_SESSION_REQUIRED'
        : 'REQUEST_FAILED',
      result?.details,
    );
  }
  if (response.headers.get('ETag'))
    etags.set(path, response.headers.get('ETag')!);
  options.onMetadata?.({ etag: response.headers.get('ETag') || undefined });
  return result.data;
}
export const list = <T = any>(value: any): T[] =>
  Array.isArray(value) ? value : value?.items || [];
export function useResource<T = any>(path: string | null, poll = 0) {
  const [data, setData] = useState<T>(),
    [etag, setEtag] = useState<string>(),
    [error, setError] = useState<any>(),
    [loading, setLoading] = useState(false);
  const pending = useRef<{ path: string; promise: Promise<T | undefined> }>(),
    epoch = useRef(0),
    responsePath = useRef<string | null>(),
    current = useRef(path);
  current.current = path;
  const reload = useCallback(
    async (fresh = true) => {
      if (!path) {
        setData(undefined);
        setError(undefined);
        setLoading(false);
        return;
      }
      if (current.current !== path) return;
      while (pending.current?.path === path) {
        if (!fresh) return pending.current.promise;
        await pending.current.promise;
        if (current.current !== path) return;
      }
      const selected = ++epoch.current;
      setLoading(true);
      const operation = (async () => {
        try {
          let responseEtag: string | undefined;
          const value = await call<T>(path, {
            onMetadata: (metadata) => {
              responseEtag = metadata.etag;
            },
          });
          if (selected === epoch.current && current.current === path) {
            setData(value);
            responsePath.current = path;
            setEtag(responseEtag);
            setError(undefined);
          }
          return value;
        } catch (failure) {
          if (selected === epoch.current && current.current === path) {
            responsePath.current = path;
            setError(failure);
          }
        } finally {
          if (selected === epoch.current) pending.current = undefined;
          if (selected === epoch.current && current.current === path)
            setLoading(false);
        }
      })();
      pending.current = { path, promise: operation };
      return operation;
    },
    [path],
  );
  useEffect(() => {
    current.current = path;
    setData(undefined);
    setEtag(undefined);
    setError(undefined);
    void reload();
    const timer = poll
      ? setInterval(() => void reload(false), poll)
      : undefined;
    return () => {
      epoch.current++;
      current.current = null;
      pending.current = undefined;
      if (timer) clearInterval(timer);
    };
  }, [reload, poll]);
  const own = responsePath.current === path;
  return {
    data: own ? data : undefined,
    error: own ? error : undefined,
    etag: own ? etag : undefined,
    loading,
    reload,
    setData,
  };
}
export function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<any>();
  const executing = useRef(false);
  const run = async <T>(action: () => Promise<T>) => {
    if (executing.current) return undefined;
    executing.current = true;
    setBusy(true);
    setError(undefined);
    try {
      return await action();
    } catch (failure) {
      setError(failure);
      return undefined;
    } finally {
      executing.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}
