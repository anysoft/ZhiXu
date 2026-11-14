'use strict';
const http = require('node:http');

function checkHealth(environment = process.env) {
  return new Promise((resolve) => {
    let origin;
    try {
      origin = new URL(environment.ZHIXU_V2_PUBLIC_ORIGIN);
      if (
        !['http:', 'https:'].includes(origin.protocol) ||
        origin.origin !== environment.ZHIXU_V2_PUBLIC_ORIGIN ||
        origin.username ||
        origin.password
      )
        return resolve(false);
    } catch {
      return resolve(false);
    }
    let bytes = 0;
    const chunks = [];
    const request = http.get(
      {
        hostname: '127.0.0.1',
        port: 5600,
        path: '/api/system',
        headers: { Host: origin.host },
        timeout: 4000,
      },
      (response) => {
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 16384) request.destroy();
          else chunks.push(chunk);
        });
        response.on('error', () => resolve(false));
        response.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(
              response.statusCode === 200 &&
                result.code === 200 &&
                result.data?.mode === 'v2' &&
                result.data.ready === true &&
                result.data.local_write_admission === true &&
                result.data.schema_identity === 'zhixu.workspace.v2.s0.1',
            );
          } catch {
            resolve(false);
          }
        });
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

if (require.main === module)
  checkHealth().then((ready) => {
    process.exitCode = ready ? 0 : 1;
  });
module.exports = { checkHealth };
