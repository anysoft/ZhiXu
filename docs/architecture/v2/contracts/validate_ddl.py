#!/usr/bin/env python3
"""S0-only relational contract verification. Every database is sqlite3 ':memory:'.

No application imports, runtime DB paths, filesystem source operations or migration.
The only optional output is this directory's ddl-validation.json design receipt.
"""
from __future__ import annotations
import hashlib
import json
import pathlib
import re
import sqlite3
import sys

HERE = pathlib.Path(__file__).resolve().parent
DDL = (HERE / 'fresh-v2.sql').read_text(encoding='utf-8')
HASH_A, HASH_B = 'a' * 64, 'b' * 64
COMMIT_A, COMMIT_B = 'a' * 40, 'b' * 40
NOW, DEADLINE = '2026-11-13T00:00:00.000Z', '2026-11-13T00:15:00.000Z'


def catalog(db):
    rows = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name").fetchall()
    token = re.compile(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|`(?:``|[^`])*`|\[[^\]]*\]|[^\s'\"`\[]+")
    objects = [{'type': t, 'name': n, 'table': tab, 'sql': ' '.join(token.findall(sql))} for t, n, tab, sql in rows]
    raw = json.dumps(objects, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return objects, hashlib.sha256(raw).hexdigest()


def fresh():
    db = sqlite3.connect(':memory:', isolation_level=None)
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA recursive_triggers=ON')
    db.executescript(DDL)
    _, signature = catalog(db)
    assert db.execute('SELECT schema_signature FROM PlatformMetadata').fetchone()[0] == signature
    return db


def repository(db, ident=1):
    db.execute('INSERT INTO Repositories(id,name,provider,remote_url,normalized_url) VALUES(?,?,?,?,?)', (ident, f'repo-{ident}', 'github', f'https://example.test/repo{ident}.git', f'https://example.test/repo{ident}.git'))


def workspace(db, ident=1, kind='LOCAL', ref='branch', ready=True):
    db.execute('INSERT INTO Workspaces(id,name,type) VALUES(?,?,?)', (ident, f'ws-{ident}', kind))
    if kind == 'GIT':
        db.execute('INSERT INTO GitWorkspaces(workspace_id,repository_id,ref_type,ref_name,private_branch,resolved_commit,last_verified_commit,applied_commit) VALUES(?,?,?,?,?,?,?,?)', (ident, 1, ref, 'main' if ref == 'branch' else 'v1', f'ws-{ident}' if ref == 'branch' else None, COMMIT_A, COMMIT_A, COMMIT_A))
    if ready:
        db.execute("UPDATE Workspaces SET lifecycle_state='READY',storage_state='PRESENT',content_inventory_hash=?,root_device=1,root_inode=?,root_owner_token=? WHERE id=?", (HASH_A, 1000 + ident, f'owner-{ident}', ident))


def task(db, ident=1, ws=1, origin='MANUAL', profile=None):
    db.execute('INSERT INTO Tasks(id,workspace_id,name,enabled,origin,discovered_workspace_id,discovery_key,env_profile_id) VALUES(?,?,?,?,?,?,?,?)', (ident, ws, f'task-{ident}', 1, origin, ws if origin == 'DISCOVERED' else None, HASH_A if origin == 'DISCOVERED' else None, profile))
    db.execute('INSERT INTO TaskSources(task_id,workspace_id,relative_entrypoint,language) VALUES(?,?,?,?)', (ident, ws, 'main.py', 'PYTHON'))
    db.execute('INSERT INTO TaskExecutionSettings(task_id) VALUES(?)', (ident,))


def run(db, ident=1, task_id=1, ws=1, status='QUEUED', policy='ALLOW'):
    w = db.execute('SELECT type,version,source_generation,content_revision,content_inventory_hash FROM Workspaces WHERE id=?', (ws,)).fetchone()
    tv = db.execute('SELECT version FROM Tasks WHERE id=?', (task_id,)).fetchone()[0]
    gv = db.execute('SELECT version FROM GlobalEnvironmentRevision WHERE singleton_id=1').fetchone()[0]
    gc = None if w[0] == 'LOCAL' else db.execute('SELECT applied_commit FROM GitWorkspaces WHERE workspace_id=?', (ws,)).fetchone()[0]
    admission = json.dumps({'workspace_id': ws, 'workspace_type': w[0], 'workspace_version': w[1], 'source_generation': w[2], 'content_revision': w[3], 'task_definition_version': tv, 'inventory_hash': w[4], 'git_commit': gc, 'effective_resource_versions': {}, 'system_allowlist_version': 'S0-allowlist-1'})
    db.execute('''INSERT INTO TaskRuns(id,task_id,workspace_id,expected_workspace_version,expected_global_env_version,expected_task_definition_version,expected_source_generation,expected_content_revision,expected_git_commit,expected_inventory_hash,admission_snapshot,trigger_type,status,submitted_at,finished_at,log_identity,concurrency_policy,queue_deadline_at,next_eligible_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'MANUAL',?,?,?,?, ?,?,?)''', (ident, task_id, ws, w[1], gv, tv, w[2], w[3], gc, w[4], admission, status, NOW, NOW if status == 'SKIPPED' else None, f'run-{ident}', policy, DEADLINE, NOW))


def finish(db, ident=1):
    row = db.execute('SELECT workspace_id,expected_source_generation,expected_content_revision,expected_task_definition_version,expected_inventory_hash FROM TaskRuns WHERE id=?', (ident,)).fetchone()
    snapshot_data = dict(zip(['workspace_id','source_generation','content_revision','task_definition_version','inventory_hash'], row))
    kind, commit = db.execute('SELECT w.type,r.expected_git_commit FROM Workspaces w JOIN TaskRuns r ON r.workspace_id=w.id WHERE r.id=?',(ident,)).fetchone()
    snapshot_data.update(workspace_type=kind,entrypoint_checksum=HASH_A,git=None if kind=='LOCAL' else {'commit':commit})
    snapshot = json.dumps(snapshot_data)
    db.execute("UPDATE TaskRuns SET status='RESOLVING',owner_token='claim',active_workspace_id=workspace_id WHERE id=?", (ident,))
    db.execute("UPDATE TaskRuns SET status='RUNNING',source_snapshot=?,started_at=? WHERE id=?", (snapshot, NOW, ident))
    db.execute("UPDATE TaskRuns SET status='SUCCESS',active_workspace_id=NULL,finished_at=? WHERE id=?", (NOW, ident))


def sync(db, ident=1, ws=2):
    initial = int(db.execute('SELECT baseline_established FROM GitWorkspaces WHERE workspace_id=?',(ws,)).fetchone()[0] == 0) if db.execute('SELECT 1 FROM GitWorkspaces WHERE workspace_id=?',(ws,)).fetchone() else 0
    db.execute('INSERT INTO WorkspaceSyncRuns(id,workspace_id,policy_version,source_generation,request_key,request_hash,trigger_source,initial,source_snapshot,submitted_at,log_identity) VALUES(?,?,1,1,?,?,\'MANUAL\',?,?,?,?)', (ident, ws, f'sync-{ident}', HASH_A, initial, json.dumps({'workspace_id': ws, 'repository_id': 1, 'ref_type': 'branch', 'ref_name': 'main'}), NOW, f'sync-log-{ident}'))
    db.execute("UPDATE WorkspaceSyncRuns SET status='RUNNING',owner_token='sync-claim' WHERE id=?", (ident,))


def successful_update(db, ident=1, ws=2, after=COMMIT_B, with_outbox=True):
    before = db.execute('SELECT applied_commit FROM GitWorkspaces WHERE workspace_id=?', (ws,)).fetchone()[0]
    db.execute('UPDATE Workspaces SET content_revision=content_revision+1,content_inventory_hash=? WHERE id=?', (HASH_B, ws))
    rev = db.execute('SELECT content_revision FROM Workspaces WHERE id=?', (ws,)).fetchone()[0]
    db.execute('UPDATE GitWorkspaces SET last_verified_commit=?,applied_commit=? WHERE workspace_id=?', (after, after, ws))
    db.execute("UPDATE WorkspaceSyncRuns SET status='SUCCESS',before_commit=?,target_commit=?,actual_commit=?,after_commit=?,git_update_status='APPLIED',discovery_status='SUCCESS',event_status='PENDING',content_revision=?,update_outbox_id=id,finished_at=? WHERE id=?", (before, after, after, after, rev, NOW, ident))
    initial=db.execute('SELECT initial FROM WorkspaceSyncRuns WHERE id=?',(ident,)).fetchone()[0]
    if with_outbox:
        db.execute('INSERT INTO WorkspaceUpdateOutbox(id,workspace_id,sync_run_id,source_generation,content_revision,initial,before_commit,after_commit,inventory_hash) VALUES(?,?,?,1,?,?,?,?,?)', (ident, ws, ident, rev, initial, before, after, HASH_B))
        if initial:
            db.execute('UPDATE GitWorkspaces SET baseline_established=1,baseline_sync_run_id=? WHERE workspace_id=?',(ident,ws))


def preservation_hold(db, ws=1):
    w = db.execute('SELECT source_generation,content_revision,content_inventory_hash FROM Workspaces WHERE id=?', (ws,)).fetchone()
    db.execute('INSERT INTO WorkspacePreservationHolds(workspace_id,snapshot_key,source_generation,content_revision,inventory_hash,manifest_hash,receipt) VALUES(?,?,?,?,?,?,?)', (ws, 'fixture-backup-id', *w, HASH_A, '{"validation":"isolated-fixture-only"}'))


def schema_classification(db):
    tables = db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
    if not tables:
        return 'EMPTY_DATA_ROOT'
    if ('PlatformMetadata',) not in tables:
        return 'UNSUPPORTED_EXISTING_SCHEMA'
    try:
        rows = db.execute('SELECT schema_identity,schema_version,schema_signature FROM PlatformMetadata').fetchall()
    except sqlite3.DatabaseError:
        return 'UNSUPPORTED_EXISTING_SCHEMA'
    if len(rows) != 1 or rows[0][0] != 'zhixu.workspace.v2.s0.1' or rows[0][1] != 1:
        return 'UNSUPPORTED_EXISTING_SCHEMA'
    return 'SUPPORTED_FRESH_V2' if rows[0][2] == catalog(db)[1] and not db.execute('PRAGMA foreign_key_check').fetchall() else 'CORRUPTED_V2_SCHEMA'


RESULTS = []

def check(name, action, reject=False, setup=None):
    db = fresh()
    try:
        db.execute('BEGIN IMMEDIATE')
        repository(db)
        workspace(db, 1)
        workspace(db, 2, 'GIT')
        workspace(db, 3, 'GIT')
        task(db, 1)
        if setup:
            setup(db)
        db.execute('COMMIT')
        db.execute('BEGIN IMMEDIATE')
        failure = None
        try:
            action(db)
            db.execute('COMMIT')
        except sqlite3.IntegrityError as exc:
            failure = str(exc)
            if db.in_transaction:
                db.execute('ROLLBACK')
        if reject and failure is None:
            raise AssertionError('Expected relational rejection, operation committed')
        if not reject and failure is not None:
            raise AssertionError(f'Unexpected relational rejection: {failure}')
        assert not db.execute('PRAGMA foreign_key_check').fetchall()
        RESULTS.append({'name': name, 'expectation': 'REJECT' if reject else 'PASS', 'status': 'DYNAMICALLY_VERIFIED', 'observed': failure or 'committed'})
    finally:
        db.close()


def main():
    check('LOCAL_without_Repository', lambda c: workspace(c, 4))
    check('GIT_without_repository_rejected', lambda c: (c.execute("INSERT INTO Workspaces(id,name,type) VALUES(4,'bad','GIT')"), c.execute('INSERT INTO GitWorkspaces(workspace_id,repository_id,ref_type,ref_name,private_branch,resolved_commit) VALUES(4,NULL,\'branch\',\'main\',\'ws-4\',?)', (COMMIT_A,))), True)
    check('LOCAL_with_Git_extension_rejected', lambda c: c.execute("INSERT INTO GitWorkspaces(workspace_id,repository_id,ref_type,ref_name,private_branch,resolved_commit) VALUES(1,1,'branch','main','ws-1',?)", (COMMIT_A,)), True)
    check('GIT_CREATING_missing_extension_not_READY', lambda c: (c.execute("INSERT INTO Workspaces(id,name,type) VALUES(4,'bad','GIT')"),c.execute("UPDATE Workspaces SET lifecycle_state='READY',storage_state='PRESENT',content_inventory_hash=?,root_device=1,root_inode=44,root_owner_token='x' WHERE id=4",(HASH_A,))), True)
    check('GIT_with_valid_extension_READY', lambda c: workspace(c,4,'GIT'))
    check('same_Repository_ref_different_Workspaces_allowed', lambda c: (workspace(c,4,'GIT'), workspace(c,5,'GIT')))
    check('duplicate_private_branch_rejected', lambda c: c.execute("UPDATE GitWorkspaces SET private_branch='ws-2' WHERE workspace_id=3"), True)
    check('invalid_Workspace_type_rejected', lambda c: c.execute("INSERT INTO Workspaces(name,type) VALUES('bad','HOST')"), True)
    check('initial_READY_bypass_rejected', lambda c: c.execute("INSERT INTO Workspaces(name,type,lifecycle_state) VALUES('bad','LOCAL','READY')"), True)
    check('invalid_lifecycle_rejected', lambda c: c.execute("UPDATE Workspaces SET lifecycle_state='MAYBE' WHERE id=1"), True)
    check('READY_to_CREATING_rejected', lambda c: c.execute("UPDATE Workspaces SET lifecycle_state='CREATING' WHERE id=1"), True)
    check('Workspace_type_change_rejected', lambda c: c.execute("UPDATE Workspaces SET type='LOCAL' WHERE id=2"), True)
    check('Git_source_ref_change_rejected', lambda c: c.execute("UPDATE GitWorkspaces SET ref_name='other' WHERE workspace_id=2"), True)
    check('Tag_scheduled_policy_rejected', lambda c: (workspace(c,4,'GIT','tag'),c.execute("INSERT INTO WorkspaceSyncPolicies(workspace_id,update_mode,schedule_kind,cron_expression) VALUES(4,'SCHEDULED','CRON','* * * * *')")), True)
    check('Tag_applied_commit_moving_rejected', lambda c: (workspace(c,4,'GIT','tag'),c.execute('UPDATE GitWorkspaces SET applied_commit=? WHERE workspace_id=4',(COMMIT_B,))), True)
    check('Branch_interval_policy_allowed', lambda c: c.execute("INSERT INTO WorkspaceSyncPolicies(workspace_id,enabled,update_mode,schedule_kind,interval_ms,anchor_at) VALUES(2,1,'SCHEDULED','INTERVAL',60000,?)",(NOW,)))
    check('LOCAL_sync_policy_rejected', lambda c: c.execute('INSERT INTO WorkspaceSyncPolicies(workspace_id) VALUES(1)'), True)
    check('Task_without_Workspace_rejected', lambda c: c.execute("INSERT INTO Tasks(name,workspace_id) VALUES('bad',NULL)"), True)
    check('Task_without_Source_rejected_at_commit', lambda c: c.execute("INSERT INTO Tasks(id,name,workspace_id) VALUES(4,'bad',1)"), True)
    check('Task_Source_same_transaction_allowed', lambda c: task(c,4))
    check('Task_Source_owner_mismatch_rejected_at_commit', lambda c: (c.execute("INSERT INTO Tasks(id,name,workspace_id) VALUES(4,'bad',1)"),c.execute("INSERT INTO TaskSources(task_id,workspace_id,relative_entrypoint,language) VALUES(4,2,'x.py','PYTHON')")), True)
    check('cross_Workspace_Task_Profile_rejected', lambda c: (c.execute("INSERT INTO EnvironmentProfiles(id,workspace_id,name) VALUES(1,2,'p')"), task(c,4,1,profile=1)), True)
    check('cross_Workspace_default_Profile_rejected_at_commit', lambda c: (c.execute("INSERT INTO EnvironmentProfiles(id,workspace_id,name) VALUES(1,2,'p')"),c.execute('UPDATE Workspaces SET default_env_profile_id=1 WHERE id=1')), True)
    check('same_Workspace_Profile_allowed', lambda c: (c.execute("INSERT INTO EnvironmentProfiles(id,workspace_id,name) VALUES(1,1,'p')"),c.execute('UPDATE Workspaces SET default_env_profile_id=1 WHERE id=1'),task(c,4,1,profile=1)))
    check('manual_Task_invalid_discovery_owner_rejected', lambda c: c.execute("UPDATE Tasks SET discovered_workspace_id=1 WHERE id=1"), True)
    check('discovered_Task_LOCAL_rejected', lambda c: task(c,4,1,'DISCOVERED'), True)
    check('discovered_Task_GIT_allowed', lambda c: task(c,4,2,'DISCOVERED'))
    check('ignored_discovery_entry_not_recreated', lambda c: (c.execute('INSERT INTO WorkspaceDiscoverySuppressions(workspace_id,discovery_key,relative_entrypoint) VALUES(2,?,\'main.py\')',(HASH_A,)),task(c,4,2,'DISCOVERED')), True)
    check('retired_discovered_Task_cannot_remain_enabled', lambda c: (task(c,4,2,'DISCOVERED'),c.execute("UPDATE Tasks SET discovery_state='RETIRED',enabled=1 WHERE id=4")), True)
    check('path_traversal_relational_guard', lambda c: c.execute("UPDATE TaskSources SET relative_entrypoint='../db/x' WHERE task_id=1"), True)
    check('Workspace_DELETE_with_Task_rejected_state_unchanged', lambda c: c.execute("UPDATE Workspaces SET lifecycle_state='DELETE_REQUESTED' WHERE id=1"), True)
    check('active_TaskRun_blocks_Task_delete', lambda c: (run(c),c.execute('DELETE FROM Tasks WHERE id=1')), True)
    check('two_QUEUED_TaskRuns_same_Workspace_allowed', lambda c: (run(c,1),run(c,2)))
    def two_active(c):
        run(c,1);run(c,2)
        c.execute("UPDATE TaskRuns SET status='RESOLVING',owner_token='one',active_workspace_id=1 WHERE id=1")
        c.execute("UPDATE TaskRuns SET status='RESOLVING',owner_token='two',active_workspace_id=1 WHERE id=2")
    check('two_active_TaskRuns_same_Workspace_rejected', two_active, True)
    def different_active(c):
        task(c,2,2);run(c,1);run(c,2,2,2)
        c.execute("UPDATE TaskRuns SET status='RESOLVING',owner_token='one',active_workspace_id=workspace_id WHERE id IN (1,2)")
    check('different_Workspace_active_execution_allowed', different_active)
    check('queued_cancel_preserves_deadline', lambda c:(run(c),c.execute("UPDATE TaskRuns SET status='CANCELLED',finished_at=? WHERE id=1",(NOW,))))
    check('TaskRun_expected_source_immutable',lambda c:(run(c),c.execute('UPDATE TaskRuns SET expected_content_revision=2 WHERE id=1')),True)
    check('TaskRun_source_snapshot_write_once',lambda c:(run(c),finish(c),c.execute("UPDATE TaskRuns SET source_snapshot='{}' WHERE id=1")),True)
    check('TaskRun_terminal_cannot_requeue',lambda c:(run(c),finish(c),c.execute("UPDATE TaskRuns SET status='QUEUED' WHERE id=1")),True)
    check('TaskRun_invalid_owner_rejected',lambda c:(task(c,2,2),run(c,2,2,1)),True)
    def reclaim_history(c):
        run(c);finish(c)
        before=c.execute('SELECT source_snapshot FROM TaskRuns WHERE id=1').fetchone()[0]
        c.execute('DELETE FROM Tasks WHERE id=1')
        c.execute("UPDATE Workspaces SET lifecycle_state='ARCHIVED',file_count=1,total_bytes=9 WHERE id=1")
        preservation_hold(c)
        c.execute("UPDATE Workspaces SET lifecycle_state='DELETE_REQUESTED' WHERE id=1")
        c.execute("UPDATE Workspaces SET storage_state='RECLAIMING' WHERE id=1")
        c.execute("UPDATE Workspaces SET lifecycle_state='TOMBSTONED',storage_state='RECLAIMED',root_device=NULL,root_inode=NULL,reclaimed_at=? WHERE id=1",(NOW,))
        assert c.execute('SELECT task_id,source_snapshot FROM TaskRuns WHERE id=1').fetchone()==(None,before)
    check('delete_Task_archive_reclaim_preserves_Run_history',reclaim_history)
    check('nonempty_LOCAL_reclaim_without_preservation_hold_rejected',lambda c:(c.execute('DELETE FROM Tasks WHERE id=1'),c.execute("UPDATE Workspaces SET file_count=1,lifecycle_state='DELETE_REQUESTED' WHERE id=1"),c.execute("UPDATE Workspaces SET storage_state='RECLAIMING' WHERE id=1")),True)
    check('historical_Run_blocks_identity_purge_but_not_reclaim',lambda c:(reclaim_history(c),c.execute('DELETE FROM WorkspacePreservationHolds'),c.execute('DELETE FROM Workspaces WHERE id=1')),True)
    def final_purge(c):
        reclaim_history(c);c.execute('DELETE FROM TaskRuns');c.execute('DELETE FROM WorkspacePreservationHolds');c.execute('DELETE FROM Workspaces WHERE id=1')
    check('retention_expired_no_refs_allows_final_metadata_purge',final_purge)
    check('Sync_without_GIT_rejected',lambda c:sync(c,1,1),True)
    check('single_active_SyncRun_per_Workspace',lambda c:(sync(c),sync(c,2)),True)
    check('SUCCESS_without_outbox_cannot_commit',lambda c:(sync(c),successful_update(c,with_outbox=False)),True)
    check('SUCCESS_and_outbox_same_transaction_commit',lambda c:(sync(c),successful_update(c)))
    check('outbox_without_SUCCESS_rejected',lambda c:(sync(c),c.execute('INSERT INTO WorkspaceUpdateOutbox(id,workspace_id,sync_run_id,source_generation,content_revision,after_commit,inventory_hash) VALUES(1,2,1,1,1,?,?)',(COMMIT_A,HASH_A))),True)
    def discovery_failed(c):
        sync(c)
        c.execute("UPDATE WorkspaceSyncRuns SET status='RECOVERY_REQUIRED',phase='APPLIED_PENDING_RECONCILIATION',git_update_status='APPLIED',discovery_status='FAILED',target_commit=?,actual_commit=? WHERE id=1",(COMMIT_B,COMMIT_B))
        assert c.execute('SELECT count(*) FROM WorkspaceUpdateOutbox').fetchone()[0]==0
    check('APPLIED_Discovery_failed_recovery_no_outbox',discovery_failed)
    check('APPLIED_failure_cannot_be_generic_FAILED',lambda c:(sync(c),c.execute("UPDATE WorkspaceSyncRuns SET status='FAILED',git_update_status='APPLIED',discovery_status='FAILED' WHERE id=1")),True)
    check('SUCCESS_commit_facts_immutable',lambda c:(sync(c),successful_update(c),c.execute('UPDATE WorkspaceSyncRuns SET actual_commit=? WHERE id=1',(COMMIT_A,))),True)
    check('outbox_trigger_plan_immutable',lambda c:(sync(c),successful_update(c),c.execute("UPDATE WorkspaceUpdateOutbox SET trigger_plan='[1]' WHERE id=1")),True)
    check('same_successful_commit_no_duplicate_outbox',lambda c:(sync(c),successful_update(c),sync(c,2),successful_update(c,2)),True)
    check('outbox_dispatch_retry_same_identity',lambda c:(sync(c),successful_update(c),c.execute("UPDATE WorkspaceUpdateOutbox SET status='PROCESSING',owner_token='o',claimed_at='2026-11-13T00:00:00.000Z',claim_expires_at='2026-11-13T00:01:00.000Z' WHERE id=1"),c.execute("UPDATE WorkspaceUpdateOutbox SET status='RETRY',owner_token=NULL WHERE id=1"),c.execute("UPDATE WorkspaceUpdateOutbox SET status='PROCESSING',owner_token='o2',claimed_at='2026-11-13T00:00:00.000Z',claim_expires_at='2026-11-13T00:01:00.000Z' WHERE id=1"),c.execute("UPDATE WorkspaceUpdateOutbox SET status='DISPATCHED' WHERE id=1")))
    def revision(c):
        c.execute("INSERT INTO EnvironmentProfiles(id,workspace_id,name) VALUES(1,1,'p')")
        pv=c.execute('SELECT version FROM EnvironmentProfiles WHERE id=1').fetchone()[0]
        wv=c.execute('SELECT version FROM Workspaces WHERE id=1').fetchone()[0]
        c.execute("INSERT INTO WorkspaceProfileVariables(profile_id,name,value) VALUES(1,'X','x')")
        assert c.execute('SELECT version FROM EnvironmentProfiles WHERE id=1').fetchone()[0]>pv
        assert c.execute('SELECT version FROM Workspaces WHERE id=1').fetchone()[0]>wv
    check('Profile_variable_bumps_Profile_and_Workspace_versions',revision)
    def global_revision(c):
        v=c.execute('SELECT version FROM GlobalEnvironmentRevision').fetchone()[0]
        c.execute("INSERT INTO Envs(name,value,operation,createdAt,updatedAt) VALUES('X','x','SET',?,?)",(NOW,NOW))
        assert c.execute('SELECT version FROM GlobalEnvironmentRevision').fetchone()[0]==v+1
    check('Global_ENV_membership_monotonic_revision',global_revision)
    check('UNSET_profile_value_rejected',lambda c:(c.execute("INSERT INTO EnvironmentProfiles(id,workspace_id,name) VALUES(1,1,'p')"),c.execute("INSERT INTO WorkspaceProfileVariables(profile_id,name,value,operation) VALUES(1,'X','secret','UNSET')")),True)
    check('Workspace_MASK_binding_rejected',lambda c:c.execute("INSERT INTO WorkspaceConfigBindings(workspace_id,asset_id,operation,target_base,target_path) VALUES(1,1,'MASK','WORKSPACE_ROOT','x')"),True)
    def rollback_case(c):
        original=c.execute('SELECT count(*) FROM Workspaces').fetchone()[0]
        c.execute('SAVEPOINT atomic_create')
        workspace(c,4)
        try:c.execute("INSERT INTO Tasks(name,workspace_id) VALUES('bad',NULL)")
        except sqlite3.IntegrityError:c.execute('ROLLBACK TO atomic_create');c.execute('RELEASE atomic_create')
        assert c.execute('SELECT count(*) FROM Workspaces').fetchone()[0]==original
    check('transaction_rollback_preserves_preexisting_rows',rollback_case)
    # Cross-review hardening: queue identity, phase, operation gate and first-sync baseline.
    def operation(c, ident='op-a', ws=1, kind='ARCHIVE', key='key-a'):
        version=c.execute('SELECT version FROM Workspaces WHERE id=?',(ws,)).fetchone()[0]
        c.execute("INSERT INTO WorkspaceOperations(id,workspace_id,operation_type,status,phase,request_key,request_hash,expected_workspace_version,journal_key,submitted_at) VALUES(?,?,?,'PENDING','ADMITTED',?,?,?, ?,?)",(ident,ws,kind,key,HASH_A,version,'journal-'+ident,NOW))
    check('queued_claim_after_lifecycle_admission_closed_rejected',lambda c:(run(c),operation(c),c.execute("UPDATE TaskRuns SET status='RESOLVING',owner_token='claim',active_workspace_id=1 WHERE id=1")),True)
    check('live_TaskRun_cannot_rebind_Task_identity',lambda c:(task(c,4),run(c),c.execute('UPDATE TaskRuns SET task_id=4 WHERE id=1')),True)
    check('FORBID_same_Task_not_queued_twice',lambda c:(run(c,1,policy='FORBID'),run(c,2,policy='FORBID')),True)
    check('SKIPPED_FORBID_audit_does_not_hold_lease',lambda c:(run(c,1,policy='FORBID'),run(c,2,status='SKIPPED',policy='FORBID')))
    check('queued_unresolved_source_cannot_be_written_early',lambda c:(run(c),c.execute("UPDATE TaskRuns SET source_snapshot='{}' WHERE id=1")),True)
    def cloned_insert_snapshot(c):
        run(c)
        fields=[r[1] for r in c.execute('PRAGMA table_info(TaskRuns)').fetchall()]
        values=dict(zip(fields,c.execute('SELECT * FROM TaskRuns WHERE id=1').fetchone()))
        values.update(id=2,log_identity='clone-run',source_snapshot='{}')
        c.execute('INSERT INTO TaskRuns('+','.join(fields)+') VALUES('+','.join('?' for _ in fields)+')',list(values.values()))
    check('initial_insert_cannot_forge_resolved_source_snapshot',cloned_insert_snapshot,True)
    def wrong_git_snapshot(c):
        task(c,2,2);run(c,1,2,2)
        r=c.execute('SELECT expected_task_definition_version,expected_content_revision,expected_source_generation,expected_inventory_hash FROM TaskRuns WHERE id=1').fetchone()
        c.execute("UPDATE TaskRuns SET status='RESOLVING',owner_token='x',active_workspace_id=2 WHERE id=1")
        obj={'workspace_id':2,'workspace_type':'GIT','task_definition_version':r[0],'content_revision':r[1],'source_generation':r[2],'inventory_hash':r[3],'entrypoint_checksum':HASH_A,'git':{'commit':COMMIT_B}}
        c.execute('UPDATE TaskRuns SET source_snapshot=? WHERE id=1',(json.dumps(obj),))
    check('resolved_source_snapshot_wrong_Git_commit_rejected',wrong_git_snapshot,True)
    check('resolved_Git_source_snapshot_allowed',lambda c:(task(c,2,2),run(c,1,2,2),finish(c)))
    def duplicate_create(c):
        workspace(c,4,ready=False);workspace(c,5,ready=False)
        operation(c,'create-a',4,'CREATE','create-same-key')
        operation(c,'create-b',5,'CREATE','create-same-key')
    check('CREATE_idempotency_same_key_different_Workspace_rejected',duplicate_create,True)
    def initial_same_commit(c, mark=True):
        sync(c)
        c.execute("UPDATE WorkspaceSyncRuns SET status='SUCCESS',before_commit=?,target_commit=?,actual_commit=?,after_commit=?,git_update_status='UNCHANGED',discovery_status='SUCCESS',event_status='PENDING',content_revision=1,update_outbox_id=id,finished_at=? WHERE id=1",(COMMIT_A,COMMIT_A,COMMIT_A,COMMIT_A,NOW))
        c.execute('INSERT INTO WorkspaceUpdateOutbox(id,workspace_id,sync_run_id,source_generation,content_revision,initial,before_commit,after_commit,inventory_hash) VALUES(1,2,1,1,1,1,?,?,?)',(COMMIT_A,COMMIT_A,HASH_A))
        if mark:c.execute('UPDATE GitWorkspaces SET baseline_established=1,baseline_sync_run_id=1 WHERE workspace_id=2')
        assert c.execute('SELECT content_revision FROM Workspaces WHERE id=2').fetchone()[0]==1
    def second_no_change(c):
        sync(c,2)
        c.execute("UPDATE WorkspaceSyncRuns SET status='NO_CHANGE',before_commit=?,target_commit=?,actual_commit=?,after_commit=?,git_update_status='UNCHANGED',discovery_status='SUCCESS',content_revision=1,finished_at=? WHERE id=2",(COMMIT_A,COMMIT_A,COMMIT_A,COMMIT_A,NOW))
    check('first_same_commit_initial_SUCCESS_outbox_no_revision_increment',initial_same_commit)
    check('initial_SUCCESS_outbox_without_marker_cannot_commit',lambda c:initial_same_commit(c,False),True)
    check('second_same_commit_is_NO_CHANGE_no_duplicate_outbox',lambda c:(initial_same_commit(c),second_no_change(c)))
    def false_initial(c):
        initial_same_commit(c)
        c.execute("INSERT INTO WorkspaceSyncRuns(id,workspace_id,policy_version,source_generation,request_key,request_hash,trigger_source,initial,source_snapshot,submitted_at,log_identity) VALUES(2,2,1,1,'false-initial',?,'MANUAL',1,'{}',?,'false-initial-log')",(HASH_A,NOW))
    check('false_initial_after_baseline_rejected',false_initial,True)
    check('baseline_marker_cannot_reset',lambda c:(initial_same_commit(c),c.execute('UPDATE GitWorkspaces SET baseline_established=0,baseline_sync_run_id=NULL WHERE workspace_id=2')),True)
    def baseline_retention(c):
        initial_same_commit(c)
        c.execute('DELETE FROM WorkspaceUpdateOutbox WHERE id=1')
        c.execute('DELETE FROM WorkspaceSyncRuns WHERE id=1')
        assert c.execute('SELECT baseline_established,baseline_sync_run_id FROM GitWorkspaces WHERE workspace_id=2').fetchone()==(1,None)
        second_no_change(c)
        assert c.execute('SELECT count(*) FROM WorkspaceUpdateOutbox').fetchone()[0]==0
    check('baseline_history_retention_does_not_repeat_initial_event',baseline_retention)
    def cron_event(c, ident=1):
        c.execute("INSERT INTO TaskTriggers(id,task_id,type,createdAt,updatedAt) VALUES(1,1,'CRON',?,?)",(NOW,NOW))
        c.execute("INSERT INTO TriggerEvents(id,trigger_id,origin_trigger_id,task_id,workspace_id,event_key,trigger_type,received_at) VALUES(?,1,1,1,1,'slot-1','CRON',?)",(ident,NOW))
    check('TriggerEvent_RECEIVED_to_SUBMITTED_atomic_route_allowed',lambda c:(cron_event(c),c.execute("UPDATE TriggerEvents SET status='SUBMITTED' WHERE id=1")))
    check('TriggerEvent_terminal_FAILED_cannot_reprocess',lambda c:(cron_event(c),c.execute("UPDATE TriggerEvents SET status='PROCESSING',owner_token='p',claimed_at=?,claim_expires_at=? WHERE id=1",(NOW,DEADLINE)),c.execute("UPDATE TriggerEvents SET status='FAILED' WHERE id=1"),c.execute("UPDATE TriggerEvents SET status='PROCESSING' WHERE id=1")),True)
    def git_event_without_success(c):
        task(c,2,2)
        c.execute("INSERT INTO TaskTriggers(id,task_id,type,createdAt,updatedAt) VALUES(1,2,'GIT_UPDATE',?,?)",(NOW,NOW))
        c.execute("INSERT INTO TriggerEvents(trigger_id,origin_trigger_id,task_id,workspace_id,workspace_update_id,event_key,trigger_type,received_at) VALUES(1,1,2,2,999,'update','GIT_UPDATE',?)",(NOW,))
    check('GitUpdate_event_without_successful_update_rejected',git_event_without_success,True)

    check('branch_private_branch_NULL_rejected',lambda c:(c.execute("INSERT INTO Workspaces(id,name,type) VALUES(4,'git-no-branch','GIT')"),c.execute("INSERT INTO GitWorkspaces(workspace_id,repository_id,ref_type,ref_name,resolved_commit) VALUES(4,1,'branch','main',?)",(COMMIT_A,))),True)
    check('SUCCESS_missing_factual_target_cannot_bypass_NULL_CHECK',lambda c:(sync(c),c.execute("UPDATE WorkspaceSyncRuns SET status='SUCCESS',actual_commit=?,git_update_status='APPLIED',discovery_status='SUCCESS',content_revision=1,event_status='PENDING',update_outbox_id=id WHERE id=1",(COMMIT_A,))),True)
    def retired_admission(c):
        task(c,2,2,'DISCOVERED')
        c.execute("UPDATE Tasks SET enabled=0,discovery_state='RETIRED' WHERE id=2")
        run(c,1,2,2)
    check('retired_discovered_Task_cannot_run_even_source_returns',retired_admission,True)
    def retired_claim(c):
        task(c,2,2,'DISCOVERED');run(c,1,2,2)
        c.execute("UPDATE Tasks SET enabled=0,discovery_state='RETIRED' WHERE id=2")
        c.execute("UPDATE TaskRuns SET status='RESOLVING',owner_token='claim',active_workspace_id=2 WHERE id=1")
    check('retired_discovered_Task_queued_claim_rejected',retired_claim,True)
    # Four bootstrap classifications are evaluated only in isolated memory databases.
    for name in ['EMPTY_DATA_ROOT','SUPPORTED_FRESH_V2','UNSUPPORTED_EXISTING_SCHEMA','CORRUPTED_V2_SCHEMA']:
        db=sqlite3.connect(':memory:',isolation_level=None) if name in ['EMPTY_DATA_ROOT','UNSUPPORTED_EXISTING_SCHEMA'] else fresh()
        if name=='UNSUPPORTED_EXISTING_SCHEMA':db.execute('CREATE TABLE ExistingUserAsset(value TEXT)')
        if name=='CORRUPTED_V2_SCHEMA':db.execute('ALTER TABLE Workspaces ADD COLUMN unexpected_column TEXT')
        observed=schema_classification(db);assert observed==name,(name,observed)
        RESULTS.append({'name':'bootstrap_'+name,'expectation':name,'observed':observed,'status':'DYNAMICALLY_VERIFIED'});db.close()
    db=fresh();objs,sig=catalog(db)
    tables=[x['name'] for x in objs if x['type']=='table']
    fks=[];all_indexes=[]
    for table in tables:
        groups={}
        for row in db.execute(f'PRAGMA foreign_key_list("{table}")').fetchall():groups.setdefault(row[0],[]).append(row)
        for rows in groups.values():fks.append({'table':table,'columns':[r[3] for r in rows],'parent':rows[0][2],'parent_columns':[r[4] for r in rows],'on_delete':rows[0][6]})
        for row in db.execute(f'PRAGMA index_list("{table}")').fetchall():all_indexes.append({'table':table,'name':row[1],'unique':bool(row[2]),'origin':row[3],'partial':bool(row[4]),'columns':[r[2] for r in db.execute(f'PRAGMA index_info("{row[1]}")').fetchall()]})
    receipt={'scope':'NON_RUNTIME_S0_CANDIDATE_ONLY','status':'DYNAMICALLY_VERIFIED','database':':memory:','sqlite_version':sqlite3.sqlite_version,'schema_identity':'zhixu.workspace.v2.s0.1','signature_algorithm':'sha256(sorted sqlite_schema objects type/name/table/tokenized SQL; JSON UTF-8 no whitespace; excludes sqlite_* and sql NULL)','schema_signature':sig,'ddl_sha256':hashlib.sha256(DDL.encode()).hexdigest(),'tables':tables,'table_count':len(tables),'foreign_key_count':len(fks),'foreign_keys':fks,'index_count_including_autoindexes':len(all_indexes),'indexes':all_indexes,'explicit_index_count':sum(x['type']=='index' for x in objs),'sql_guard_count':sum(x['type']=='trigger' for x in objs),'checks':RESULTS,'check_count':len(RESULTS),'production_schema_deployed':False,'filesystem_reclamation_verified':False,'backup_restore_verified':False,'foreign_key_check':db.execute('PRAGMA foreign_key_check').fetchall(),'integrity_check':db.execute('PRAGMA integrity_check').fetchone()[0]}
    if len(sys.argv)>1 and sys.argv[1]=='--write-receipt':(HERE/'ddl-validation.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:receipt[k] for k in ['status','table_count','foreign_key_count','index_count_including_autoindexes','explicit_index_count','sql_guard_count','check_count','schema_signature','foreign_key_check','integrity_check']},indent=2))
    db.close()


if __name__=='__main__':main()
