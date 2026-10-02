'use strict';
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs' },
});
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { scan, audit } = require('../../scripts/branding/audit.cjs');
const { PRODUCT_NAME, productTitle } = require('../../src/utils/brand.ts');
test('official brand is invariant and custom titles remain intact', () => {
  assert.equal(PRODUCT_NAME, 'ZhiXu');
  for (const page of ['Dashboard', '仪表盘', 'Tasks', '任务']) {
    assert.equal(productTitle(page), `ZhiXu · ${page}`);
    assert.equal(productTitle(page, 'My team'), `ZhiXu · ${page} · My team`);
    assert.equal(productTitle(page, 'ZhiXu'), `ZhiXu · ${page}`);
  }
});
test('brand gate recognizes case variants and aliases and never exempts an entire file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-audit-'));
  try {
    const file = 'README.md',
      full = path.join(root, file);
    fs.writeFileSync(full, 'Upstream QingLong\n');
    const row = scan(root, [file]).matches[0];
    const allowed = {
      [row.id]: {
        classification: 'UPSTREAM_ATTRIBUTION_KEEP',
        action: 'KEEP',
        reason: 'Explicit upstream attribution',
      },
    };
    assert.equal(audit(root, [file], allowed).status, 'PASS');
    for (const brand of [
      'QingLong',
      'qinglong',
      'QINGLONG',
      'Qinglong',
      'Qing Long',
      'qing long',
      '青龙',
      '枝序',
      '知序',
      '智序',
      '秩序',
      'QL',
      'ql',
    ]) {
      fs.writeFileSync(full, `Upstream QingLong\nWelcome to ${brand}\n`);
      const result = audit(root, [file], allowed);
      assert.equal(result.status, 'FAIL', brand);
      assert.equal(result.manual_review.length, 1, brand);
    }
    fs.writeFileSync(full, 'Upstream QingLong\n');
    for (const decision of [
      { ...allowed[row.id], reason: '' },
      { ...allowed[row.id], classification: 'INVALID' },
      {
        ...allowed[row.id],
        classification: 'PRODUCT_METADATA_REVIEW',
        action: 'REVIEW',
      },
      { ...allowed[row.id], classification: 'USER_VISIBLE_REPLACE' },
    ])
      assert.equal(audit(root, [file], { [row.id]: decision }).status, 'FAIL');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('metadata and visual sources identify the current brand without changing release identities', () => {
  const pkg = require('../../package.json');
  assert.equal(pkg.name, '@anysoft/zhixu');
  assert.equal(pkg.repository.url, 'https://github.com/anysoft/ZhiXu.git');
  assert.match(
    fs.readFileSync('Dockerfile', 'utf8'),
    /org\.opencontainers\.image\.title="ZhiXu"/,
  );
  assert.match(fs.readFileSync('README.md', 'utf8'), /^# ZhiXu$/m);
  assert.match(fs.readFileSync('src/assets/zhixu-logo.svg', 'utf8'), /ZhiXu/);
  assert.doesNotMatch(
    fs.readFileSync('src/utils/index.ts', 'utf8'),
    /\.d88b\./,
    'retired ASCII wordmark must not return',
  );
});
