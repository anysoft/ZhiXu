const path = require('node:path'),
  { spawn } = require('node:child_process');
async function startCli(h, dataRoot, initialize = false, extra = []) {
  const entry = path.join(h.projectRoot, 'static/build/appV2.js');
  const child = spawn(
    process.execPath,
    [
      entry,
      '--data-root',
      dataRoot,
      '--port',
      '0',
      ...(initialize ? ['--initialize'] : []),
      ...extra,
    ],
    {
      cwd: h.projectRoot,
      env: {
        ...process.env,
        QL_DATA_DIR: path.join(h.root, 'forbidden-legacy'),
        JWT_SECRET: 'isolated-unused-legacy-key',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let buffer = '',
    settled = false;
  const safe = [];
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(Error('CLI_STARTUP_DEADLINE'));
    }, 90000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const i = buffer.indexOf('\n');
        if (i < 0) break;
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try {
          const row = JSON.parse(line);
          if (row.event === 'V2_HTTP_READY') {
            clearTimeout(timer);
            settled = true;
            resolve(row);
          }
        } catch {}
      }
    });
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        try {
          const row = JSON.parse(line);
          if (row.event === 'V2_STARTUP_FAILED') safe.push(row);
        } catch {}
      }
    });
    child.once('exit', async (code, signal) => {
      if (!settled) {
        clearTimeout(timer);
        await h.record('CLI-STARTUP-FAILED', {
          status: 'FAIL',
          code,
          signal,
          diagnostics: safe,
        });
        reject(Error('CLI_STARTUP_FAILED'));
      }
    });
  });
  return {
    child,
    info,
    origin: 'http://127.0.0.1:' + info.port,
    exited,
    async stop(signal = 'SIGTERM') {
      child.kill(signal);
      return Promise.race([
        exited,
        new Promise((_, reject) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(Error('CLI_SHUTDOWN_DEADLINE'));
          }, 30000);
          timer.unref();
        }),
      ]);
    },
  };
}
module.exports = { startCli };
