'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  cp = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const outputs = new Set([
  'scripts/branding/classifications.json',
  'diagnostics/branding/brand-audit.json',
  'diagnostics/branding/brand-audit.md',
  'diagnostics/branding/brand-audit-before.json',
  'diagnostics/branding/brand-audit-before.md',
]);
function scan(directory = root, files) {
  files ||= cp
    .execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: directory, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
    )
    .split('\0')
    .filter(Boolean);
  const matches = [],
    binaries = [],
    excluded = [];
  for (const file of [...new Set(files)].sort()) {
    if (outputs.has(file)) {
      excluded.push({
        file,
        reason:
          'Generated classification/audit output; source inputs are scanned, output is not recursively scanned.',
      });
      continue;
    }
    const full = path.join(directory, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    const bytes = fs.readFileSync(full);
    if (bytes.includes(0)) {
      binaries.push(file);
      continue;
    }
    const lines = bytes.toString('utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const pattern =
        /青龙|枝序|知序|智序|秩序|\b(?:QL|ql)(?:[_-][A-Za-z0-9_.-]+|[A-Z][A-Za-z0-9]*)?\b/g;
      // Full brand spellings are case-insensitive; QL tokens deliberately preserve token boundaries.
      const found = [
        ...line.matchAll(pattern),
        ...line.matchAll(/qing[ -]?long/gi),
      ];
      const grouped = new Map();
      for (const item of found) {
        const key = item[0];
        if (!grouped.has(key)) grouped.set(key, new Set());
        grouped.get(key).add(item.index + 1);
      }
      for (const [value, columns] of grouped) {
        const fingerprint = crypto
          .createHash('sha256')
          .update(file + '\0' + value + '\0' + line.trim())
          .digest('hex');
        matches.push({
          id: fingerprint,
          file,
          line: index + 1,
          columns: [...columns],
          match: value,
          context:
            line.length > 1400
              ? line.slice(
                  Math.max(0, [...columns][0] - 180),
                  [...columns][0] + 500,
                )
              : line.trim(),
          occurrences: columns.size,
        });
      }
    });
  }
  return { matches, binaries, excluded, files_scanned: files.length };
}
function audit(directory = root, files, decisions) {
  decisions ||= JSON.parse(
    fs.readFileSync(
      path.join(root, 'scripts/branding/classifications.json'),
      'utf8',
    ),
  );
  const scanned = scan(directory, files),
    counts = {};
  const matches = scanned.matches.map((row) => {
    const review = decisions[row.id] || {
      classification: 'UNKNOWN_MANUAL_REVIEW',
      action: 'REVIEW',
      reason: 'New or changed occurrence requires semantic review.',
    };
    counts[review.classification] = (counts[review.classification] || 0) + 1;
    return { ...row, ...review };
  });
  const invalid = matches.filter(
    (x) =>
      ![
        'USER_VISIBLE_REPLACE',
        'PRODUCT_METADATA_REVIEW',
        'INTERNAL_IDENTITY_KEEP',
        'HISTORICAL_EVIDENCE_KEEP',
        'UPSTREAM_ATTRIBUTION_KEEP',
        'TEST_FIXTURE_REVIEW',
        'UNKNOWN_MANUAL_REVIEW',
      ].includes(x.classification) ||
      !x.reason ||
      !['KEEP', 'REPLACE', 'REVIEW', 'MARK_HISTORICAL'].includes(x.action),
  );
  const pending = matches.filter(
    (x) => x.classification === 'UNKNOWN_MANUAL_REVIEW' || x.action !== 'KEEP',
  );
  const visible = matches.filter(
    (x) => x.classification === 'USER_VISIBLE_REPLACE',
  );
  return {
    ...scanned,
    matches,
    product_name: 'ZhiXu',
    old_brand: ['QingLong', '青龙', '枝序'],
    counts,
    user_visible_remaining: visible.length,
    user_visible_qinglong: visible.filter((x) => /qing[ -]?long/i.test(x.match))
      .length,
    user_visible_青龙: visible.filter((x) => x.match === '青龙').length,
    manual_review: pending,
    invalid_decisions: invalid,
    status:
      visible.length || pending.length || invalid.length ? 'FAIL' : 'PASS',
  };
}
if (require.main === module) {
  const raw = process.argv.includes('--inventory');
  const result = raw ? scan() : audit();
  const output = process.argv.indexOf('--output');
  if (output >= 0)
    fs.writeFileSync(
      process.argv[output + 1],
      JSON.stringify(result, null, 2) + '\n',
    );
  else console.log(JSON.stringify(result, null, 2));
  if (!raw && result.status !== 'PASS') process.exitCode = 1;
}
module.exports = { scan, audit };

function markdown(result) {
  const escape = (value) =>
    String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  return (
    '# ZhiXu brand audit\n\n' +
    'Status: ' +
    result.status +
    '\n\n' +
    'All tracked text and non-ignored new source files are scanned. Generated audit outputs are excluded by exact filename to avoid recursive reporting. Binary assets are listed for separate visual review. Exceptions are exact file/value/line-content fingerprints, not directory exclusions.\n\n' +
    'Locations: ' +
    result.matches.length +
    '; occurrences: ' +
    result.matches.reduce((n, row) => n + row.occurrences, 0) +
    '\n\n' +
    'Current user-visible old brand: ' +
    result.user_visible_remaining +
    '; unresolved: ' +
    result.manual_review.length +
    '\n\n' +
    '| File | Line | Match | Classification | Action | Reason |\n|---|---:|---|---|---|---|\n' +
    result.matches
      .map(
        (row) =>
          '| ' +
          [
            row.file,
            row.line,
            row.match,
            row.classification,
            row.action,
            row.reason,
          ]
            .map(escape)
            .join(' | ') +
          ' |',
      )
      .join('\n') +
    '\n'
  );
}
module.exports.markdown = markdown;
if (require.main === module && process.argv.includes('--markdown')) {
  const result = audit();
  fs.writeFileSync(
    process.argv[process.argv.indexOf('--markdown') + 1],
    markdown(result),
  );
}
