import fs from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { randomUUID } from 'crypto';
import { Readable, Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { HttpProxyAgent, HttpsProxyAgent } from 'hpagent';
import { XMLParser } from 'fast-xml-parser';
import { BackupError, openRegular } from './files';
import type { ProxySelection } from '../proxyManagement';

export interface RemoteTarget {
  id: string;
  name: string;
  type: 'S3' | 'WEBDAV';
  enabled: boolean;
  endpoint: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  access_key_id?: string;
  secret_access_key?: string;
  session_token?: string;
  path_style?: boolean;
  username?: string;
  password?: string;
  directory?: string;
  proxy?: ProxySelection;
}
export interface RemoteObject {
  key: string;
  size: number;
  last_modified: string | null;
}
export interface RemoteBackupStorage {
  testConnection(): Promise<void>;
  upload(
    key: string,
    file: string,
    onProgress?: (bytes: number) => void,
  ): Promise<RemoteObject>;
  download(key: string, file: string): Promise<RemoteObject>;
  list(): Promise<RemoteObject[]>;
  stat(key: string): Promise<RemoteObject | null>;
  delete(key: string): Promise<void>;
  close(): void;
}
function remoteError(error: any): BackupError {
  if (error instanceof BackupError) return error;
  const code = error?.$metadata?.httpStatusCode ?? error?.statusCode;
  return new BackupError(
    code === 401 || code === 403
      ? 'BACKUP_REMOTE_AUTHENTICATION_FAILED'
      : code === 404
      ? 'BACKUP_REMOTE_NOT_FOUND'
      : code >= 500 ||
        ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'].includes(
          error?.code,
        )
      ? 'BACKUP_REMOTE_UNAVAILABLE'
      : 'BACKUP_REMOTE_REQUEST_FAILED',
  );
}
function segments(value: string, optional = false) {
  if (optional && !value) return [];
  if (!value || value.length > 2048 || /[\\\x00-\x1f\x7f]/.test(value))
    throw new BackupError('BACKUP_REMOTE_PATH_INVALID');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new BackupError('BACKUP_REMOTE_PATH_INVALID');
  return parts;
}
function endpoint(value: string) {
  const u = new URL(value);
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new BackupError('BACKUP_REMOTE_TARGET_INVALID');
  return u;
}
/** External CLI configuration and persisted targets share these checks. Secrets stay input-only. */
export function validateRemoteTarget(input: unknown): RemoteTarget {
  const v = input as Record<string, any>;
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new BackupError('BACKUP_REMOTE_TARGET_INVALID');
  const allowed = [
    'id',
    'name',
    'type',
    'enabled',
    'endpoint',
    'region',
    'bucket',
    'prefix',
    'access_key_id',
    'secret_access_key',
    'session_token',
    'path_style',
    'username',
    'password',
    'directory',
    'proxy',
  ];
  if (Object.keys(v).some((k) => !allowed.includes(k)))
    throw new BackupError('BACKUP_REMOTE_TARGET_INVALID');
  const target: RemoteTarget = {
    id: 'external',
    name: 'External',
    enabled: true,
    ...v,
  } as RemoteTarget;
  for (const key of allowed.filter(
    (k) => !['enabled', 'path_style', 'proxy'].includes(k),
  )) {
    const value = (target as any)[key];
    if (
      value !== undefined &&
      (typeof value !== 'string' ||
        value.length > 4096 ||
        /[\x00-\x1f\x7f]/.test(value))
    )
      throw new BackupError('BACKUP_REMOTE_TARGET_INVALID');
  }
  if (
    !target.id ||
    !target.name ||
    !['S3', 'WEBDAV'].includes(target.type) ||
    typeof target.enabled !== 'boolean' ||
    typeof target.endpoint !== 'string' ||
    !target.endpoint
  )
    throw new BackupError('BACKUP_REMOTE_TARGET_INVALID');
  try {
    endpoint(target.endpoint);
  } catch {
    throw new BackupError('BACKUP_REMOTE_TARGET_INVALID');
  }
  if (target.type === 'S3') {
    if (
      !target.bucket ||
      /[\/\\\x00-\x1f]/.test(target.bucket) ||
      !target.region ||
      !target.access_key_id ||
      !target.secret_access_key ||
      (target.path_style !== undefined &&
        typeof target.path_style !== 'boolean')
    )
      throw new BackupError('BACKUP_REMOTE_TARGET_INVALID');
    segments(target.prefix ?? '', true);
  } else segments((target.directory ?? '').replace(/^\/+|\/+$/g, ''), true);
  if (
    target.proxy !== undefined &&
    (!target.proxy ||
      !['DIRECT', 'INHERIT', 'PROFILE'].includes(target.proxy.mode) ||
      (target.proxy.mode === 'PROFILE' &&
        typeof target.proxy.profile_id !== 'string'))
  )
    throw new BackupError('BACKUP_REMOTE_TARGET_INVALID');
  return target;
}
function iso(value?: Date | string | null) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
/** No process environment or system proxy is changed; each adapter owns its agents. */
function agents(proxyUrl?: string) {
  if (proxyUrl && !['http:', 'https:'].includes(new URL(proxyUrl).protocol))
    throw new BackupError('BACKUP_REMOTE_PROXY_UNSUPPORTED');
  return proxyUrl
    ? {
        httpAgent: new HttpProxyAgent({ proxy: proxyUrl, keepAlive: true }),
        httpsAgent: new HttpsProxyAgent({ proxy: proxyUrl, keepAlive: true }),
      }
    : {
        httpAgent: new http.Agent({ keepAlive: true }),
        httpsAgent: new https.Agent({ keepAlive: true }),
      };
}
async function destination(
  file: string,
  action: (stream: NodeJS.WritableStream) => Promise<void>,
) {
  // Refuse overwrite and symlinks. A failed download never leaves a usable-looking partial file.
  const handle = await fs.open(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    // Keep one fd owner. Node's autoClose:false file streams retain handle
    // references on completion, and destroy() can still close a numeric fd.
    await action(
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          (async () => {
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await handle.write(
                chunk,
                offset,
                chunk.length - offset,
              );
              if (!bytesWritten)
                throw new BackupError('BACKUP_REMOTE_DOWNLOAD_INCOMPLETE');
              offset += bytesWritten;
            }
          })().then(() => done(), done);
        },
      }),
    );
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.unlink(file).catch(() => {});
    throw error;
  }
  await handle.close();
}

class S3Storage implements RemoteBackupStorage {
  private readonly client: S3Client;
  private readonly prefix: string;
  constructor(private readonly target: RemoteTarget, proxyUrl?: string) {
    endpoint(target.endpoint);
    if (
      !target.bucket ||
      !target.region ||
      !target.access_key_id ||
      !target.secret_access_key
    )
      throw new BackupError('BACKUP_REMOTE_TARGET_INVALID');
    this.prefix = segments(target.prefix ?? '', true).join('/');
    this.client = new S3Client({
      endpoint: target.endpoint,
      region: target.region,
      forcePathStyle: target.path_style ?? false,
      credentials: {
        accessKeyId: target.access_key_id,
        secretAccessKey: target.secret_access_key,
        ...(target.session_token ? { sessionToken: target.session_token } : {}),
      },
      requestHandler: new NodeHttpHandler({
        ...agents(proxyUrl),
        connectionTimeout: 15000,
        requestTimeout: 600000,
      }),
      maxAttempts: 2,
      // Older S3-compatible servers may not support trailing streaming checksum extensions.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  private key(key: string) {
    segments(key);
    return this.prefix ? `${this.prefix}/${key}` : key;
  }
  async testConnection() {
    const key = `.zhixu-probe-${randomUUID()}`;
    try {
      await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.target.bucket,
          Prefix: this.prefix ? this.prefix + '/' : '',
          MaxKeys: 1,
        }),
      );
      const probe = Buffer.from('ZhiXu remote backup probe\n');
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.target.bucket,
          Key: this.key(key),
          Body: probe,
        }),
      );
      const found = await this.stat(key);
      if (!found || found.size !== probe.length)
        throw new BackupError('BACKUP_REMOTE_CONFIRMATION_FAILED');
    } catch (e) {
      throw remoteError(e);
    } finally {
      await this.delete(key);
    }
  }
  async upload(
    key: string,
    file: string,
    onProgress?: (bytes: number) => void,
  ) {
    const handle = await openRegular(file);
    const stream = handle.createReadStream({ autoClose: false });
    try {
      const size = (await handle.stat()).size;
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.target.bucket,
          Key: this.key(key),
          Body: stream,
          ContentLength: size,
          ContentType: 'application/octet-stream',
        },
        queueSize: 2,
        partSize: 8 * 1024 * 1024,
        leavePartsOnError: false,
      });
      upload.on('httpUploadProgress', (p) => onProgress?.(p.loaded ?? 0));
      await upload.done();
      const result = await this.stat(key);
      if (!result || result.size !== size)
        throw new BackupError('BACKUP_REMOTE_CONFIRMATION_FAILED');
      return result;
    } catch (e) {
      throw remoteError(e);
    } finally {
      stream.destroy();
      await handle.close();
    }
  }
  async download(key: string, file: string) {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.target.bucket,
          Key: this.key(key),
        }),
      );
      const body = response.Body as Readable;
      if (!body || !Number.isSafeInteger(response.ContentLength))
        throw new BackupError('BACKUP_REMOTE_RESPONSE_INVALID');
      let bytes = 0;
      const counter = new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          done(null, chunk);
        },
      });
      try {
        await destination(file, async (output) => {
          await pipeline(body, counter, output);
          if (bytes !== response.ContentLength)
            throw new BackupError('BACKUP_REMOTE_DOWNLOAD_INCOMPLETE');
        });
      } finally {
        body.destroy();
      }
      return { key, size: bytes, last_modified: iso(response.LastModified) };
    } catch (e) {
      throw remoteError(e);
    }
  }
  async list() {
    const objects: RemoteObject[] = [];
    let token: string | undefined;
    try {
      do {
        const result = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.target.bucket,
            Prefix: this.prefix ? this.prefix + '/' : '',
            ContinuationToken: token,
          }),
        );
        for (const item of result.Contents ?? []) {
          if (!item.Key || !Number.isSafeInteger(item.Size)) continue;
          const key = this.prefix
            ? item.Key.slice(this.prefix.length + 1)
            : item.Key;
          if (key && !key.endsWith('/'))
            objects.push({
              key,
              size: item.Size!,
              last_modified: iso(item.LastModified),
            });
          if (objects.length > 100000)
            throw new BackupError('BACKUP_REMOTE_LIMIT');
        }
        if (
          result.IsTruncated &&
          (!result.NextContinuationToken ||
            token === result.NextContinuationToken)
        )
          throw new BackupError('BACKUP_REMOTE_RESPONSE_INVALID');
        token = result.IsTruncated ? result.NextContinuationToken : undefined;
      } while (token);
      return objects;
    } catch (e) {
      throw remoteError(e);
    }
  }
  async stat(key: string) {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.target.bucket,
          Key: this.key(key),
        }),
      );
      if (!Number.isSafeInteger(result.ContentLength))
        throw new BackupError('BACKUP_REMOTE_RESPONSE_INVALID');
      return {
        key,
        size: result.ContentLength!,
        last_modified: iso(result.LastModified),
      };
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404) return null;
      throw remoteError(e);
    }
  }
  async delete(key: string) {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.target.bucket,
          Key: this.key(key),
        }),
      );
    } catch (e) {
      throw remoteError(e);
    }
  }
  close() {
    this.client.destroy();
  }
}

class WebDavStorage implements RemoteBackupStorage {
  private readonly base: URL;
  private readonly ownedAgents: ReturnType<typeof agents>;
  constructor(private readonly target: RemoteTarget, proxyUrl?: string) {
    this.base = endpoint(target.endpoint);
    const directory = segments(
      (target.directory ?? '').replace(/^\/+|\/+$/g, ''),
      true,
    );
    this.base.pathname =
      this.base.pathname.replace(/\/+$/, '') +
      '/' +
      directory.map(encodeURIComponent).join('/') +
      (directory.length ? '/' : '');
    this.ownedAgents = agents(proxyUrl);
  }
  private url(key = '') {
    const u = new URL(this.base.toString());
    u.pathname += segments(key, true).map(encodeURIComponent).join('/');
    return u;
  }
  private async request(
    method: string,
    url: URL,
    headers: Record<string, string> = {},
    body?: Readable | Buffer,
  ) {
    return new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(
        url,
        {
          method,
          headers: {
            ...headers,
            ...(this.target.username || this.target.password
              ? {
                  authorization:
                    'Basic ' +
                    Buffer.from(
                      `${this.target.username ?? ''}:${
                        this.target.password ?? ''
                      }`,
                    ).toString('base64'),
                }
              : {}),
          },
          agent:
            url.protocol === 'https:'
              ? this.ownedAgents.httpsAgent
              : this.ownedAgents.httpAgent,
        },
        resolve,
      );
      request.setTimeout(600000, () =>
        request.destroy(new Error('REMOTE_TIMEOUT')),
      );
      request.on('error', reject);
      if (body instanceof Readable) pipeline(body, request).catch(reject);
      else request.end(body);
    });
  }
  private async accept(response: http.IncomingMessage, accepted: number[]) {
    if (!accepted.includes(response.statusCode ?? 0)) {
      response.destroy();
      throw remoteError({ statusCode: response.statusCode });
    }
    return response;
  }
  private async consume(response: http.IncomingMessage, limit = 65536) {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      size += chunk.length;
      if (size > limit) {
        response.destroy();
        throw new BackupError('BACKUP_REMOTE_RESPONSE_INVALID');
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  private async directories(key = '') {
    const parts = this.base.pathname
      .split('/')
      .filter(Boolean)
      .concat(segments(key, true).slice(0, -1).map(encodeURIComponent));
    const url = new URL(this.base.toString());
    url.pathname = '/';
    for (const part of parts) {
      url.pathname += part + '/';
      const r = await this.accept(
        await this.request('MKCOL', url),
        [201, 204, 405],
      );
      await this.consume(r);
    }
  }
  async testConnection() {
    const key = `.zhixu-probe-${randomUUID()}`;
    try {
      await this.directories(key);
      await this.list();
      const probe = Buffer.from('ZhiXu remote backup probe\n');
      const r = await this.accept(
        await this.request(
          'PUT',
          this.url(key),
          {
            'content-length': String(probe.length),
            'content-type': 'application/octet-stream',
          },
          probe,
        ),
        [200, 201, 204],
      );
      await this.consume(r);
      const found = await this.stat(key);
      if (!found || found.size !== probe.length)
        throw new BackupError('BACKUP_REMOTE_CONFIRMATION_FAILED');
    } catch (e) {
      throw remoteError(e);
    } finally {
      await this.delete(key);
    }
  }
  async upload(
    key: string,
    file: string,
    onProgress?: (bytes: number) => void,
  ) {
    const handle = await openRegular(file);
    const stream = handle.createReadStream({ autoClose: false });
    try {
      await this.directories(key);
      const size = (await handle.stat()).size;
      let bytes = 0;
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        onProgress?.(bytes);
      });
      const response = await this.accept(
        await this.request(
          'PUT',
          this.url(key),
          {
            'content-length': String(size),
            'content-type': 'application/octet-stream',
          },
          stream,
        ),
        [200, 201, 204],
      );
      await this.consume(response);
      const result = await this.stat(key);
      if (!result || result.size !== size)
        throw new BackupError('BACKUP_REMOTE_CONFIRMATION_FAILED');
      return result;
    } catch (e) {
      throw remoteError(e);
    } finally {
      stream.destroy();
      await handle.close();
    }
  }
  async download(key: string, file: string) {
    try {
      const response = await this.accept(
        await this.request('GET', this.url(key)),
        [200],
      );
      let bytes = 0;
      const counter = new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          done(null, chunk);
        },
      });
      const expected = response.headers['content-length'];
      try {
        await destination(file, async (output) => {
          await pipeline(response, counter, output);
          if (expected !== undefined && bytes !== Number(expected))
            throw new BackupError('BACKUP_REMOTE_DOWNLOAD_INCOMPLETE');
        });
      } finally {
        response.destroy();
      }
      return {
        key,
        size: bytes,
        last_modified: iso(response.headers['last-modified']),
      };
    } catch (e) {
      throw remoteError(e);
    }
  }
  async list() {
    try {
      const body = Buffer.from(
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>',
      );
      const result: RemoteObject[] = [];
      const queue = [this.url()],
        seen = new Set<string>();
      while (queue.length) {
        const directory = queue.shift()!;
        if (seen.has(directory.pathname)) continue;
        seen.add(directory.pathname);
        if (seen.size > 10000) throw new BackupError('BACKUP_REMOTE_LIMIT');
        const response = await this.accept(
          await this.request(
            'PROPFIND',
            directory,
            {
              depth: '1',
              'content-type': 'application/xml',
              'content-length': String(body.length),
            },
            body,
          ),
          [207],
        );
        const xml = await this.consume(response, 8 * 1024 * 1024);
        const parsed = new XMLParser({
          removeNSPrefix: true,
          processEntities: false,
          parseTagValue: false,
        }).parse(xml);
        const entries = parsed?.multistatus?.response;
        if (entries === undefined)
          throw new BackupError('BACKUP_REMOTE_RESPONSE_INVALID');
        for (const entry of Array.isArray(entries) ? entries : [entries]) {
          if (typeof entry?.href !== 'string') continue;
          const href = new URL(entry.href, this.base);
          if (
            href.origin !== this.base.origin ||
            !href.pathname.startsWith(directory.pathname)
          )
            continue;
          const encoded = href.pathname.slice(this.base.pathname.length);
          if (!encoded) continue;
          const key = decodeURIComponent(encoded.replace(/\/$/, ''));
          const parts = segments(key);
          if (parts.length > 8) throw new BackupError('BACKUP_REMOTE_LIMIT');
          const props = Array.isArray(entry.propstat)
            ? entry.propstat
            : [entry.propstat];
          const prop = props.find((p: any) =>
            / 200(?: |$)/.test(p?.status ?? ''),
          )?.prop;
          if (!prop) continue;
          if (prop.resourcetype?.collection !== undefined) {
            if (href.pathname !== directory.pathname) {
              if (!href.pathname.endsWith('/')) href.pathname += '/';
              queue.push(href);
            }
            continue;
          }
          if (!/^\d+$/.test(prop.getcontentlength ?? '')) continue;
          const size = Number(prop.getcontentlength);
          if (!Number.isSafeInteger(size)) continue;
          result.push({ key, size, last_modified: iso(prop.getlastmodified) });
          if (result.length > 100000)
            throw new BackupError('BACKUP_REMOTE_LIMIT');
        }
      }
      return result;
    } catch (e) {
      throw remoteError(e);
    }
  }
  async stat(key: string) {
    try {
      const response = await this.request('HEAD', this.url(key));
      if (response.statusCode === 404) {
        response.destroy();
        return null;
      }
      await this.accept(response, [200]);
      const size = Number(response.headers['content-length']);
      response.resume();
      if (!Number.isSafeInteger(size) || size < 0)
        throw new BackupError('BACKUP_REMOTE_RESPONSE_INVALID');
      return {
        key,
        size,
        last_modified: iso(response.headers['last-modified']),
      };
    } catch (e) {
      throw remoteError(e);
    }
  }
  async delete(key: string) {
    try {
      await this.consume(
        await this.accept(
          await this.request('DELETE', this.url(key)),
          [200, 204, 404],
        ),
      );
    } catch (e) {
      throw remoteError(e);
    }
  }
  close() {
    this.ownedAgents.httpAgent.destroy();
    this.ownedAgents.httpsAgent.destroy();
  }
}

/** Small transport boundary shared by the online service and database-independent CLI. */
export function createRemoteStorage(
  target: RemoteTarget,
  proxyUrl?: string,
): RemoteBackupStorage {
  try {
    target = validateRemoteTarget(target);
    if (target.proxy?.mode === 'PROFILE' && !proxyUrl)
      throw new BackupError('BACKUP_REMOTE_PROXY_UNRESOLVED');
    if (target.type === 'S3') return new S3Storage(target, proxyUrl);
    if (target.type === 'WEBDAV') return new WebDavStorage(target, proxyUrl);
    throw new BackupError('BACKUP_REMOTE_TARGET_INVALID');
  } catch (e) {
    throw remoteError(e);
  }
}
