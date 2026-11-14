// Policy-unit transport checkpoints, never Runtime installation qualification.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createOfflineFixture } = require('./s5r-offline-fixture.cjs');

for (const mode of ['ONLINE_VERIFIED', 'OFFLINE_VERIFIED'])
  test(
    'S5R pip transport policy unit preserves online index selection and limits no-index to ' +
      mode,
    async (t) => {
      const f = await createOfflineFixture(t);
      f.options.mode = mode;
      const artifacts = await f.open();
      const Paths = f.module('back/services/runtimePaths.ts').default;
      const EnvPaths = f.module(
        'back/services/pythonEnvironmentPaths.ts',
      ).default;
      const Pip = f.module('back/services/pipPackageManager.ts').default;
      const pip = new Pip(new EnvPaths(new Paths(f.dataRoot))),
        calls = [];
      const ctx = {
        directory: f.root,
        environment: { PATH: '/usr/bin:/bin' },
        command: {
          run: async (...args) => {
            calls.push(args);
            return '';
          },
        },
      };
      await f.scope.withRuntimeDomain({ artifacts }, async () => {
        if (mode === 'OFFLINE_VERIFIED') {
          await assert.rejects(
            pip.install(ctx, '/unit-only/venv/bin/python', [
              { requirement: 'six==1.17.0' },
            ]),
            { error_code: 'RUNTIME_ARTIFACT_CLOSURE_UNAVAILABLE' },
          );
          assert.equal(calls.length, 0);
          await pip.run(ctx, '/unit-only/venv/bin/python', [
            'list',
            '--format=json',
          ]);
          assert.equal(calls[0][3].PIP_NO_INDEX, '1');
        } else {
          // This unit checks transport policy only. The real online fixture
          // separately runs install/verify with approved physical Python/pip.
          await pip.run(ctx, '/unit-only/venv/bin/python', [
            'install',
            '--index-url',
            'https://pypi.org/simple',
            '--',
            'six==1.17.0',
          ]);
          assert.equal(calls.length, 1);
          assert.equal(calls[0][3].PIP_NO_INDEX, undefined);
          assert.equal(calls[0][3].PIP_CONFIG_FILE, '/dev/null');
          assert.ok(calls[0][1].includes('install'));
          assert.ok(calls[0][1].includes('https://pypi.org/simple'));
          assert.ok(calls[0][1].includes('six==1.17.0'));
        }
      });
    },
  );

test('S5R Node Provider policy unit refuses unconfigured v2 while preserving the outside-domain official HTTPS path', async (t) => {
  const f = await createOfflineFixture(t);
  const Paths = f.module('back/services/nodePaths.ts').default;
  const Provider = f.module(
    'back/services/nodeDistributionProvider.ts',
  ).default;
  const provider = new Provider(new Paths(f.dataRoot)),
    calls = [];
  const checkpoint = Error('UNIT_TRANSPORT_CHECKPOINT_NOT_AN_INSTALL');
  const ctx = {
    directory: f.root,
    environment: { PATH: '/usr/bin:/bin' },
    stage: async () => {},
    command: {
      run: async (...args) => {
        calls.push(args);
        throw checkpoint;
      },
    },
  };
  const runtime = { version: '24.22.3', metadata: {} };
  await assert.rejects(
    provider.install(ctx, runtime),
    (error) => error === checkpoint,
  );
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0][1].some(
      (arg) =>
        typeof arg === 'string' &&
        arg.startsWith('https://nodejs.org/dist/v24.22.3/'),
    ),
  );
  calls.length = 0;
  await f.scope.withRuntimeDomain({}, async () => {
    await assert.rejects(provider.install(ctx, runtime), {
      error_code: 'RUNTIME_ARTIFACT_TRUST_CONFIGURATION_REQUIRED',
    });
  });
  assert.equal(calls.length, 0);
});
test('S5R pip policy unit cannot execute an old READY interpreter in a v2 domain without independent trust', async (t) => {
  const f = await createOfflineFixture(t);
  const Paths = f.module('back/services/runtimePaths.ts').default;
  const EnvPaths = f.module('back/services/pythonEnvironmentPaths.ts').default;
  const Pip = f.module('back/services/pipPackageManager.ts').default;
  const pip = new Pip(new EnvPaths(new Paths(f.dataRoot)));
  let commands = 0;
  const ctx = {
    directory: f.root,
    environment: {},
    command: {
      run: async () => {
        commands++;
        return '';
      },
    },
  };
  await f.scope.withRuntimeDomain({}, async () => {
    await assert.rejects(pip.run(ctx, '/old-ready/venv/bin/python', ['list']), {
      error_code: 'RUNTIME_ARTIFACT_TRUST_CONFIGURATION_REQUIRED',
    });
    await assert.rejects(pip.install(ctx, '/old-ready/venv/bin/python', []), {
      error_code: 'RUNTIME_ARTIFACT_TRUST_CONFIGURATION_REQUIRED',
    });
  });
  assert.equal(commands, 0);
});

test('S5R Python Provider policy unit refuses unconfigured v2 while preserving the outside-domain exact Git source pin', async (t) => {
  const f = await createOfflineFixture(t);
  const Paths = f.module('back/services/runtimePaths.ts').default;
  const Provider = f.module('back/services/pyenvProvider.ts').default;
  const provider = new Provider(new Paths(f.dataRoot)),
    calls = [];
  const checkpoint = Error('UNIT_SOURCE_PIN_CHECKPOINT_NOT_AN_INSTALL');
  const directory = path.join(f.root, 'context');
  await fs.mkdir(directory, { mode: 0o700 });
  const ctx = {
    directory,
    environment: { PATH: '/usr/bin:/bin' },
    stage: async () => {},
    command: {
      run: async (...args) => {
        calls.push(args);
        if (args[1][0] === 'fetch') throw checkpoint;
        return '';
      },
    },
  };
  await assert.rejects(provider.setup(ctx), (error) => error === checkpoint);
  assert.deepEqual(calls[1][1], [
    'fetch',
    '--depth=1',
    'https://github.com/pyenv/pyenv.git',
    provider.revision,
  ]);
  calls.length = 0;
  await f.scope.withRuntimeDomain({}, async () => {
    await assert.rejects(provider.setup(ctx), {
      error_code: 'RUNTIME_ARTIFACT_TRUST_CONFIGURATION_REQUIRED',
    });
    await assert.rejects(
      provider.install(
        ctx,
        { version: '3.13.15', metadata: {} },
        provider.revision,
      ),
      { error_code: 'RUNTIME_ARTIFACT_TRUST_CONFIGURATION_REQUIRED' },
    );
  });
  assert.equal(calls.length, 0);
});
