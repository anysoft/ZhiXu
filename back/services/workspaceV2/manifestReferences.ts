import { WorkspaceStore } from './store';
import type { WorkspaceRow } from './types';
import { fail } from './errors';

/** Full plans stay in private SQLite; manifest plans contain only scheduling/source identities. */
export function manifestTriggerPlan(input: unknown) {
  let values: unknown = input;
  if (typeof input === 'string') {
    try {
      values = JSON.parse(input);
    } catch {
      fail('BACKUP_SOURCE_INCOMPLETE');
    }
  }
  if (!Array.isArray(values) || values.length > 20000)
    fail('BACKUP_SOURCE_INCOMPLETE');
  return values.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      fail('BACKUP_SOURCE_INCOMPLETE');
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of [
      'trigger_id',
      'trigger_version',
      'task_id',
      'task_definition_version',
    ]) {
      if (record[key] === undefined) continue;
      if (!Number.isSafeInteger(record[key]) || Number(record[key]) < 1)
        fail('BACKUP_SOURCE_INCOMPLETE');
      result[key] = record[key];
    }
    if (record.filter_result !== undefined) {
      if (
        typeof record.filter_result !== 'boolean' &&
        ![
          'MATCHED',
          'NO_MATCH',
          'SKIPPED',
          'DISABLED',
          'INITIAL_IGNORED',
          'PASS',
          'FAIL',
        ].includes(String(record.filter_result))
      )
        fail('BACKUP_SOURCE_INCOMPLETE');
      result.filter_result = record.filter_result;
    }
    if (record.source_expectation !== undefined) {
      const source = record.source_expectation;
      if (!source || typeof source !== 'object' || Array.isArray(source))
        fail('BACKUP_SOURCE_INCOMPLETE');
      const fields = source as Record<string, unknown>;
      const expectation: Record<string, unknown> = {};
      for (const key of [
        'workspace_id',
        'workspace_version',
        'source_generation',
        'content_revision',
        'expected_workspace_version',
        'expected_source_generation',
        'expected_content_revision',
      ]) {
        if (fields[key] === undefined) continue;
        if (!Number.isSafeInteger(fields[key]) || Number(fields[key]) < 1)
          fail('BACKUP_SOURCE_INCOMPLETE');
        expectation[key] = fields[key];
      }
      for (const key of [
        'inventory_hash',
        'content_inventory_hash',
        'expected_inventory_hash',
      ]) {
        const hash = fields[key];
        if (hash === undefined) continue;
        if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
          fail('BACKUP_SOURCE_INCOMPLETE');
        expectation[key] = hash;
      }
      for (const key of ['git_commit', 'expected_git_commit']) {
        const commit = fields[key];
        if (commit === undefined || commit === null) continue;
        if (
          typeof commit !== 'string' ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)
        )
          fail('BACKUP_SOURCE_INCOMPLETE');
        expectation[key] = commit;
      }
      result.source_expectation = expectation;
    }
    return result;
  });
}

/** Nonsecret identities only. Values, commands, credentials and value hashes stay in private SQLite. */
export async function collectManifestReferences(
  store: WorkspaceStore,
  row: WorkspaceRow,
) {
  const query = (sql: string) => store.all(sql, [row.id]);
  const environmentConfig: Record<string, unknown[]> = {
    global_revision: await store.all(
      'SELECT singleton_id,version FROM GlobalEnvironmentRevision',
    ),
    global_variables: await store.all(
      'SELECT id,name,status,operation,is_secret FROM Envs ORDER BY id',
    ),
    default_profile: [
      { workspace_id: row.id, profile_id: row.default_env_profile_id },
    ],
    profiles: await query(
      'SELECT id,workspace_id,name,status,version FROM EnvironmentProfiles WHERE workspace_id=? ORDER BY id',
    ),
    profile_variables:
      await query(`SELECT v.id,v.profile_id,v.name,v.status,v.operation,v.is_secret,v.position
      FROM WorkspaceProfileVariables v JOIN EnvironmentProfiles p ON p.id=v.profile_id
      WHERE p.workspace_id=? ORDER BY v.id`),
    task_profiles: await query(
      'SELECT id AS task_id,env_profile_id,version FROM Tasks WHERE workspace_id=? ORDER BY id',
    ),
    task_variables:
      await query(`SELECT v.id,v.task_id,v.name,v.status,v.operation,v.is_secret,v.position
      FROM TaskEnvVariables v JOIN Tasks t ON t.id=v.task_id WHERE t.workspace_id=? ORDER BY v.id`),
    runtime_defaults: await query(
      'SELECT id,kind,python_environment_id,node_environment_id,version FROM WorkspaceRuntimeDefaults WHERE workspace_id=? ORDER BY id',
    ),
    task_runtime_bindings:
      await query(`SELECT b.task_id,b.kind,b.python_environment_id,b.node_environment_id
      FROM TaskRuntimeBindings b JOIN Tasks t ON t.id=b.task_id WHERE t.workspace_id=? ORDER BY b.task_id`),
    config_bindings:
      await query(`SELECT id,asset_id,revision_id,operation,target_base,target_path,
      materialization_mode,conflict_policy,writable,enabled,version FROM WorkspaceConfigBindings
      WHERE workspace_id=? ORDER BY id`),
    task_config_bindings:
      await query(`SELECT b.id,b.task_id,b.asset_id,b.revision_id,b.operation,b.target_base,b.target_path,
      b.materialization_mode,b.conflict_policy,b.writable,b.enabled,b.version
      FROM TaskConfigBindings b JOIN Tasks t ON t.id=b.task_id WHERE t.workspace_id=? ORDER BY b.id`),
  };
  const syncDiscoveryEvents: Record<string, unknown[]> = {
    sync_policy: await query(
      'SELECT workspace_id,enabled,version FROM WorkspaceSyncPolicies WHERE workspace_id=?',
    ),
    sync_runs:
      await query(`SELECT id,status,phase,policy_version,source_generation,content_revision,initial,
      before_commit,target_commit,actual_commit,after_commit,git_update_status,discovery_status,event_status,update_outbox_id
      FROM WorkspaceSyncRuns WHERE workspace_id=? ORDER BY id`),
    discovery_policy: await query(
      'SELECT workspace_id,enabled,version FROM WorkspaceDiscoveryPolicies WHERE workspace_id=?',
    ),
    discovered_tasks:
      await query(`SELECT id AS task_id,discovery_key,discovery_state,version
      FROM Tasks WHERE discovered_workspace_id=? ORDER BY id`),
    suppressions: await query(
      'SELECT discovery_key,relative_entrypoint,version FROM WorkspaceDiscoverySuppressions WHERE workspace_id=? ORDER BY discovery_key',
    ),
    outbox:
      await query(`SELECT id,sync_run_id,status,source_generation,content_revision,initial,before_commit,
      after_commit,inventory_hash,trigger_plan FROM WorkspaceUpdateOutbox WHERE workspace_id=? ORDER BY id`),
    trigger_events:
      await query(`SELECT id,trigger_id,origin_trigger_id,task_id,workspace_update_id,event_key,
      trigger_type,status,task_run_id,error_code FROM TriggerEvents WHERE workspace_id=? ORDER BY id`),
    queued_runs:
      await query(`SELECT id,queue_deadline_at,submission_key,expected_workspace_version,
      expected_global_env_version,expected_task_definition_version,expected_source_generation,
      expected_content_revision,expected_inventory_hash,expected_git_commit
      FROM TaskRuns WHERE workspace_id=? AND status='QUEUED' ORDER BY id`),
  };
  syncDiscoveryEvents.outbox = syncDiscoveryEvents.outbox.map((value) => {
    const item = value as Record<string, unknown>;
    return { ...item, trigger_plan: manifestTriggerPlan(item.trigger_plan) };
  });
  return { environmentConfig, syncDiscoveryEvents };
}
