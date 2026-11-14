import fs from 'fs/promises';
import nativeFs from 'fs';
import {
  Sequelize,
  DataTypes,
  Model,
  ModelStatic,
  Transaction,
  literal,
} from 'sequelize';
import sqlite3 from 'sqlite3';
import type { V2Services } from './types';
import RuntimeOperationService from '../services/runtimeOperations';
import PythonEnvironmentService from '../services/pythonEnvironment';
import RuntimePathResolver from '../services/runtimePaths';
import PyenvProvider from '../services/pyenvProvider';
import {
  withRuntimeDomain,
  RuntimeDomainContext,
} from '../services/runtimeDomainScope';
import { fail } from '../services/workspaceV2/errors';
import {
  VerifiedRuntimeArtifactStore,
  RuntimeArtifactOptions,
} from '../services/runtimeArtifacts';
import { bindRuntimeArtifacts } from '../services/runtimeArtifactScope';

const TABLES: Record<string, string> = {
  RuntimeProviderModel: 'RuntimeProviders',
  RuntimeInstallationModel: 'RuntimeInstallations',
  RuntimeOperationModel: 'RuntimeOperations',
  PythonEnvironmentModel: 'PythonEnvironments',
  PythonEnvironmentRevisionModel: 'PythonEnvironmentRevisions',
  PythonEnvironmentBuildModel: 'PythonEnvironmentBuilds',
  NodeEnvironmentModel: 'NodeEnvironments',
  NodeEnvironmentRevisionModel: 'NodeEnvironmentRevisions',
  NodeEnvironmentBuildModel: 'NodeEnvironmentBuilds',
  NodePackageManagerToolchainModel: 'NodePackageManagerToolchains',
};

export interface CandidateRuntimeDomain {
  context: RuntimeDomainContext;
  operations: RuntimeOperationService;
  python: PythonEnvironmentService;
  node: RuntimeOperationService['node'];
  run<T>(action: () => T): T;
  recover(): Promise<void>;
  startRecovery(): void;
  close(): Promise<void>;
}
function defaultValue(raw: string | null, type: string): unknown {
  if (raw === null) return undefined;
  if (raw === 'CURRENT_TIMESTAMP') return literal('CURRENT_TIMESTAMP');
  if (raw === 'NULL') return null;
  if (/^[-+]?\d+(?:\.\d+)?$/.test(raw))
    return type.includes('TINYINT') ? Number(raw) !== 0 : Number(raw);
  const unquoted =
    raw.startsWith("'") && raw.endsWith("'")
      ? raw.slice(1, -1).replace(/''/g, "'")
      : raw;
  if (type === 'JSON') {
    try {
      return JSON.parse(unquoted);
    } catch {
      fail('DATABASE_SCHEMA_CORRUPTED', 503);
    }
  }
  return unquoted;
}

/** Real ORM mapping over the byte-verified frozen tables. Never calls sync/DDL. */
export async function createRuntimeDomain(
  s: Pick<V2Services, 'store' | 'roots' | 'leases'>,
  artifactOptions?: RuntimeArtifactOptions,
): Promise<CandidateRuntimeDomain> {
  await s.store.verifySchema();
  const artifacts = artifactOptions
    ? await VerifiedRuntimeArtifactStore.open(artifactOptions, s.store.dataRoot)
    : undefined;
  const expected = await fs.lstat(s.store.databasePath);
  const file = s.store.databasePath;
  class CandidateDatabase extends sqlite3.Database {
    constructor(
      requested: string,
      mode: number,
      ready: (error: Error | null) => void,
    ) {
      const before = nativeFs.lstatSync(requested);
      if (
        requested !== file ||
        before.isSymbolicLink() ||
        !before.isFile() ||
        before.nlink !== 1 ||
        before.dev !== expected.dev ||
        before.ino !== expected.ino ||
        (mode & sqlite3.OPEN_CREATE) !== 0
      )
        fail('UNSUPPORTED_DATABASE_SCHEMA', 503);
      super(
        requested,
        mode,
        function (this: sqlite3.Database, error: Error | null) {
          if (error) {
            ready(error);
            return;
          }
          // SQLite opens a separate connection for each Sequelize transaction;
          // configure every one before Sequelize can begin a transaction.
          this.exec(
            'PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA busy_timeout=5000;',
            ready,
          );
        },
      );
    }
  }
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: file,
    logging: false,
    transactionType: Transaction.TYPES.IMMEDIATE,
    dialectModule: { ...sqlite3, Database: CandidateDatabase },
    dialectOptions: { mode: sqlite3.OPEN_READWRITE },
    pool: { max: 1, min: 0 },
  });
  let unbindArtifacts: (() => void) | undefined;
  try {
    if (artifacts) unbindArtifacts = bindRuntimeArtifacts(s.store, artifacts);
    await database.authenticate();
    const models: Record<string, ModelStatic<Model>> = {};
    for (const [name, table] of Object.entries(TABLES)) {
      const columns = await s.store.all<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>(`PRAGMA table_info('${table}')`);
      if (!columns.length) fail('DATABASE_SCHEMA_CORRUPTED', 503);
      const attributes: Record<string, any> = {};
      for (const column of columns) {
        const type = column.type.toUpperCase();
        attributes[column.name] = {
          type:
            type === 'JSON'
              ? DataTypes.JSON
              : type.includes('TINYINT')
              ? DataTypes.BOOLEAN
              : type.includes('INT')
              ? DataTypes.INTEGER
              : type.includes('DATE')
              ? DataTypes.DATE
              : type.includes('REAL') || type.includes('FLOAT')
              ? DataTypes.DOUBLE
              : type === 'TEXT'
              ? DataTypes.TEXT
              : DataTypes.STRING,
          allowNull: !column.notnull,
          ...(column.pk ? { primaryKey: true, autoIncrement: true } : {}),
          ...(column.dflt_value === null
            ? {}
            : { defaultValue: defaultValue(column.dflt_value, type) }),
        };
      }
      const indexes: any[] = [];
      for (const index of await s.store.all<{
        name: string;
        unique: number;
        origin: string;
      }>(`PRAGMA index_list('${table}')`)) {
        if (!index.unique || index.origin === 'pk') continue;
        const fields = (
          await s.store.all<{ name: string }>(
            `PRAGMA index_info('${index.name.replace(/'/g, "''")}')`,
          )
        ).map((row) => row.name);
        if (fields.length)
          indexes.push({ name: index.name, unique: true, fields });
      }
      models[name] = database.define(name.replace(/Model$/, ''), attributes, {
        tableName: table,
        freezeTableName: true,
        timestamps: true,
        indexes,
      });
    }
    const context: RuntimeDomainContext = {
      sequelize: database,
      models,
      store: s.store,
      barrier: s.leases.barrier,
      artifacts,
    };
    const operations = withRuntimeDomain(
      context,
      () =>
        new RuntimeOperationService(
          new PyenvProvider(new RuntimePathResolver(s.store.dataRoot)),
        ),
    );
    const python = withRuntimeDomain(
      context,
      () => new PythonEnvironmentService(operations),
    );
    const bind = <T extends object>(value: T): T =>
      new Proxy(value, {
        get(target, key) {
          const member = Reflect.get(target, key, target);
          return typeof member === 'function'
            ? (...args: unknown[]) =>
                withRuntimeDomain(context, () => member.apply(target, args))
            : member;
        },
      });
    const node = bind(operations.node),
      safeOperations = new Proxy(bind(operations), {
        get(target, key) {
          return key === 'node' ? node : Reflect.get(target, key);
        },
      });
    let closed = false;
    return {
      context,
      operations: safeOperations,
      python: bind(python),
      node,
      run: (action) => withRuntimeDomain(context, action),
      recover: () => withRuntimeDomain(context, () => operations.recover()),
      startRecovery: () =>
        withRuntimeDomain(context, () => operations.startRecovery()),
      async close() {
        if (closed) return;
        closed = true;
        try {
          await withRuntimeDomain(context, () => operations.close());
        } finally {
          try {
            await database.close();
          } finally {
            unbindArtifacts?.();
          }
        }
      },
    };
  } catch (error) {
    try {
      await database.close();
    } finally {
      unbindArtifacts?.();
    }
    throw error;
  }
}
