const fs = require('node:fs'),
  path = require('node:path');
const entry = path.resolve(__dirname, '../static/build/appV2.js');
if (!fs.existsSync(entry)) {
  process.stderr.write('V2_BUILD_REQUIRED: npm run build:v2\n');
  process.exitCode = 1;
} else require(entry);
