import type {
  BackupMode,
  BackupSource,
  WorkspaceBackupManifest,
} from '../workspaceV2/manifest';

/** Self-describing names allow recovery without the original SQLite/catalog. */
export function parseRemoteBackupKey(key: string): {
  backup_id: string;
  created_at: string;
  mode: BackupMode;
  source: BackupSource;
} | null {
  const match =
    /^zhixu-v2\/(MANUAL|SCHEDULED)\/(FULL|LIGHTWEIGHT)\/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.encrypted$/.exec(
      key,
    );
  if (!match) return null;
  if (match[1] === 'SCHEDULED' && match[2] !== 'LIGHTWEIGHT') return null;
  const created = match[3].replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
  if (
    !Number.isFinite(Date.parse(created)) ||
    new Date(created).toISOString() !== created
  )
    return null;
  return {
    source: match[1] as BackupSource,
    mode: match[2] as BackupMode,
    created_at: created,
    backup_id: match[4],
  };
}

export function remoteBackupKey(
  manifest: WorkspaceBackupManifest,
  source: BackupSource,
) {
  return `zhixu-v2/${source}/${manifest.backup_mode ?? 'FULL'}/${new Date(
    manifest.created_at,
  )
    .toISOString()
    .replace(/T(\d{2}):(\d{2}):(\d{2})/, 'T$1-$2-$3')}-${
    manifest.backup_id
  }.encrypted`;
}
