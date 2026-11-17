import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { assertV2BackendNode } from './applicationV2/backendNode';
import { openRegular } from './services/backup/files';
import type { BackupMode } from './services/workspaceV2/manifest';

const HELP = `ZhiXu v2 offline backup management

Usage: node /app/static/build/backupCliV2.js <command> [options]

  list                         List local snapshots, independently of the live database
  info <id>                    Show a snapshot manifest
  verify <id>                  Verify manifest, SQLite, hashes and Workspace/Git data
  create [--mode full|lightweight] Create a snapshot of a healthy, stopped instance
  restore --snapshot <id>      Restore a local snapshot; preserve the old data root
  restore --file <path>        Import and restore an encrypted Portable backup
  restore --resume             Resume an interrupted restore using its existing journal
  status                       Show the restore journal and required follow-up
  remote list --config <file>  List remote backups without the original database
  remote download <id> --config <file> --output <file>
                               Download an encrypted backup; then use restore --file

Options:
  --data-root <absolute path>   Defaults to ZHIXU_V2_DATA_ROOT
  --backup-root <absolute path> Defaults to ZHIXU_V2_BACKUP_ROOT, or <data-root>-backups
  --mode full|lightweight       Create only; defaults to full. Lightweight Git recovery needs the remote.
  --passphrase-file <path>      Private, service-user-owned file for restore --file
  --passphrase-stdin            Read the passphrase from stdin for restore --file
  --help                       Show this help without opening storage

Stop the normal backend before create or restore. Restore uses the existing
candidate/journal/root-swap protocol and keeps old data in quarantine.
Never pass a plaintext passphrase as a command-line argument.
`;

interface BackupCliArguments {
  command: 'list' | 'info' | 'verify' | 'create' | 'restore' | 'status';
  dataRoot: string;
  backupRoot: string;
  mode: BackupMode;
  id?: string;
  snapshot?: string;
  file?: string;
  resume?: boolean;
  passphraseFile?: string;
  passphraseStdin?: boolean;
}
function usageError(): never {
  throw Object.assign(new Error('BACKUP_CLI_ARGUMENT_INVALID'), {
    error_code: 'BACKUP_CLI_ARGUMENT_INVALID',
    status: 400,
  });
}
export function parseBackupCliArguments(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): BackupCliArguments {
  const values: Record<string, string | boolean> = {},
    positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!key.startsWith('--')) {
      positional.push(key);
      continue;
    }
    if (
      ![
        '--data-root',
        '--backup-root',
        '--mode',
        '--snapshot',
        '--file',
        '--resume',
        '--passphrase-file',
        '--passphrase-stdin',
      ].includes(key) ||
      values[key] !== undefined
    )
      usageError();
    if (['--resume', '--passphrase-stdin'].includes(key)) values[key] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) usageError();
      values[key] = value;
    }
  }
  const command = positional[0] as BackupCliArguments['command'];
  if (
    !['list', 'info', 'verify', 'create', 'restore', 'status'].includes(command)
  )
    usageError();
  if (positional.length !== (['info', 'verify'].includes(command) ? 2 : 1))
    usageError();
  if (
    values['--mode'] !== undefined &&
    (command !== 'create' ||
      !['full', 'lightweight'].includes(values['--mode'] as string))
  )
    usageError();
  const restoreOptions = ['--snapshot', '--file', '--resume'],
    phraseOptions = ['--passphrase-file', '--passphrase-stdin'];
  if (command === 'restore') {
    if (restoreOptions.filter((key) => values[key] !== undefined).length !== 1)
      usageError();
    if (
      phraseOptions.filter((key) => values[key] !== undefined).length !==
      (values['--file'] ? 1 : 0)
    )
      usageError();
  } else if (
    [...restoreOptions, ...phraseOptions].some(
      (key) => values[key] !== undefined,
    )
  )
    usageError();
  const dataRoot = values['--data-root'] ?? environment.ZHIXU_V2_DATA_ROOT;
  if (typeof dataRoot !== 'string' || !dataRoot)
    throw new Error('EXPLICIT_DATA_ROOT_REQUIRED');
  const backupRoot =
    values['--backup-root'] ??
    environment.ZHIXU_V2_BACKUP_ROOT ??
    dataRoot + '-backups';
  for (const root of [dataRoot, backupRoot])
    if (
      typeof root !== 'string' ||
      !path.isAbsolute(root) ||
      path.resolve(root) !== root ||
      root === path.parse(root).root
    )
      throw new Error('BACKUP_ROOT_INVALID');
  return {
    command,
    dataRoot,
    backupRoot: backupRoot as string,
    mode: values['--mode'] === 'lightweight' ? 'LIGHTWEIGHT' : 'FULL',
    id: positional[1],
    snapshot: values['--snapshot'] as string | undefined,
    file: values['--file']
      ? path.resolve(values['--file'] as string)
      : undefined,
    resume: values['--resume'] === true,
    passphraseFile: values['--passphrase-file']
      ? path.resolve(values['--passphrase-file'] as string)
      : undefined,
    passphraseStdin: values['--passphrase-stdin'] === true,
  };
}

/** Keep secrets out of argv and clear both input and returned buffers after use. */
export async function readBackupPassphrase(options: {
  passphraseFile?: string;
  passphraseStdin?: boolean;
}): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0,
    raw: Buffer | undefined;
  try {
    if (options.passphraseFile) {
      const handle = await openRegular(options.passphraseFile);
      try {
        if ((await handle.stat()).size > 4098)
          throw new Error('BACKUP_PASSPHRASE_INVALID');
        for await (const chunk of handle.createReadStream({
          autoClose: false,
        })) {
          size += chunk.length;
          if (size > 4098) throw new Error('BACKUP_PASSPHRASE_INVALID');
          chunks.push(Buffer.from(chunk));
        }
      } finally {
        await handle.close();
      }
    } else if (options.passphraseStdin) {
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 4098) throw new Error('BACKUP_PASSPHRASE_INVALID');
        chunks.push(Buffer.from(chunk));
      }
    } else throw new Error('BACKUP_PASSPHRASE_REQUIRED');
    raw = Buffer.concat(chunks);
    let end = raw.length;
    if (raw[end - 1] === 10) {
      end--;
      if (raw[end - 1] === 13) end--;
    }
    if (!end || end > 4096) throw new Error('BACKUP_PASSPHRASE_INVALID');
    return Buffer.from(raw.subarray(0, end));
  } finally {
    raw?.fill(0);
    chunks.forEach((chunk) => chunk.fill(0));
  }
}

async function backupProjectRoot() {
  let current = __dirname;
  for (;;) {
    const file = path.join(current, 'package.json');
    const contents = await fs.readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (contents && JSON.parse(contents).name === '@anysoft/zhixu')
      return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('PROJECT_ROOT_REQUIRED');
    current = parent;
  }
}

export async function runBackupCliV2(args = process.argv.slice(2)) {
  if (args.includes('--help') || args[0] === 'help') {
    process.stdout.write(HELP);
    return;
  }
  assertV2BackendNode(process.versions.node);
  if (args[0] === 'remote') {
    const { runRemoteBackupCli } = await import('./services/backup/remoteCli');
    const result = await runRemoteBackupCli(args.slice(1));
    process.stdout.write(JSON.stringify({ code: 200, data: result }) + '\n');
    return;
  }
  const options = parseBackupCliArguments(args),
    projectRoot = await backupProjectRoot(),
    originalLegacyRoot = process.env.QL_DATA_DIR;
  // Like appV2, accidental legacy access fails on an inert regular file.
  // Do this before loading configuration or any backup implementation.
  process.env.QL_DIR = projectRoot;
  process.env.QL_DATA_DIR = '/dev/null';
  process.env.JWT_SECRET ??= randomBytes(64).toString('hex');
  const { validateV2DataRoot } = await import('./applicationV2/bootstrap');
  validateV2DataRoot({
    dataRoot: options.dataRoot,
    backupRoot: options.backupRoot,
    projectRoot,
    legacyDataRoots: originalLegacyRoot ? [originalLegacyRoot] : [],
  });
  const { OfflineBackupManager } = await import('./services/backup/offline');
  const manager = new OfflineBackupManager({
    dataRoot: options.dataRoot,
    backupRoot: options.backupRoot,
    projectRoot,
  });
  let result: unknown, phrase: Buffer | undefined;
  try {
    switch (options.command) {
      case 'list':
        result = await manager.list();
        break;
      case 'info':
        result = await manager.info(options.id!);
        break;
      case 'verify':
        result = await manager.verify(options.id!);
        break;
      case 'create':
        result = await manager.create(options.mode);
        break;
      case 'status':
        result = await manager.status();
        break;
      case 'restore':
        if (options.resume) result = await manager.resume();
        else if (options.snapshot)
          result = await manager.restoreSnapshot(options.snapshot);
        else {
          phrase = await readBackupPassphrase(options);
          result = await manager.restoreFile(options.file!, phrase);
        }
        break;
    }
    process.stdout.write(JSON.stringify({ code: 200, data: result }) + '\n');
  } finally {
    phrase?.fill(0);
  }
}

function backupCliHint(code: string): string {
  if (code.startsWith('BACKUP_REMOTE_'))
    return 'Check the private --config file, endpoint, credentials and network. Keep the independent recovery passphrase. Downloaded files still require restore --file authentication and integrity validation; use --key for ambiguous IDs.';
  if (code === 'BACKUP_LIGHTWEIGHT_EXTERNAL_GIT_UNSUPPORTED')
    return 'Lightweight backup does not support this external Git data layout. Use FULL and review LFS/submodule backup warnings.';
  if (
    code === 'RESTORE_LIGHTWEIGHT_REMOTE_UNAVAILABLE_USE_FULL' ||
    code === 'RESTORE_LIGHTWEIGHT_BASE_MISSING_USE_FULL'
  )
    return 'Restore access to the original Git remote and required objects, check credentials/proxy, then run restore --resume. A pending journal blocks another restore on this data root; alternatively restore a FULL backup to a separate fresh data root or volume. Keep the original data and journal.';
  if (
    code.startsWith('BACKUP_LIGHTWEIGHT_') ||
    code.startsWith('RESTORE_LIGHTWEIGHT_')
  )
    return 'The lightweight data could not be validated or reconstructed. Keep the original data and journal, verify the backup and run status. If using a FULL backup while a restore is pending, restore it to a separate fresh data root or volume.';
  if (code === 'RESTORE_BACKEND_ACTIVE')
    return 'Stop the normal ZhiXu backend, then retry this offline command.';
  if (
    code === 'BACKUP_AUTHENTICATION_FAILED' ||
    code.startsWith('BACKUP_PASSPHRASE')
  )
    return 'Use the correct Portable backup passphrase via a private file or --passphrase-stdin.';
  if (
    [
      'BACKUP_FILE_INVALID',
      'BACKUP_PERMISSION_INVALID',
      'EACCES',
      'EPERM',
    ].includes(code)
  )
    return 'Use private files and directories owned by the ZhiXu service user (10001:10001 in Docker).';
  if (
    code === 'BACKUP_CLI_ARGUMENT_INVALID' ||
    code === 'EXPLICIT_DATA_ROOT_REQUIRED'
  )
    return 'Run --help for commands and required storage roots.';
  if (code === 'ENOENT')
    return 'Check the snapshot ID, mounted backup volume and input file paths.';
  if (/DISK|QUOTA/.test(code))
    return 'Free space for both the restore candidate and retained old data; do not remove the only backup.';
  if (/RESTORE_PENDING|RECOVERY|RESTORE_ROLLED_BACK/.test(code))
    return 'Run status. Use restore --resume for an interrupted restore; retain the journal and quarantined data.';
  return 'Run status and verify the selected backup. Original and quarantined data are preserved.';
}

if (require.main === module)
  void runBackupCliV2().catch((error: unknown) => {
    const e = error as {
        error_code?: unknown;
        code?: unknown;
        message?: unknown;
        status?: number;
      },
      candidate = e.error_code ?? e.code ?? e.message,
      error_code =
        typeof candidate === 'string' &&
        /^[A-Z][A-Z0-9_]{0,100}$/.test(candidate)
          ? candidate
          : 'BACKUP_OPERATION_FAILED';
    process.stderr.write(
      JSON.stringify({
        code: e.status && e.status >= 400 && e.status < 600 ? e.status : 500,
        error_code,
        hint: backupCliHint(error_code),
      }) + '\n',
    );
    process.exitCode = error_code === 'BACKUP_CLI_ARGUMENT_INVALID' ? 2 : 1;
  });
