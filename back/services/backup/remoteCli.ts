import path from 'path';
import fs from 'fs/promises';
import { openRegular, BackupError } from './files';
import { createRemoteStorage, RemoteTarget } from './remoteStorage';
import { parseRemoteBackupKey } from './remoteKeys';

/** Remote recovery needs only this private configuration file, never the live SQLite store. */
export async function runRemoteBackupCli(args: string[]) {
  const positional: string[] = [],
    values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) positional.push(arg);
    else {
      if (
        !['--config', '--output', '--key'].includes(arg) ||
        values[arg] !== undefined
      )
        throw new BackupError('BACKUP_CLI_ARGUMENT_INVALID');
      const value = args[++i];
      if (!value || value.startsWith('--'))
        throw new BackupError('BACKUP_CLI_ARGUMENT_INVALID');
      values[arg] = value;
    }
  }
  const command = positional[0];
  if (
    !['list', 'download'].includes(command) ||
    !values['--config'] ||
    positional.length !== (command === 'list' ? 1 : 2) ||
    (command === 'list' && (values['--output'] || values['--key'])) ||
    (command === 'download' && !values['--output'])
  )
    throw new BackupError('BACKUP_CLI_ARGUMENT_INVALID');
  const handle = await openRegular(path.resolve(values['--config']));
  let raw: Buffer | undefined;
  let target: RemoteTarget;
  let proxyUrl: string | undefined;
  try {
    if ((await handle.stat()).size > 65536)
      throw new BackupError('BACKUP_REMOTE_CONFIG_INVALID');
    raw = await handle.readFile();
    let value: any;
    try {
      value = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BackupError('BACKUP_REMOTE_CONFIG_INVALID');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new BackupError('BACKUP_REMOTE_CONFIG_INVALID');
    target = value.target ?? value;
    proxyUrl = value.target ? value.proxy_url : undefined;
    if (proxyUrl !== undefined && typeof proxyUrl !== 'string')
      throw new BackupError('BACKUP_REMOTE_CONFIG_INVALID');
    // Profile IDs belong to the lost SQLite database. External recovery must
    // supply the actual proxy explicitly rather than silently connecting direct.
    if (target?.proxy?.mode === 'PROFILE' && !proxyUrl)
      throw new BackupError('BACKUP_REMOTE_CONFIG_INVALID');
  } finally {
    raw?.fill(0);
    await handle.close();
  }
  const storage = createRemoteStorage(target!, proxyUrl);
  try {
    const objects = await storage.list();
    const recognized = objects.flatMap((object) => {
      const metadata = parseRemoteBackupKey(object.key);
      return metadata ? [{ ...object, ...metadata }] : [];
    });
    if (command === 'list')
      return { objects: recognized, integrity: 'NOT_DOWNLOADED_OR_VERIFIED' };
    const matches = recognized.filter((object) => {
      // List output exposes the precise key, also accepted for disambiguation.
      return (
        (object.backup_id === positional[1] || object.key === positional[1]) &&
        (!values['--key'] || values['--key'] === object.key)
      );
    });
    if (!matches.length)
      throw new BackupError('BACKUP_REMOTE_OBJECT_NOT_FOUND');
    if (matches.length !== 1)
      throw new BackupError('BACKUP_REMOTE_OBJECT_AMBIGUOUS');
    const output = path.resolve(values['--output']);
    if (!(await fs.stat(path.dirname(output))).isDirectory())
      throw new BackupError('BACKUP_REMOTE_OUTPUT_INVALID');
    const result = await storage.download(matches[0].key, output);
    return {
      ...result,
      output,
      integrity: 'ENCRYPTED_FILE_DOWNLOADED_NOT_RESTORE_VERIFIED',
      next: 'restore --file <output> --passphrase-file <private-key-file>',
    };
  } finally {
    storage.close();
  }
}
