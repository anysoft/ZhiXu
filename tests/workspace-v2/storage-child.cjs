// Ignore graceful termination so the inherited lease can be observed after the
// controller is killed; the existing process supervisor then reaps this child.
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid }), {
  mode: 0o600,
});
setInterval(() => {}, 1000);
