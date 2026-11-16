import 'reflect-metadata';
import express, { Request, Response } from 'express';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import rateLimit from 'express-rate-limit';
import { createV2Services, V2Container } from './container';
import {
  openV2Store,
  recoverV2RestoreBeforeOpen,
  sessionSigningKey,
  artifactPath,
  V2BootOptions,
} from './bootstrap';
import { V2PanelAuth } from './auth';
import { V2HttpErrors } from './httpErrors';
import { qualifyLocalStorage } from './storageAdmission';
import { workspaceApiRoutes } from './workspaceApi';
import { gitApiRoutes } from './gitApi';
import {
  repositoryApiRoutes,
  CandidateGitResources,
} from './repositoryResources';
import { taskApiRoutes } from './taskApi';
import { resourceApiRoutes } from './resourceApi';
import { triggerApiRoutes, CandidateTaskTriggers } from './triggerApi';
import { createRuntimeDomain, CandidateRuntimeDomain } from './runtimeDomain';
import { runtimeApiRoutes } from './runtimeApi';
import { registerBackupApi } from './backupApi';
import { RestoreRebuildService } from '../services/backup/rebuild';
import { BackupOperations } from '../services/backup/operations';
import { WorkspacePreservationService } from '../services/workspaceV2/preservation';
import { registerRetainedApi } from './retainedApi';
import { normalizeClientIp } from '../shared/clientIp';
import { createNotificationDomain } from './notificationApi';
import {
  serviceForRoute,
  extensionReasons,
  retainedDtoForRoute,
} from './routeCatalog';
import { BackupPaths, acquireBackendLease } from '../services/backup/paths';
import { withInheritedLease } from '../services/backup/inheritedLeases';
import { fail } from '../services/workspaceV2/errors';
import type { ApiCall, ApiHandler, ApiRoute, RouteMap } from './types';
import type { WorkspaceGitAdapter } from '../services/gitWorkspaceV2/git';
import { normalizeV2PublicOrigin } from './publicOrigin';
import { V2HttpLifetime, V2ShutdownEvent } from './httpLifetime';
import type { RuntimeArtifactOptions } from '../services/runtimeArtifacts';

export interface V2ApplicationOptions extends V2BootOptions {
  publicOrigin?: string;
  git?: ConstructorParameters<typeof WorkspaceGitAdapter>[2];
  createGitResources?: (s: V2Container) => CandidateGitResources;
  extraRoutes?: (s: V2Container) => RouteMap;
  onRestartRequested?: () => void;
  onShutdownEvent?: (event: V2ShutdownEvent) => void;
  runtimeArtifacts?: RuntimeArtifactOptions;
}
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function preciseKey(key: string) {
  return (
    key.split('/').reduce((n, p) => n + (p.startsWith(':') ? 0 : 10), 0) +
    key.length / 10000
  );
}
function platform(req: Request) {
  return /mobile|android|iphone|ipad/i.test(req.headers['user-agent'] ?? '')
    ? 'mobile'
    : 'desktop';
}
/** Complete HTTP app: no legacy router, global ORM or data-root default is mounted. */
export class V2Application {
  readonly app = express();
  services!: V2Container;
  auth!: V2PanelAuth;
  runtime!: CandidateRuntimeDomain;
  triggers!: CandidateTaskTriggers;
  notifications!: ReturnType<typeof createNotificationDomain>;
  readonly restartRequested: Promise<void>;
  private restartSignal!: () => void;
  server?: http.Server;
  ready = false;
  state = 'STARTING';
  phases: string[] = [];
  localWrites = false;
  origin = '';
  private maps: RouteMap = {};
  private controllers: Record<string, string> = {};
  private contract: any;
  private error!: V2HttpErrors;
  private stopped!: () => void;
  private closedPromise: Promise<void>;
  private closing?: Promise<void>;
  private routesWired = false;
  private readonly lifetime: Promise<void>;
  private resolveLifetime!: () => void;
  private backupApi?: ReturnType<typeof registerBackupApi>;
  private admission?: Awaited<ReturnType<typeof qualifyLocalStorage>>;
  private readonly httpLifetime: V2HttpLifetime;
  constructor(readonly options: V2ApplicationOptions) {
    this.httpLifetime = new V2HttpLifetime(options.onShutdownEvent);
    this.closedPromise = new Promise((r) => {
      this.stopped = r;
    });
    this.lifetime = new Promise((r) => {
      this.resolveLifetime = r;
    });
    this.restartRequested = new Promise((r) => {
      this.restartSignal = r;
    });
  }
  static async launch(options: V2ApplicationOptions): Promise<V2Application> {
    options = {
      ...options,
      publicOrigin: normalizeV2PublicOrigin(options.publicOrigin),
    };
    if (
      !options.publicOrigin &&
      ['0.0.0.0', '::', '[::]'].includes(options.host ?? '')
    )
      throw new Error('STARTUP_PUBLIC_ORIGIN_REQUIRED');
    const instance = new V2Application(options);
    return new Promise((resolve, reject) => {
      void (async () => {
        let owner: Awaited<ReturnType<typeof acquireBackendLease>>;
        let openedStore: Awaited<ReturnType<typeof openV2Store>> | undefined;
        try {
          await recoverV2RestoreBeforeOpen(options);
          const paths = new BackupPaths(
            options.dataRoot,
            options.backupRoot ?? options.dataRoot + '-backups',
          );
          const store = await openV2Store(options, async () => {
            instance.phases.push('SCHEMA_PREFLIGHT_VALIDATED');
            owner = await acquireBackendLease(paths);
            if (!owner) throw new Error('APPLICATION_OWNER_REQUIRED');
            instance.phases.push('BACKEND_OWNER_ACQUIRED');
          });
          openedStore = store;
          instance.phases.push('SCHEMA_IDENTITY_VALIDATED');
          const acquired = owner;
          if (!acquired) throw new Error('APPLICATION_OWNER_REQUIRED');
          await withInheritedLease(acquired.handle.fd, async () => {
            await instance.initialize(store, paths.root);
            resolve(instance);
            await instance.closedPromise;
          });
        } catch (e) {
          await instance.notifications?.close().catch(() => undefined);
          await instance.runtime?.close().catch(() => undefined);
          await instance.services?.close().catch(() => undefined);
          if (!instance.services)
            await openedStore?.close().catch(() => undefined);
          await owner?.release();
          owner = undefined;
          reject(e);
        } finally {
          try {
            await owner?.release();
          } finally {
            instance.resolveLifetime();
          }
        }
      })();
    });
  }
  private async initialize(
    store: Awaited<ReturnType<typeof openV2Store>>,
    backupRoot: string,
  ) {
    this.contract = JSON.parse(
      await fs.readFile(
        artifactPath('api-contracts.json', this.options),
        'utf8',
      ),
    );
    this.error = new V2HttpErrors(
      artifactPath('error-codes.json', this.options),
    );
    this.services = createV2Services(store, backupRoot, {
      git: this.options.git,
      recoverRuntime: () => this.runtime.recover(),
      recoverInbox: async () => {
        await this.triggers.recoverWebhookEvents();
        await this.notifications.recover();
      },
    });
    await this.services.leases.barrier.recoverAbandonedSnapshot();
    this.phases.push('BACKUP_ADMISSION_RECOVERY');
    this.runtime = await createRuntimeDomain(
      this.services,
      this.options.runtimeArtifacts
        ? {
            ...this.options.runtimeArtifacts,
            excludedRoots: [
              ...(this.options.runtimeArtifacts.excludedRoots ?? []),
              this.services.backup.paths.root,
            ],
          }
        : undefined,
    );
    this.triggers = new CandidateTaskTriggers(this.services);
    this.notifications = createNotificationDomain(this.services);
    await new BackupOperations(this.services.backup.paths).recover();
    this.phases.push('BACKUP_OPERATION_RECOVERY');
    const key = await sessionSigningKey(store.dataRoot + '.platform-control');
    this.auth = new V2PanelAuth(() => this.services.store, key);
    await this.auth.info();
    const resources = this.options.createGitResources?.(this.services);
    const modules: Array<[string, RouteMap]> = [
      ['workspaceApiRoutes', workspaceApiRoutes(this.services)],
      ['gitApiRoutes', gitApiRoutes(this.services, resources)],
      ['repositoryApiRoutes', repositoryApiRoutes(this.services, resources)],
      [
        'taskApiRoutes',
        taskApiRoutes(this.services, [this.options.projectRoot]),
      ],
      ['resourceApiRoutes', resourceApiRoutes(this.services)],
      ['triggerApiRoutes', triggerApiRoutes(this.services)],
      ['runtimeApiRoutes', runtimeApiRoutes(this.services, this.runtime)],
      ['CandidateNotificationDomain.routes', this.notifications.routes()],
      ['extraRoutes', this.options.extraRoutes?.(this.services) ?? {}],
    ];
    for (const [controller, routes] of modules)
      for (const [key, entry] of Object.entries(routes)) {
        if (this.maps[key]) throw new Error('API_ROUTE_DUPLICATE');
        this.maps[key] = entry;
        this.controllers[key] = controller;
      }
    const missing = this.contract.routes.filter(
      (row: any) => !this.maps[row.method + ' ' + row.path],
    );
    if (missing.length)
      throw Object.assign(new Error('API_CONTRACT_INCOMPLETE'), {
        error_code: 'API_CONTRACT_INCOMPLETE',
        missingRoutes: missing.map((r: any) => r.method + ' ' + r.path),
      });
    const recovered = await this.services.recover();
    this.phases.push(...recovered.phases);
    this.ready = recovered.ready;
    this.localWrites = false;
    // Current application storage qualification is installed before writes are admitted.
    this.state = this.ready ? 'STORAGE_ADMISSION_PENDING' : 'RECOVERY_REQUIRED';
    if (this.ready) {
      this.admission = await qualifyLocalStorage(this.options);
      this.localWrites = true;
      this.phases.push('CURRENT_BUILD_STORAGE_ADMISSION');
    }
    await this.wireHttp();
    await new Promise<void>((resolve, reject) => {
      this.server = http.createServer({ maxHeaderSize: 16384 }, this.app);
      this.httpLifetime.attach(this.server);
      this.server.once('error', reject);
      this.server.listen(
        this.options.port ?? 0,
        this.options.host ?? '127.0.0.1',
        () => resolve(),
      );
    });
    const address = this.server!.address();
    if (!address || typeof address === 'string')
      throw new Error('HTTP_LISTEN_FAILED');
    const host = this.options.host ?? '127.0.0.1';
    const authority =
      host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    this.origin =
      this.options.publicOrigin ?? `http://${authority}:${address.port}`;
    if (this.ready) {
      this.phases.push('RECOVERY_COMPLETE');
      this.state = 'READY';
      this.phases.push('ADMISSION_READY');
      if (this.options.background !== false) {
        this.services.start();
        this.runtime.startRecovery();
        this.notifications.start();
        this.phases.push('SCHEDULERS_ENABLED');
      }
    }
    this.phases.push('HTTP_READY');
  }
  private sameOrigin(req: Request) {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin !== this.origin)
      fail('PANEL_SESSION_REQUIRED', 403);
  }
  private async wireHttp() {
    if (this.routesWired) return;
    this.routesWired = true;
    const { version: applicationVersion } = JSON.parse(
      await fs.readFile(
        path.join(
          this.options.projectRoot ?? path.resolve(__dirname, '../..'),
          'package.json',
        ),
        'utf8',
      ),
    );
    const app = this.app;
    app.use(this.httpLifetime.admission);
    app.disable('x-powered-by');
    app.set('case sensitive routing', true);
    app.set('strict routing', true);
    app.set('trust proxy', false);
    app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('Cache-Control', 'no-store');
      const p = req.path.toLowerCase();
      if (this.origin && req.get('host') !== new URL(this.origin).host)
        return this.error.send(res, {
          error_code: 'PANEL_SESSION_REQUIRED',
          status: 403,
        });
      if (p.startsWith('/open/') || p === '/open')
        return this.error.send(res, { error_code: 'PANEL_SESSION_REQUIRED' });
      if ((p.startsWith('/api/') || p === '/api') && req.path !== p)
        return this.error.send(res, { error_code: 'API_ROUTE_NOT_FOUND' });
      next();
    });
    app.post(
      '/hooks/:publicId',
      this.httpLifetime.handle(async (req, res, next) => {
        try {
          if (Object.keys(req.query).length) fail('WEBHOOK_UNAUTHORIZED', 401);
          await this.triggers.authenticateWebhook(
            req.params.publicId,
            req.headers.authorization,
          );
          if (!this.ready) fail('WORKSPACE_RECOVERY_REQUIRED');
          next();
        } catch (e) {
          next(e);
        }
      }),
      express.json({ limit: '64kb', strict: true }),
      this.httpLifetime.handle(async (req, res, next) => {
        try {
          const data = await this.triggers.receiveWebhook(
            req.params.publicId,
            req.headers.authorization,
            req.get('Idempotency-Key'),
          );
          res.status(202).json({ code: 202, data });
        } catch (e) {
          next(e);
        }
      }),
    );
    app.use(
      '/api',
      this.httpLifetime.handle(async (req, _res, next) => {
        try {
          const info = await this.auth.info();
          if (
            info?.info.blockedIps?.includes(
              normalizeClientIp(req.ip || req.socket.remoteAddress),
            )
          )
            fail('PANEL_SESSION_REQUIRED', 403);
          next();
        } catch (e) {
          next(e);
        }
      }),
    );
    app.get('/api/env.js', (_req, res) =>
      res.type('application/javascript').send('window.__ENV__QlBaseUrl="/";'),
    );
    app.get('/api/health', (_req, res) =>
      res.status(this.ready ? 200 : 503).json({
        code: this.ready ? 200 : 503,
        data: {
          status: this.ready ? 'ok' : 'error',
          services: { http: !!this.server, grpc: false },
          metrics: {
            uptime: Math.floor(process.uptime()),
            memory: {
              used: process.memoryUsage().heapUsed,
              total: process.memoryUsage().heapTotal,
            },
          },
          mode: 'v2',
          ready: this.ready,
          state: this.state,
        },
      }),
    );
    app.get(
      '/api/system',
      this.httpLifetime.handle(async (_req, res, next) => {
        try {
          const usage = await new WorkspacePreservationService(
            this.services.backup,
          ).usage();
          res.json({
            code: 200,
            data: {
              mode: 'v2',
              initialized: await this.auth.initialized(),
              ready: this.ready,
              state: this.state,
              local_write_admission: this.localWrites,
              schema_identity: 'zhixu.workspace.v2.s0.1',
              schema_version: 'S0-2026-11-13',
              build_id: this.admission?.build_id ?? null,
              version: applicationVersion,
              storage: {
                ...usage,
                status: this.localWrites ? 'READY' : 'RECOVERY_REQUIRED',
                quota_bytes: this.services.backup.limits.backupRetainedBytes,
              },
              csrf_token: this.auth.setupCsrf(),
            },
          });
        } catch (e) {
          next(e);
        }
      }),
    );
    app.use(
      ['/api/user/init', '/api/user/login', '/api/user/two-factor/login'],
      express.json({ limit: '16kb', strict: true }),
      rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }),
    );
    const initializeOwner = this.httpLifetime.handle(
      async (req: Request, res: Response, next: any) => {
        try {
          this.sameOrigin(req);
          res.json({
            code: 200,
            data: await this.services.leases.barrier.mutation(() =>
              this.auth.initialize(req.body, req.get('X-CSRF-Token')),
            ),
          });
        } catch (e) {
          next(e);
        }
      },
    );
    app.post('/api/user/init', initializeOwner);
    app.put('/api/user/init', initializeOwner);
    app.post(
      '/api/user/login',
      this.httpLifetime.handle(async (req, res, next) => {
        try {
          this.sameOrigin(req);
          const data = await this.services.leases.barrier.mutation(() =>
            this.auth.login(
              req.body,
              platform(req),
              normalizeClientIp(req.ip || req.socket.remoteAddress),
            ),
          );
          res.json(
            'two_factor_required' in data
              ? { code: 420, error_code: 'TWO_FACTOR_REQUIRED' }
              : { code: 200, data },
          );
        } catch (e) {
          next(e);
        }
      }),
    );
    app.put(
      '/api/user/two-factor/login',
      rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }),
      this.httpLifetime.handle(async (req, res, next) => {
        try {
          this.sameOrigin(req);
          res.json({
            code: 200,
            data: await this.services.leases.barrier.mutation(() =>
              this.auth.twoFactorLogin(
                req.body,
                platform(req),
                normalizeClientIp(req.ip || req.socket.remoteAddress),
              ),
            ),
          });
        } catch (e) {
          next(e);
        }
      }),
    );
    app.use(
      '/api',
      this.httpLifetime.handle(async (req, res, next) => {
        try {
          const auth = await this.auth.principal(
            req.headers.authorization,
            platform(req),
          );
          (req as any).v2auth = auth;
          if (MUTATING.has(req.method)) {
            this.sameOrigin(req);
            this.auth.verifyCsrf(auth.token, req.get('X-CSRF-Token'));
          }
          next();
        } catch (e) {
          next(e);
        }
      }),
    );
    app.use('/api', express.json({ limit: '16mb', strict: true }));
    app.get(
      '/api/user',
      this.httpLifetime.handle(async (req, res, next) => {
        try {
          const { principal, token } = (req as any).v2auth;
          res.json({
            code: 200,
            data: await this.auth.current(principal, token),
          });
        } catch (e) {
          next(e);
        }
      }),
    );
    app.post(
      '/api/user/logout',
      this.httpLifetime.handle(async (req, res, next) => {
        try {
          await this.services.leases.barrier.mutation(() =>
            this.auth.logout((req as any).v2auth.token),
          );
          res.json({ code: 200, data: null });
        } catch (e) {
          next(e);
        }
      }),
    );
    await registerRetainedApi(app, this.services, this.auth, this.httpLifetime);
    this.backupApi = registerBackupApi(
      app,
      this.services,
      {
        pauseProducers: async () => {
          await this.services.pause();
          await this.notifications.close();
        },
        resumeProducers: () => {
          if (
            this.ready &&
            !this.closing &&
            this.options.background !== false
          ) {
            this.services.start();
            this.notifications.start();
          }
        },
        requestRestart: async () => {
          this.ready = false;
          this.localWrites = false;
          this.state = 'RESTORE_PENDING';
          this.restartSignal();
          this.options.onRestartRequested?.();
        },
        rebuildRuntime: () =>
          this.runtime.run(() =>
            new RestoreRebuildService(
              this.services.backup.paths,
              this.runtime.operations,
            ).run(),
          ),
      },
      this.httpLifetime,
    );
    for (const key of Object.keys(this.maps).sort(
      (a, b) => preciseKey(b) - preciseKey(a),
    )) {
      const [method, ...rest] = key.split(' '),
        routePath = rest.join(' ');
      const frozen = this.contract.routes.find(
        (row: any) => row.method === method && row.path === routePath,
      );
      (app as any)[method.toLowerCase()](
        '/api' + routePath,
        this.httpLifetime.handle(
          async (req: Request, res: Response, next: any) => {
            try {
              const recoveryAction =
                method === 'POST' &&
                /^\/(?:workspaces\/:id\/(?:recover|git\/repair)|repositories\/:id\/(?:repair|initialize))$/.test(
                  routePath,
                );
              if (!this.ready && MUTATING.has(method) && !recoveryAction)
                fail('WORKSPACE_RECOVERY_REQUIRED');
              if (
                !this.localWrites &&
                MUTATING.has(method) &&
                routePath.startsWith('/workspaces') &&
                !recoveryAction
              )
                fail('WORKSPACE_RECOVERY_REQUIRED');
              const entry = this.maps[key],
                handle =
                  typeof entry === 'function'
                    ? entry
                    : (entry as ApiRoute).handle;
              if (!handle) fail('WORKSPACE_OPERATION_FAILED');
              const idempotencyKey = req.get('Idempotency-Key');
              if (
                frozen?.idempotency_key.startsWith('REQUIRED') &&
                (!idempotencyKey ||
                  !/^\S[\x21-\x7e]{0,199}$/.test(idempotencyKey))
              )
                fail('IDEMPOTENCY_KEY_INVALID', 400);
              let statusOverride: 200 | 202 | undefined;
              const call: ApiCall = {
                params: req.params,
                query: req.query as Record<string, unknown>,
                body: req.body ?? {},
                idempotencyKey,
                ifMatch: req.get('If-Match'),
                setHeader: (name, value) => res.setHeader(name, value),
                setStatus: (status) => {
                  statusOverride = status;
                },
                principal: (req as any).v2auth.principal,
              };
              const data = MUTATING.has(method)
                ? await this.services.leases.barrier.mutation(() =>
                    (handle as ApiHandler)(call),
                  )
                : await (handle as ApiHandler)(call);
              if (recoveryAction && !this.ready && !this.closing) {
                const recovered = await this.services.recover();
                if (recovered.ready) {
                  await qualifyLocalStorage(this.options);
                  this.localWrites = true;
                  this.ready = true;
                  this.state = 'READY';
                  if (this.options.background !== false) {
                    this.services.start();
                    this.runtime.startRecovery();
                    this.notifications.start();
                  }
                }
              }
              const status =
                statusOverride ?? frozen?.success_http_status ?? 200;
              res.status(status).json({ code: status, data: data ?? null });
            } catch (e) {
              next(e);
            }
          },
        ),
      );
    }
    app.use('/api', (_req, res) =>
      this.error.send(res, { error_code: 'API_ROUTE_NOT_FOUND' }),
    );
    const frontend =
      this.options.frontendRoot ??
      path.join(
        this.options.projectRoot ?? path.resolve(__dirname, '../..'),
        'static/dist-v2',
      );
    app.use(express.static(frontend, { dotfiles: 'deny', fallthrough: true }));
    app.get(
      '*',
      this.httpLifetime.handle(async (_req, res, next) => {
        try {
          res.sendFile(path.join(frontend, 'index.html'));
        } catch (e) {
          next(e);
        }
      }),
    );
    app.use((error: unknown, _req: Request, res: Response, _next: any) => {
      if (!res.headersSent) this.error.send(res, error);
    });
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.ready = false;
      this.state = 'STOPPING';
      const httpClosed = this.httpLifetime.close(this.server);
      // Observe an early transport error while producers drain, then propagate it.
      void httpClosed.catch(() => undefined);
      this.httpLifetime.diagnostic('PRODUCERS_STOP_BEGIN');
      await this.services?.pause();
      this.httpLifetime.diagnostic('PRODUCERS_STOPPED');
      this.httpLifetime.diagnostic('SCHEDULER_OUTBOX_STOPPED');
      await httpClosed;
      await this.services?.syncScheduler.close();
      await this.services?.sync.close();
      this.httpLifetime.diagnostic('GIT_SYNC_STOPPED');
      this.httpLifetime.diagnostic('TASK_RUNNER_STOP_BEGIN');
      await this.services?.execution.close();
      this.httpLifetime.diagnostic('TASK_RUNNER_STOPPED');
      await this.backupApi?.operations.close();
      this.httpLifetime.diagnostic('BACKUP_OPERATIONS_DRAINED');
      await this.notifications?.close();
      this.httpLifetime.diagnostic('NOTIFICATIONS_STOPPED');
      await this.runtime?.close();
      this.httpLifetime.diagnostic('RUNTIME_STOPPED');
      await this.services?.close();
      this.httpLifetime.diagnostic('SQLITE_CLOSED');
      this.stopped();
      await this.lifetime;
      this.httpLifetime.diagnostic('BACKEND_OWNER_RELEASED');
    })();
    return this.closing;
  }
  coverage() {
    return this.contract.routes.map((r: any) => {
      const key = r.method + ' ' + r.path,
        entry = this.maps[key],
        controller = this.controllers[key];
      return {
        method: r.method,
        path: r.path,
        status:
          typeof entry === 'function'
            ? 'IMPLEMENTED'
            : entry?.status ?? 'MISSING',
        request_dto: r.request_dto,
        response_dto: r.response_dto,
        controller,
        service:
          typeof entry === 'function'
            ? serviceForRoute(controller, r.path)
            : entry?.service,
      };
    });
  }
  publicRouteCatalog() {
    const frozen = new Map<string, any>(
      this.coverage().map((r: any) => [r.method + ' /api' + r.path, r]),
    );
    const routes: any[] = [];
    for (const layer of (this.app as any)._router.stack) {
      const route = layer.route;
      if (
        !route ||
        typeof route.path !== 'string' ||
        !(route.path.startsWith('/api/') || route.path.startsWith('/hooks/'))
      )
        continue;
      for (const method of route.methods._all
        ? ['post', 'put']
        : Object.keys(route.methods)) {
        const key = method.toUpperCase() + ' ' + route.path;
        if (frozen.has(key)) {
          routes.push({
            ...frozen.get(key),
            path: route.path,
            scope: 'FROZEN_S0',
          });
          continue;
        }
        const logical =
          method.toUpperCase() + ' ' + route.path.replace(/^\/api/, '');
        const controller =
          this.controllers[logical] ??
          (route.path.includes('backup') || route.path.includes('restore')
            ? 'registerBackupApi'
            : route.path.includes('/user')
            ? 'V2PanelAuth + registerRetainedApi'
            : 'V2Application + registerRetainedApi');
        routes.push({
          method: method.toUpperCase(),
          path: route.path,
          scope: extensionReasons[logical] ? 'S4_EXTENSION' : 'RETAINED_DOMAIN',
          controller,
          service: serviceForRoute(controller, route.path),
          status:
            route.path.includes('/storage-retention/') ||
            (method === 'put' && route.path.includes('/user/notification'))
              ? 'UNSUPPORTED_BY_FROZEN_SCHEMA'
              : 'IMPLEMENTED',
          ...retainedDtoForRoute(controller, route.path, method.toUpperCase()),
          ...(method === 'put' && route.path.includes('/user/notification')
            ? { retired: true, http_status: 410 }
            : {}),
          reason:
            extensionReasons[logical] ??
            (route.path.includes('/storage-retention/')
              ? 'Subscription-owned retention has no v2 domain.'
              : method === 'put' && route.path.includes('/user/notification')
              ? 'Legacy Auths notification configuration is retired; the frozen channel domain owns writes.'
              : undefined),
        });
      }
    }
    return routes;
  }
}
