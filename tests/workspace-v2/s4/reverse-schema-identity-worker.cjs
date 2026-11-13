const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async function reverseSchemaIdentityQualification() {
  let sequelize;
  try {
    const dataRoot = process.argv[2];
    assert.equal(process.env.QL_DATA_DIR, dataRoot);
    const data = require('../../../back/data/index');
    sequelize = data.sequelize;
    const config = require('../../../back/config/index').default;
    assert.equal(config.dataPath, dataRoot);
    assert.equal(config.dbPath, path.join(dataRoot, 'db/'));
    const directory = path.resolve(__dirname, '../../../back/data');
    const modules = fs.readdirSync(directory).filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts')).sort();
    for (const name of modules) require(path.join(directory, name));
    const models = Object.values(sequelize.models);
    assert.ok(models.length > 0);
    const { initializeOperationalSchema } = require('../../../back/shared/operationalSchema');
    let rejection;
    try { await initializeOperationalSchema(sequelize, models); }
    catch (error) { rejection = error; }
    assert.equal(rejection?.code, 'UNSUPPORTED_DATABASE_SCHEMA');
    const forbiddenBootModules = ['back/loaders/db.ts', 'back/shared/bootstrapDirectories.ts', 'back/app.ts'];
    const project = path.resolve(__dirname, '../../..');
    const loaded = Object.keys(require.cache)
      .filter((file) => file.startsWith(project + path.sep))
      .map((file) => path.relative(project, file).split(path.sep).join('/'));
    assert.deepEqual(loaded.filter((file) => forbiddenBootModules.includes(file)), []);
    await sequelize.close(); sequelize = undefined;
    process.send({ success: true, error_code: rejection.code,
      registered_model_count: models.length,
      registered_model_tables: models.map((model) => String(model.tableName)).sort(),
      actual_v9_data_modules: modules.map((name) => 'back/data/' + name),
      actual_initializer: 'back/shared/operationalSchema.ts#initializeOperationalSchema',
      module_loader_interception: false, model_mocks: false,
      v9_full_server_started: false, bootstrap_directories_called: false,
    });
  } catch (error) {
    process.send({ success: false, error_code: /^[A-Z][A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'REVERSE_SCHEMA_IDENTITY_ASSERTION_FAILED' });
    process.exitCode = 1;
  } finally { await sequelize?.close(); }
})();
