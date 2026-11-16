const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createFixture } = require('../workspace-v2/fixture.cjs');
const {
  createRuntimeDomain,
} = require('../../back/applicationV2/runtimeDomain');
const { runtimeApiRoutes } = require('../../back/applicationV2/runtimeApi');
const { operationDto } = require('../../back/api/runtime');
const {
  parseHistoryQuery,
  historyWhere,
} = require('../../back/shared/historyQuery');

const statuses = [
  'QUEUED',
  'RUNNING',
  'SUCCESS',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
];
test('history ranges default to seven UTC days, normalize offsets and reject invalid dates or pagination', () => {
  const now = new Date('2026-11-16T12:00:00.000Z');
  assert.deepEqual(parseHistoryQuery({}, { statuses, now }), {
    page: 1,
    size: 20,
    offset: 0,
    from: '2026-11-09T12:00:00.000Z',
    to: now.toISOString(),
  });
  const q = parseHistoryQuery(
    {
      from: '2026-11-10T08:00:00+08:00',
      to: '2026-11-12T00:00:00Z',
      page: '2',
      size: '5',
      status: 'FAILED',
    },
    { statuses, now },
  );
  assert.equal(q.from, '2026-11-10T00:00:00.000Z');
  assert.equal(q.offset, 5);
  const sql = historyWhere(q, 'COALESCE(started_at,createdAt)');
  assert.equal(sql.clauses.length, 3);
  assert.deepEqual(sql.values, [q.from, q.to, 'FAILED']);
  for (const query of [
    { from: '2026-02-30T00:00:00Z' },
    { from: '2026-11-10T00:00:00' },
    { from: '2026-11-12T00:00:00Z', to: '2026-11-10T00:00:00Z' },
    { from: '2026-11-10T00:00:00Z', to: '2026-11-10T00:00:00Z' },
    { page: 0 },
    { size: 201 },
    { page: ['1'] },
    { status: 'INVENTED' },
  ])
    assert.throws(() => parseHistoryQuery(query, { statuses, now }), {
      error_code: 'INVALID_REQUEST',
    });
});

async function fixture(t) {
  const f = await createFixture(t),
    domain = await createRuntimeDomain(f);
  t.after(() => domain.close());
  for (const [id, language, type] of [
    [1, 'PYTHON', 'PYENV'],
    [2, 'NODE', 'NODE_DISTRIBUTION'],
  ])
    await f.store.run(
      "INSERT INTO RuntimeProviders(id,language,provider_type,state,install_root,createdAt,updatedAt) VALUES(?,?,?,'READY',?,?,?)",
      [
        id,
        language,
        type,
        f.dataRoot + '/unused-provider',
        '2026-11-01T00:00:00Z',
        '2026-11-01T00:00:00Z',
      ],
    );
  async function seed(
    id,
    status,
    started,
    created = '2026-11-11T00:00:00Z',
    language = 'PYTHON',
  ) {
    const dbDate = (value) =>
      value === null
        ? null
        : new Date(value)
            .toISOString()
            .replace('T', ' ')
            .replace('Z', ' +00:00');
    await f.store.run(
      'INSERT INTO RuntimeOperations(id,provider_id,operation_type,status,stage,owner_token,owner_pid,started_at,finished_at,log_identity,metadata,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        language === 'NODE' ? 2 : 1,
        language === 'NODE' ? 'NODE_CATALOG_REFRESH' : 'CATALOG_REFRESH',
        status,
        'COMPLETE',
        'fixture-owner',
        process.pid,
        dbDate(started),
        status === 'RUNNING' ? null : dbDate(created),
        'runtime-operation-' + id,
        '{}',
        dbDate(created),
        dbDate(created),
      ],
    );
  }
  await seed(1, 'SUCCESS', '2026-11-01T00:00:00Z');
  await seed(2, 'FAILED', '2026-11-10 00:00:00.000 +00:00');
  await seed(3, 'SUCCESS', '2026-11-10T10:00:00+08:00');
  await seed(4, 'CANCELLED', null);
  await seed(5, 'SUCCESS', '2026-11-12T00:00:00Z');
  await seed(6, 'FAILED', '2026-11-10T03:00:00Z', undefined, 'NODE');
  return {
    ...f,
    domain,
    seed,
    query: (q) => domain.run(() => domain.operations.operations(q)),
  };
}
test('Runtime history performs count, date/state/language filter and limit/offset on the database', async (t) => {
  const f = await fixture(t),
    range = { from: '2026-11-10T00:00:00Z', to: '2026-11-12T00:00:00Z' };
  const one = await f.query({ ...range, page: '1', size: '2' }),
    two = await f.query({ ...range, page: '2', size: '2' });
  assert.equal(one.total, 4);
  assert.deepEqual(
    one.items.map((x) => x.id),
    [6, 4],
  );
  assert.deepEqual(
    two.items.map((x) => x.id),
    [3, 2],
  );
  assert.deepEqual(
    (await f.query({ ...range, status: 'FAILED' })).items.map((x) => x.id),
    [6, 2],
  );
  assert.deepEqual(
    (await f.query({ ...range, language: 'PYTHON' })).items.map((x) => x.id),
    [4, 3, 2],
  );
  assert.deepEqual(
    (await f.query({ ...range, language: 'NODE' })).items.map((x) => x.id),
    [6],
  );
  const now = Date.now();
  await f.seed(
    7,
    'SUCCESS',
    new Date(now - 3600000).toISOString(),
    new Date(now).toISOString(),
  );
  await f.seed(
    8,
    'SUCCESS',
    new Date(now - 8 * 86400000).toISOString(),
    new Date(now - 8 * 86400000).toISOString(),
  );
  const recent = await f.query({ page: '1', size: '200' });
  assert.ok(recent.items.some((x) => x.id === 7));
  assert.ok(!recent.items.some((x) => x.id === 8));
  const legacy = await f.domain.run(() => f.domain.operations.operations());
  assert.ok(Array.isArray(legacy));
  assert.equal(legacy.length, 8);
  // Raw SQLite ISO values are valid history timestamps too; Sequelize DATE
  // parsing formerly produced Invalid Date for these in the detail/legacy path.
  await f.store.run(
    'UPDATE RuntimeOperations SET started_at=?,finished_at=?,createdAt=? WHERE id=2',
    [
      '2026-11-10T08:00:00+08:00',
      '2026-11-10T00:00:01Z',
      '2026-11-10T00:00:00Z',
    ],
  );
  const detail = await f.domain.run(() => f.domain.operations.operation(2));
  assert.equal(detail.started_at.toISOString(), '2026-11-10T00:00:00.000Z');
  assert.equal(
    (await f.domain.run(() => f.domain.operations.operations()))
      .find((x) => x.id === 2)
      .finished_at.toISOString(),
    '2026-11-10T00:00:01.000Z',
  );
  await assert.rejects(f.query({ from: 'bad' }), {
    error_code: 'RUNTIME_REQUEST_INVALID',
  });
  await assert.rejects(f.query({ language: ['NODE'] }), {
    error_code: 'RUNTIME_REQUEST_INVALID',
  });
});
test('Runtime history HTTP adapters retain legacy arrays, accept paging and explicitly represent cleaned logs', async (t) => {
  const f = await fixture(t),
    routes = runtimeApiRoutes(f, f.domain);
  const call = async (key, query = {}, params = {}, body = {}) => {
    const route = routes[key];
    assert.ok(route, key);
    return (typeof route === 'function' ? route : route.handle)({
      query,
      params,
      body,
      principal: {
        kind: 'PANEL_OWNER',
        username: 'fixture',
        platform: 'desktop',
      },
    });
  };
  assert.ok(Array.isArray(await call('GET /runtime/operations')));
  const page = await call('GET /runtime/operations', {
    page: '1',
    size: '1',
    from: '2026-11-10T00:00:00Z',
    to: '2026-11-12T00:00:00Z',
    language: 'NODE',
  });
  assert.equal(page.total, 1);
  assert.equal(page.items[0].language, 'NODE');
  const python = await call('GET /runtime/python/operations', {
    page: '1',
    size: '20',
    from: '2026-11-10T00:00:00Z',
    to: '2026-11-12T00:00:00Z',
  });
  assert.equal(python.total, 3);
  assert.ok(python.items.every((x) => x.language === 'PYTHON'));
  const file = await f.domain.run(() => f.domain.operations.paths.log(2));
  await fs.writeFile(file, 'recorded log', { mode: 0o600 });
  const before = await call('GET /runtime/operations/:id/log', {}, { id: '2' });
  assert.equal(before.text, 'recorded log');
  assert.equal(before.log_cleaned, false);
  await fs.unlink(file);
  await f.store.run('UPDATE RuntimeOperations SET metadata=? WHERE id=2', [
    JSON.stringify({ log_cleaned: true }),
  ]);
  assert.deepEqual(
    await call('GET /runtime/operations/:id/log', {}, { id: '2' }),
    { text: '', size: 0, truncated: false, log_cleaned: true },
  );
  assert.equal(
    (await call('GET /runtime/operations/:id', {}, { id: '2' })).log_cleaned,
    true,
  );
  assert.equal(
    operationDto(await f.domain.run(() => f.domain.operations.operation(2)))
      .log_cleaned,
    true,
  );
  await assert.rejects(call('GET /runtime/operations', { page: '0' }), {
    error_code: 'RUNTIME_REQUEST_INVALID',
  });
});
