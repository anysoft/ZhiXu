/** Explicit fresh-v2 entry. The existing app.ts remains the v9 entry. */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { assertV2BackendNode } from './applicationV2/backendNode';
import type { V2ShutdownEvent } from './applicationV2/httpLifetime';
import type { RuntimeArtifactOptions } from './services/runtimeArtifacts';
function projectDirectory() {
  let current = __dirname;
  for (;;) {
    const file = path.join(current, 'package.json');
    if (
      fs.existsSync(file) &&
      JSON.parse(fs.readFileSync(file, 'utf8')).name === '@anysoft/zhixu'
    )
      return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('PROJECT_ROOT_REQUIRED');
    current = parent;
  }
}
function argumentsV2(args: string[]) {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (
      ![
        '--data-root',
        '--backup-root',
        '--initialize',
        '--host',
        '--public-origin',
        '--port',
        '--frontend-root',
        '--runtime-artifact-mode',
        '--runtime-artifact-store',
        '--runtime-artifact-trust-anchor',
        '--runtime-artifact-manifest',
      ].includes(key) ||
      result[key] !== undefined
    )
      throw new Error('STARTUP_ARGUMENT_INVALID');
    if (key === '--initialize') result[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--'))
        throw new Error('STARTUP_ARGUMENT_INVALID');
      result[key] = value;
    }
  }
  if (typeof result['--data-root'] !== 'string')
    throw new Error('EXPLICIT_DATA_ROOT_REQUIRED');
  const artifactArgs = [
    '--runtime-artifact-mode',
    '--runtime-artifact-store',
    '--runtime-artifact-trust-anchor',
    '--runtime-artifact-manifest',
  ];
  if (artifactArgs.some((key) => result[key] !== undefined)) {
    if (
      artifactArgs.some((key) => typeof result[key] !== 'string') ||
      !['ONLINE_VERIFIED', 'OFFLINE_VERIFIED'].includes(
        result['--runtime-artifact-mode'] as string,
      )
    )
      throw new Error('STARTUP_ARGUMENT_INVALID');
  }
  return result;
}
async function main() {
  assertV2BackendNode(process.versions.node);
  const args = argumentsV2(process.argv.slice(2)),
    projectRoot = projectDirectory();
  const originalLegacyRoot = process.env.QL_DATA_DIR;
  process.env.QL_DIR = projectRoot;
  // This inert regular file makes accidental legacy database access fail closed.
  process.env.QL_DATA_DIR = '/dev/null';
  process.env.JWT_SECRET ??= randomBytes(64).toString('hex');
  const { runV2Application } = await import('./applicationV2/entry');
  const port = args['--port'] === undefined ? 5600 : Number(args['--port']);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('STARTUP_PORT_INVALID');
  const compiledContracts = path.join(__dirname, 'applicationV2/contracts');
  const diagnostics = process.env.ZHIXU_V2_SHUTDOWN_DIAGNOSTICS === '1';
  let shutdownStarted: bigint | undefined;
  const reportShutdown = (
    event: Pick<V2ShutdownEvent, 'event' | 'phase' | 'elapsed_ms'> &
      Partial<V2ShutdownEvent>,
  ) => {
    shutdownStarted ??= process.hrtime.bigint();
    process.stderr.write(
      JSON.stringify({
        ...event,
        elapsed_ms: Number(process.hrtime.bigint() - shutdownStarted) / 1e6,
      }) + '\n',
    );
  };
  const options = {
    dataRoot: args['--data-root'] as string,
    backupRoot: args['--backup-root'] as string | undefined,
    initialize: args['--initialize'] === true,
    host: args['--host'] as string | undefined,
    publicOrigin: args['--public-origin'] as string | undefined,
    port,
    frontendRoot: args['--frontend-root'] as string | undefined,
    projectRoot,
    artifactRoot: fs.existsSync(compiledContracts)
      ? compiledContracts
      : undefined,
    legacyDataRoots: originalLegacyRoot ? [originalLegacyRoot] : [],
    onShutdownEvent: diagnostics ? reportShutdown : undefined,
    runtimeArtifacts: args['--runtime-artifact-mode']
      ? {
          mode: args[
            '--runtime-artifact-mode'
          ] as RuntimeArtifactOptions['mode'],
          storeRoot: args['--runtime-artifact-store'] as string,
          trustAnchorPath: args['--runtime-artifact-trust-anchor'] as string,
          manifestPath: args['--runtime-artifact-manifest'] as string,
        }
      : undefined,
  };
  let stop!: () => void;
  const stopped = new Promise<void>((r) => {
    stop = r;
  });
  const stopFromSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    if (diagnostics)
      reportShutdown({
        event: 'V2_SHUTDOWN',
        phase: signal + '_RECEIVED',
        elapsed_ms: 0,
      });
    stop();
  };
  process.once('SIGINT', () => stopFromSignal('SIGINT'));
  process.once('SIGTERM', () => stopFromSignal('SIGTERM'));
  if (diagnostics)
    process.once('beforeExit', () => {
      process.stderr.write(
        JSON.stringify({
          event: 'V2_PROCESS_EXIT',
          exit_code: process.exitCode ?? 0,
          elapsed_ms: shutdownStarted
            ? Number(process.hrtime.bigint() - shutdownStarted) / 1e6
            : 0,
        }) + '\n',
      );
    });
  await runV2Application(options, stopped, (current) => {
    const address = current.server!.address() as { port: number };
    process.stdout.write(
      JSON.stringify({
        event: 'V2_HTTP_READY',
        mode: 'v2',
        port: address.port,
        ready: current.ready,
        state: current.state,
        schema_identity: 'zhixu.workspace.v2.s0.1',
        phases: current.phases,
      }) + '\n',
    );
  });
}
void main().catch((error) => {
  const code = error?.error_code ?? error?.code ?? error?.message;
  process.stderr.write(
    JSON.stringify({
      event: 'V2_STARTUP_FAILED',
      error_code:
        typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(code)
          ? code
          : 'STARTUP_REJECTED',
      reason:
        typeof error?.reason === 'string' &&
        /^[A-Z][A-Z0-9_]{0,100}$/.test(error.reason)
          ? error.reason
          : undefined,
    }) + '\n',
  );
  process.exitCode = 1;
});
