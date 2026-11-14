import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type http from 'http';
import type { Socket } from 'net';

export interface V2ShutdownEvent {
  event: 'V2_SHUTDOWN';
  phase: string;
  elapsed_ms: number;
  connections: number;
  requests: number;
  handlers: number;
}

/** Transport deadlines never authorize abandoning an admitted database operation. */
export class V2HttpLifetime {
  private readonly sockets = new Set<Socket>();
  private readonly responses = new Set<Response>();
  private readonly handlers = new Set<Promise<unknown>>();
  private stopping = false;
  private started?: bigint;
  private closing?: Promise<void>;

  constructor(private readonly report?: (event: V2ShutdownEvent) => void) {}

  diagnostic(phase: string) {
    if (!this.started) this.started = process.hrtime.bigint();
    try {
      this.report?.({
        event: 'V2_SHUTDOWN',
        phase,
        elapsed_ms: Number(process.hrtime.bigint() - this.started) / 1e6,
        connections: this.sockets.size,
        requests: this.responses.size,
        handlers: this.handlers.size,
      });
    } catch {
      // Diagnostics must not control shutdown or expose application data.
    }
  }

  readonly admission: RequestHandler = (_req, res, next) => {
    if (this.stopping) {
      res.setHeader('Connection', 'close');
      res
        .status(503)
        .json({ code: 503, error_code: 'WORKSPACE_RECOVERY_REQUIRED' });
      return;
    }
    this.responses.add(res);
    const finished = () => {
      this.responses.delete(res);
      res.off('finish', finished);
      res.off('close', finished);
    };
    res.once('finish', finished);
    res.once('close', finished);
    next();
  };

  /** Explicitly wrap our async handlers; Express's router and error semantics stay intact. */
  readonly handle =
    (
      action: (req: Request, res: Response, next: NextFunction) => unknown,
    ): RequestHandler =>
    (req, res, next) => {
      let result: unknown;
      try {
        result = action(req, res, next);
      } catch (error) {
        next(error);
        return;
      }
      if (!result || typeof (result as Promise<unknown>).then !== 'function')
        return;
      const pending = Promise.resolve(result);
      this.handlers.add(pending);
      void pending.then(
        () => this.handlers.delete(pending),
        (error) => {
          this.handlers.delete(pending);
          next(error);
        },
      );
    };

  attach(server: http.Server) {
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      if (this.stopping) socket.destroy();
    });
  }

  close(server: http.Server | undefined, graceMs = 5000) {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.diagnostic('ADMISSION_CLOSED');
    for (const response of this.responses) {
      if (!response.headersSent) response.setHeader('Connection', 'close');
    }
    this.closing = (async () => {
      if (server) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((error?: Error) => {
              if (
                error &&
                (error as NodeJS.ErrnoException).code !==
                  'ERR_SERVER_NOT_RUNNING'
              )
                reject(error);
              else resolve();
            });
            // Node 22/24 close idle keep-alive connections in close(). Explicitly
            // closing idle transports also documents the intended lifecycle.
            (
              server as http.Server & { closeIdleConnections?(): void }
            ).closeIdleConnections?.();
            timer = setTimeout(() => {
              this.diagnostic('HTTP_TRANSPORT_DEADLINE');
              (
                server as http.Server & { closeAllConnections?(): void }
              ).closeAllConnections?.();
              // Includes half-written HTTP headers and any upgraded transports.
              // The application currently exposes neither WebSocket nor SSE.
              for (const socket of this.sockets) socket.destroy();
            }, graceMs);
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
        // server.close's callback can precede individual socket close events.
        // Let aborted parsers/uploads run their cleanup before draining handlers.
        await Promise.all(
          [...this.sockets].map(
            (socket) =>
              new Promise<void>((resolve) =>
                socket.once('close', () => resolve()),
              ),
          ),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      this.diagnostic('HTTP_TRANSPORT_CLOSED');
      // A client disconnect is not cancellation of its admitted side effects.
      // Retain the backend owner and SQLite until these handlers actually settle.
      while (this.handlers.size) await Promise.allSettled([...this.handlers]);
      this.diagnostic('HTTP_HANDLERS_DRAINED');
    })();
    return this.closing;
  }
}
