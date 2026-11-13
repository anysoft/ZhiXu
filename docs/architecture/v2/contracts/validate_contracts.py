#!/usr/bin/env python3
"""NON-RUNTIME S0 design validator. Reads source; SQLite is exclusively :memory:."""
import hashlib
import json
import pathlib
import re
import sqlite3
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
DOCS = HERE.parent
ROOT = HERE.parents[3]
checks = []

def digest(data):
    return hashlib.sha256(data).hexdigest()

def check(name, condition, scope='STATICALLY_VALIDATED'):
    if not condition:
        raise AssertionError(name)
    checks.append({'name': name, 'status': scope})

def load(name):
    return json.loads((HERE / name).read_text())

baseline = load('s0-input-fingerprints.json')
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
check('HEAD_matches_source_baseline', head == baseline['head'])
paths = [p for p in subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0') if p]
tracked = []
for name in paths:
    p = ROOT / name
    tracked.append((name, digest(p.read_bytes()) if p.exists() else None))
actual = digest(json.dumps(sorted(tracked), ensure_ascii=False, separators=(',', ':')).encode())
check('all_tracked_bytes_unchanged_from_entry_including_user_gitignore', actual == baseline['tracked_tree_sha256'])
check('existing_gitignore_preserved', digest((ROOT / '.gitignore').read_bytes()) == baseline['gitignore_sha256'])
updates = []
for name, old in baseline['assessment_reports'].items():
    if digest((ROOT / name).read_bytes()) != old:
        updates.append(name)
check('only_three_authorized_prior_reports_updated', set(updates) == set(baseline['authorized_prior_report_updates']))
check('899_file_inventory_not_regenerated', digest((DOCS / 'FILE_IMPACT_INVENTORY.md').read_bytes()) == baseline['assessment_reports']['docs/architecture/v2/FILE_IMPACT_INVENTORY.md'])
required = ['TECHNICAL_CONTRACT','DECISION_RECORD','DATABASE_CONTRACT','API_CONTRACT','EXECUTION_LOCK_CONTRACT','SYNC_EVENT_CONTRACT','BACKUP_RESTORE_CONTRACT','ERROR_CODES','ACCEPTANCE_GATES','REVIEW_REPORT']
check('ten_S0_contract_documents_exist', all((DOCS / ('S0_' + n + '.md')).is_file() for n in required))

errors = load('error-codes.json')['errors']
registry = {row['code']: row for row in errors}
check('unique_error_codes', len(registry) == len(errors))
error_fields = {'code','http_status','retryable','safe_message','affected_resource','operation','recovery_action','current_source_mapping'}
check('error_records_complete', all(error_fields <= set(row) for row in errors))
required_errors = {'WORKSPACE_NOT_FOUND','WORKSPACE_TYPE_INVALID','WORKSPACE_NOT_READY','WORKSPACE_BUSY','WORKSPACE_REFERENCED','WORKSPACE_VERSION_CONFLICT','WORKSPACE_PATH_INVALID','WORKSPACE_FILE_CONFLICT','WORKSPACE_RECOVERY_REQUIRED','GIT_DIRTY','GIT_DIVERGED','GIT_LOCAL_COMMITS','SYNC_POLICY_INVALID','SYNC_ALREADY_RUNNING','SYNC_RECOVERY_REQUIRED','SOURCE_MISSING','SOURCE_SUPERSEDED'}
check('required_error_contract_covered', required_errors <= set(registry))
routes = load('api-contracts.json')['routes']
check('routes_unique', len({(r['method'],r['path']) for r in routes}) == len(routes))
route_fields = {'method','path','authentication','authorization','request_dto','response_dto','expected_version','idempotency_key','errors','allowed_lifecycle_states','workspace_type_constraints','side_effects','success_http_status'}
check('all_route_contract_fields_complete', all(route_fields <= set(r) for r in routes))
check('route_errors_registered', all(set(r['errors']) <= set(registry) for r in routes))
check('Workspace_routes_explicit_Panel_only', all(r['authentication'] == 'PANEL_SESSION' for r in routes if r['path'].startswith('/workspaces')))
check('new_Workspace_list_create_and_lifecycle_routes_exist', {('GET','/workspaces'),('POST','/workspaces'),('POST','/workspaces/:id/archive'),('POST','/workspaces/:id/unarchive'),('DELETE','/workspaces/:id')} <= {(r['method'],r['path']) for r in routes})

sql = (HERE / 'fresh-v2.sql').read_text()
receipt = load('ddl-validation.json')
check('DDL_receipt_matches_current_artifact', receipt['ddl_sha256'] == digest(sql.encode()))
check('DDL_dynamic_receipt_is_memory_only_and_all_cases_verified', receipt['status'] == 'DYNAMICALLY_VERIFIED' and receipt['database'] == ':memory:' and receipt['check_count'] == len(receipt['checks']) and all(c['status'] == 'DYNAMICALLY_VERIFIED' for c in receipt['checks']))
check('DDL_receipt_does_not_claim_runtime_qualifications', not receipt['production_schema_deployed'] and not receipt['filesystem_reclamation_verified'] and not receipt['backup_restore_verified'])
db = sqlite3.connect(':memory:')
db.executescript(sql)
core_tables = {'Workspaces','GitWorkspaces','WorkspaceSyncPolicies','WorkspaceSyncRuns','WorkspaceUpdateOutbox','WorkspaceDiscoveryPolicies','WorkspaceDiscoverySuppressions','TaskSources','Tasks','TaskRuns','WorkspaceRuntimeDefaults','EnvironmentProfiles','WorkspaceProfileVariables','WorkspaceConfigBindings'}
tables = {r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
check('required_candidate_tables_complete', core_tables <= tables)
check('no_independent_Subscriptions_or_Worktrees_tables', not {'Subscriptions','Worktrees'} & tables)
queue_columns = {r[1] for r in db.execute('PRAGMA table_info(TaskRuns)')}
check('single_Run_queue_has_durable_expectation_and_wait_fields', {'queue_reason','queue_deadline_at','next_eligible_at','queue_attempt_count','expected_workspace_version','expected_source_generation','expected_content_revision','expected_task_definition_version','expected_global_env_version','expected_git_commit','expected_inventory_hash','admission_snapshot','source_snapshot'} <= queue_columns)
git_columns = {r[1] for r in db.execute('PRAGMA table_info(GitWorkspaces)')}
check('initial_baseline_marker_survives_history_pointer_retention', {'baseline_established','baseline_sync_run_id'} <= git_columns)
check('stable_schema_and_FK_integrity_after_fresh_DDL', not list(db.execute('PRAGMA foreign_key_check')) and db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok')
db.close()
state = load('execution-transitions.json')
check('one_queue_same_workspace_exclusive', state['queue_storage'] == 'TaskRuns' and state['same_workspace_parallel'] is False)
check('execution_transition_targets_exist', all(target in state['transitions'] for targets in state['transitions'].values() for target in targets))
check('terminal_execution_states_do_not_auto_retry', all(not state['transitions'][s] for s in state['terminal_states']))
check('skip_codes_registered', set(state['skip_rules'].values()) <= set(registry))

link_count = 0
for p in DOCS.rglob('*.md'):
    source = p.read_text()
    if p.name.startswith('S0_') or p.name in {'TARGET_ARCHITECTURE.md','OPEN_DECISIONS.md','IMPLEMENTATION_ROADMAP.md'}:
        width = None
        for line in source.splitlines():
            if line.startswith('|'):
                count = len(re.split(r'(?<!\\)\|',line))-2
                if width is None:
                    width = count
                else:
                    check('table_columns:' + p.name, width == count)
            else:
                width = None
    for target in re.findall(r'(?<!!)\[[^\]\n]*\]\(([^)\n]+)\)', source):
        if re.match(r'^(https?:|mailto:|#)', target):
            continue
        name, _, fragment = target.partition('#')
        destination = (p.parent / name).resolve()
        check('local_link:' + p.name, destination.exists())
        if re.fullmatch(r'L[0-9]+',fragment):
            check('local_line:' + p.name, 1 <= int(fragment[1:]) <= len(destination.read_text(errors='replace').splitlines()))
        link_count += 1
result = {'scope':'NON_RUNTIME_S0_CONTRACT_STATIC_REVIEW','status':'STATICALLY_VALIDATED','head':head,'tracked_files_verified':len(paths),'prior_reports_changed':updates,'route_count':len(routes),'error_count':len(errors),'local_links_checked':link_count,'ddl_dynamic_case_count':receipt['check_count'],'ddl_schema_signature':receipt['schema_signature'],'check_count':len(checks),'qualifications_not_run':['production_ORM_or_schema','API_auth_integration','filesystem_reclamation','Git_sync','Runner_FD_crash','real_backup_restore','browser','Linux','Container','AMD64_ARM64','capacity_benchmark'],'checks':checks}
(HERE / 'contract-validation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k != 'checks'},ensure_ascii=False,indent=2))
