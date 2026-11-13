#!/usr/bin/env python3
"""Seal private S4 qualification facts into a public hash-addressed report.

Only root_suites qualify tests. Entries are chronological; a clean focused retry
can supersede exactly the same case, while every original exit and summary stays
visible. Agent bundles are supplementary proof, never an alternative test gate.
Exit 0 PASS, 1 FAIL, 2 PENDING. No raw log, screenshot, ENV/Config, private path,
credential or arbitrary private prose is copied into the public output.
"""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import re
import shlex
import stat
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location('s3_readonly_collector', ROOT / 'tests/workspace-v2/s3/collect-results.py')
S3 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S3)
HEX = re.compile(r'^[a-f0-9]{64}$')
SHA1 = re.compile(r'^[a-f0-9]{40}$')
EXPECTED = {'S1A': 68, 'S2': 112, 'S1B': 36, 'S3': 81, 'V9': 210}
BUNDLES = tuple('s4-' + name + '-evidence.json' for name in ('task-runtime', 'workspace-git', 'backup', 'notification', 'browser-lifecycle', 'terminal-restore'))
CHECKS = {'frozen_s0', 'backend_typescript', 'backend_build', 'frontend_build', 'architecture_boundaries', 'gitnexus_detect_changes'}
HISTORICAL = ('docs/architecture/v2/S1A_IMPLEMENTATION_REPORT.md', 'docs/architecture/v2/S2_IMPLEMENTATION_REPORT.md', 'docs/architecture/v2/S1B_QUALIFICATION_REPORT.md', 'docs/architecture/v2/S3_IMPLEMENTATION_REPORT.md', 'tests/workspace-v2/validation-results.json', 'tests/workspace-v2/contract-status.json', 'tests/workspace-v2/s2-validation-results.json', 'tests/workspace-v2/s1b-validation-results.json', 'tests/workspace-v2/s3-validation-results.json', 'tests/workspace-v2/s3/collect-results.py')
SCOPES = {'cold', 'owned_reopen', 'owned_restart', 'http', 'browser', 'entry', 'legacy', 'mixed', 'focused_retry', 'not_applicable'}
STATES = set('PASS FAIL FAILED PENDING READY SUCCESS NO_CHANGE BLOCKED QUEUED RUNNING RESOLVING SKIPPED CANCELLED INTERRUPTED RECOVERY_REQUIRED ARCHIVED RECLAIMED PRESENT ABSENT PENDING_RECLAIM RETRY DEAD PROCESSING DISPATCHED SUBMITTED FILTERED APPLIED UNCHANGED NOT_STARTED NOT_REQUESTED SENDING SENT COMPLETE COMMITTED ROLLED_BACK SIGKILL SIGTERM NONE LOCAL GIT SHELL NODE PYTHON JAVASCRIPT TYPESCRIPT'.split())
BOOLS = set('actual_production_entry actual_application_restart actual_runtime_domain_reopen actual_managed_child actual_managed_executables host_fallback actual_child_log_proved actual_pwd_child actual_totp actual_http_2fa_activation previous_auth_configuration_session_commit_rejected revoked_sessions_stay_revoked profile_change_revokes_sessions old_credentials_rejected weak_default_password_rejected logout_revokes_session platform_membership_enforced trust_proxy_opt_in settings_dto_unknown_fields_rejected old_sessions_revoked_on_activate deactivate_revokes_session secret_not_in_current_profile password_hash_unchanged session_membership_unchanged previous_session_valid partial_authentication_mutation username_only_preserves_password every_previous_session_revoked combined_credentials_and_2fa_state_coherent real_2fa_disabled queued_sync_preserved pending_outbox_preserved one_task_run schedule_survives_restart unknown_journal_retained no_automatic_replay ready workspace_free private_root_projected pagination_root_overlap_protected public_url_preserved stored_history_unchanged secret_env_config_redacted original_config_restored actual_hook_executed public_config_mapping internal_enum_aliases_rejected duplicate_submission_same_run task_references_block_delete public_runtime_paths_omitted public_failure_roots_projected stored_failure_log_unchanged independent_recovery actual_inflight actual_effect_count initial_fetch_failed startup_write_admission backup_verified restore_verified private_models_absent source_preserved no_subscription_api no_subscription_menu'.split())
OBJECTS = {'actual', 'final', 'proof', 'runtime', 'python', 'node', 'source', 'checks', 'before', 'after', 'http', 'runs', 'events', 'syncs', 'outboxes', 'operation_history', 'task_runs', 'matrix', 'checkpoints'}
STATUS_KEYS = {'status', 'phase', 'error_code', 'result_code', 'rejection', 'killed_signal', 'signal', 'recovered_status', 'workspace_state', 'lifecycle_state', 'discovery_status', 'git_update_status', 'event_status', 'sync_status', 'outbox_status', 'trigger_source', 'language', 'kind', 'task_run_status', 'controlled_node_failure_status'}
HASH_KEYS = set('evidence_sha256 retained_log_sha256 stdout_sha256 stderr_sha256 journal_sha256 python_config_sha256 node_lock_sha256 build_lock_sha256 inventory_hash entrypoint_checksum config_hash lock_hash archive_sha256 manifest_sha256 content_sha256 controlled_node_failure_log_sha256 source_inventory_sha256 target_commit expected_git_commit before_commit after_commit git_commit actual_commit source_commit'.split())
IDENTIFIER = re.compile(r'^(?:(?:workspace|task|task_run|sync_run|outbox|trigger|event|repository|profile|asset|revision|build|runtime|node_environment|python_environment|node_build|python_build|controller|recovery_controller|initial_worker|recovery_worker|origin_trigger|source|instance_A_controller|instance_B_controller|independent_controller|controlled_node_failure_run)_(?:id|ids|count|version|revision|generation|pid|pids)|id|pid|attempt_count|attempts|tests|pass|fail|skip|exit_code|recovery_exit_code|fresh_recovery_exit_code|duration_ms|actual_effect_count|task_run_count|boundary_cursor_original_bytes)$')
UNSUPPORTED = {'POST /api/system/storage-retention/preview', 'POST /api/system/storage-retention/cleanup', 'PUT /api/user/notification', 'PUT /api/user/notification/init'}


def sha(data): return hashlib.sha256(data).hexdigest()
def read_json(path): return json.loads(S3.regular_bytes(path, 16 * 1024 * 1024))
def git(*args): return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
def case_id(stage, name): return stage.lower() + '-' + sha(name.encode())[:24]
def alias(kind, digest, suffix=''): return kind + '-' + digest[:20] + suffix


def repo_name(value):
    name = S3.repo_path(value)
    if not name.startswith(('back/', 'src/', 'tests/', 'docs/', 'scripts/', 'config/', '.umirc', 'package', 'tsconfig', 'TEMPORARY_', 'GREENFIELD_')):
        raise ValueError('NON_SOURCE_REPOSITORY_PATH')
    return name


def command_parts(value):
    if isinstance(value, list): return list(map(str, value))
    return shlex.split(str(value))


def clean_command(value):
    """Unrecognized arguments are private, including --password= and following values."""
    out = []
    for part in command_parts(value):
        if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', part):
            out.append(part.split('=', 1)[0] + '=<private>'); continue
        if re.search(r'password|secret|credential|authorization|token|private.key', part, re.I):
            out.append('<private-argument>'); continue
        base = pathlib.Path(part).name
        if base in {'node', 'python', 'python3', 'git', 'pnpm', 'npx', 'tsc'}:
            out.append(base); continue
        candidate = part
        if pathlib.Path(part).is_absolute():
            try: candidate = pathlib.Path(part).relative_to(ROOT).as_posix()
            except ValueError: out.append('<owned-test-artifact>'); continue
        if candidate.startswith(('tests/', 'back/', 'src/', 'scripts/', 'docs/architecture/', 'node_modules/')) and '..' not in pathlib.PurePosixPath(candidate).parts:
            # Source/runner paths are authored repository names, never private CLI inputs.
            if re.fullmatch(r'[A-Za-z0-9_./@+-]+', candidate): out.append(candidate); continue
        if re.fullmatch(r'--[A-Za-z][A-Za-z0-9_-]*(?:=[0-9]+)?', part) or part in {'-r', '-p', '-m', '-c', '-I', '-S', '-B', 'true', 'false', 'ts-node/register/transpile-only'}:
            out.append(part)
        else: out.append('<private-argument>')
    return out


def files_in_command(value):
    parts = command_parts(value)
    if any('--test-name-pattern' in p or '--test-skip-pattern' in p for p in parts): return set()
    found = set()
    for part in parts:
        if part.endswith('.test.cjs'):
            p = pathlib.Path(part)
            if p.is_absolute():
                try: p = p.relative_to(ROOT)
                except ValueError: continue
            if str(p).startswith('tests/') and (ROOT / p).is_file(): found.add(S3.repo_path(p))
            elif '/' not in part:
                for directory in ('tests/workspace-v2/s4', 'tests/workspace-v2/s3', 'tests/workspace-v2/s1b', 'tests/workspace-v2'):
                    if (ROOT / directory / part).is_file(): found.add(directory + '/' + part); break
    if not found:
        for directory in ('tests/workspace-v2/s4', 'tests/workspace-v2/s3', 'tests/workspace-v2/s1b'):
            if any(p.endswith(directory + '/run.cjs') for p in parts):
                found.update(p.relative_to(ROOT).as_posix() for p in (ROOT / directory).glob('*.test.cjs'))
        if any(p.endswith('tests/workspace-v2/run.cjs') for p in parts):
            found.update(p.relative_to(ROOT).as_posix() for p in (ROOT / 'tests/workspace-v2').glob('*.test.cjs') if not p.name.startswith('s2-'))
    return found


def safe_facts(record, depth=0):
    """Names, IDs and proof flags only; no arbitrary record keys or prose survive."""
    if not isinstance(record, dict) or depth > 8: return {}
    out = {}
    for key, value in record.items():
        if not isinstance(key, str): continue
        if key == 'case_id' and isinstance(value, str) and re.fullmatch(r'(?:S[0-4][A-Z]?[-_]|outbox-kill-|restore-kill-|full-)[A-Za-z0-9_-]{1,140}', value): out[key] = value
        elif key == 'checkpoint' and value in (*S3.SYNC_POINTS, *S3.OUTBOX_POINTS, 'DURING_FETCH', 'DURING_CHECKOUT'): out[key] = value
        elif key in STATUS_KEYS:
            if value is None or isinstance(value, str) and (value in STATES or key in {'error_code', 'result_code', 'rejection'} and re.fullmatch(r'(?:WORKSPACE|SOURCE|TASK|EXECUTION|RUNTIME|PYTHON|NODE|GIT|SYNC|DISCOVERY|BACKUP|RESTORE|CONFIG|ENV|AUTHENTICATION|PANEL|INVALID|ERR|ENTRY|WEBHOOK|NOTIFICATION|CHANNEL|IDEMPOTENCY|SECRET|EXIT)_[A-Z0-9_]{1,90}', value)): out[key] = value
            elif key == 'status' and type(value) is int and 100 <= value <= 599: out[key] = value
        elif key in BOOLS and type(value) is bool: out[key] = value
        elif IDENTIFIER.fullmatch(key):
            if type(value) in (int, float) and math.isfinite(value): out[key] = value
            elif isinstance(value, list) and len(value) <= 10000 and all(type(x) is int and x > 0 for x in value): out[key] = value
        elif key in {'http_statuses', 'concurrent_same_code_statuses'} and isinstance(value, list) and all(type(x) is int and 100 <= x <= 599 for x in value): out[key] = value[:1000]
        elif key == 'submission_key' and isinstance(value, str) and re.fullmatch(r'event:[1-9][0-9]*', value): out[key] = value
        elif key == 'event_key' and isinstance(value, str) and HEX.fullmatch(value): out[key] = value
        elif key in HASH_KEYS and isinstance(value, str) and re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', value): out[key] = value
        elif key in {'python_runtime_version', 'node_runtime_version', 'runtime_version', 'toolchain_version'} and isinstance(value, str) and re.fullmatch(r'\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.]{1,30})?', value): out[key] = value
        elif key in OBJECTS:
            if isinstance(value, dict): out[key] = safe_facts(value, depth + 1)
            elif isinstance(value, list): out[key] = [safe_facts(v, depth + 1) for v in value[:10000] if isinstance(v, dict)]
    return out


def stage_name(value):
    name = re.sub(r'[._\s-]', '', str(value).upper())
    return {'S1A': 'S1A', 'S1B': 'S1B', 'S2': 'S2', 'S3': 'S3', 'S4': 'S4', 'V9': 'V9', 'V9EXTRA': 'V9_EXTRA'}.get(name)



def parse_exact_log(text):
    summary, _ = S3.parse_log(text)
    cases = []
    for line in S3.ANSI.sub('', text).splitlines():
        match = re.match(r'^\s*([✔✖])\s+(.+?)\s+\(([\d.]+)ms\)\s*$', line)
        if match:
            mark, name, duration = match.groups()
            cases.append({'name': name, 'status': 'PASS' if mark == '✔' else 'FAIL', 'duration_ms': float(duration)})
            continue
        match = re.match(r'^\s*(not ok|ok)\s+\d+\s+-\s+(.+?)(?:\s+#\s+(SKIP|TODO).*)?$', line)
        if match:
            mark, name, skipped = match.groups()
            cases.append({'name': name, 'status': 'SKIPPED' if skipped else 'PASS' if mark == 'ok' else 'FAIL'})
    return summary, cases


def suite_history(specs, add_artifact):
    rows, latest, covered, issues = [], {}, set(), []
    for number, spec in enumerate(specs, 1):
        stage = stage_name(spec.get('stage'))
        if not stage: issues.append('SUITE_STAGE_INVALID'); continue
        role = spec.get('role', 'qualification')
        if role not in {'qualification', 'history'}: issues.append('SUITE_ROLE_INVALID'); continue
        scope = spec.get('scope', 'not_applicable')
        if stage == 'S4' and role == 'qualification' and ('scope' not in spec or scope == 'not_applicable'): issues.append('S4_SUITE_SCOPE_REQUIRED')
        if scope not in SCOPES: issues.append('SUITE_SCOPE_INVALID'); scope = 'not_applicable'
        row = {'suite_id': 'suite-' + str(number).zfill(4), 'stage': stage, 'role': role, 'scope': scope, 'command': clean_command(spec.get('command', [])), 'exit_code': spec.get('exit_code')}
        rows.append(row)
        try:
            data = S3.regular_bytes(spec['log']); digest = add_artifact(spec['log'], 'log')
            summary, cases = parse_exact_log(data.decode('utf8', errors='replace'))
        except (KeyError, OSError, ValueError): row['qualification'] = 'EVIDENCE_UNAVAILABLE'; issues.append('SUITE_LOG_UNAVAILABLE'); continue
        if spec.get('log_sha256') and digest != spec['log_sha256']: issues.append('SUITE_LOG_HASH_MISMATCH')
        row.update(log_sha256=digest, summary=summary, case_count=len(cases), test_files=sorted(files_in_command(spec.get('command', []))), case_outcomes=[{'case_id': case_id(stage, c['name']), 'status': c['status'], **({'duration_ms': c['duration_ms']} if 'duration_ms' in c else {})} for c in cases])
        coherent = bool(summary and summary['tests'] == len(cases) and summary['tests'] == summary['pass'] + summary['fail'] + summary['cancelled'] + summary['skipped'] + summary['todo'])
        clean = bool(coherent and spec.get('exit_code') == 0 and not any(summary[k] for k in ('fail', 'cancelled', 'skipped', 'todo')) and summary['pass'] == summary['tests'])
        expected = spec.get('expected_count')
        if expected is not None and (not summary or type(expected) is not int or summary['tests'] != expected): issues.append('SUITE_EXPECTED_COUNT_MISMATCH')
        row['qualification'] = 'COMPLETE' if clean else 'HISTORICAL_INCOMPLETE' if role == 'history' else 'REQUIRES_FOCUSED_REQUALIFICATION'
        if role == 'qualification':
            if not coherent: issues.append('SUITE_CASE_ACCOUNTING_INCOMPLETE')
            if summary and len(row['test_files']) > summary['tests']: issues.append('SUITE_COMMAND_FILE_ACCOUNTING_INVALID')
            if not cases: issues.append('SUITE_CASES_MISSING')
            for case in cases:
                # A failing full run still proves its individual passing cases;
                # an unexplained nonzero exit on an all-pass summary proves none.
                eligible = bool(coherent and not any(summary[k] for k in ('skipped', 'todo')) and (spec.get('exit_code') == 0 or summary['fail'] or summary['cancelled']))
                latest[(stage, case['name'])] = {**case, 'eligible': eligible and case['status'] == 'PASS', 'suite_id': row['suite_id'], 'files': row['test_files']}
        row['_private_case_names'] = [c['name'] for c in cases]
    for row in rows:
        names = row.pop('_private_case_names', [])
        if row['role'] == 'qualification' and names and all(latest.get((row['stage'], name), {}).get('eligible') for name in names):
            if row['stage'] == 'S4': covered.update(row.get('test_files', []))
            if row['qualification'] != 'COMPLETE': row['qualification'] = 'SUPERSEDED_BY_LATER_EXACT_CASE_RESULTS'
    return rows, latest, covered, issues


def public_cases(latest, stage):
    return [{'case_id': case_id(stage, name), 'name_sha256': sha(name.encode()), 'status': value['status'], 'qualified': value['eligible'], 'suite_id': value['suite_id'], **({'duration_ms': value['duration_ms']} if 'duration_ms' in value else {})} for (group, name), value in sorted(latest.items()) if group == stage]



def evaluate_case_gates(latest, expected_s4):
    result = {}
    for stage, expected in {**EXPECTED, 'S4': expected_s4}.items():
        cases = public_cases(latest, stage)
        count = len(cases); passed = sum(case['qualified'] for case in cases)
        good = type(expected) is int and expected > 0 and count == expected and passed == expected
        result[stage] = {'expected': expected, 'tests': count, 'pass': passed, 'failed_or_unqualified': count - passed, 'passed': good, 'cases': cases}
    return result


def verify_frozen(entry):
    frozen, history, problems = {}, {}, []
    baseline = json.loads(git('show', entry + ':tests/workspace-v2/s2-validation-results.json'))
    mapping = baseline['frozen_s0_sha256']
    if len(mapping) != 37: problems.append('FROZEN_S0_COUNT_NOT_37')
    for name, expected in {**mapping, **{n: S3.historical_blob_hash(n, entry) for n in HISTORICAL}}.items():
        try:
            safe = S3.repo_path(name); actual = sha(S3.regular_bytes(ROOT / safe))
            target = frozen if name in mapping else history
            target[safe] = {'sha256': actual, 'expected_sha256': expected, 'unchanged': actual == expected}
            if actual != expected: problems.append('FROZEN_OR_HISTORICAL_BYTES_CHANGED')
        except (OSError, ValueError): problems.append('FROZEN_OR_HISTORICAL_ARTIFACT_UNAVAILABLE')
    ignore = sha(S3.regular_bytes(ROOT / '.gitignore'))
    if ignore != S3.GITIGNORE_SHA: problems.append('USER_GITIGNORE_CHANGED')
    return {'frozen_s0': frozen, 'historical': history, 'user_gitignore': {'sha256': ignore, 'expected_sha256': S3.GITIGNORE_SHA, 'unchanged': ignore == S3.GITIGNORE_SHA}}, problems


def route_gate(spec, add_artifact):
    expected = {(r['method'], r['path']): r for r in read_json(ROOT / 'docs/architecture/v2/contracts/api-contracts.json')['routes']}
    result = {'expected_frozen_routes': 129, 'frozen_routes': [], 'registered_routes': [], 'passed': False}
    problems = []
    try:
        frozen = read_json(spec['file']); registered = read_json(spec['registered_file'])
        if isinstance(frozen, dict): frozen = frozen.get('routes', frozen.get('coverage'))
        if isinstance(registered, dict): registered = registered.get('routes', registered.get('registered_routes'))
        result['coverage_sha256'] = add_artifact(spec['file'], 'route-coverage')
        result['registered_sha256'] = add_artifact(spec['registered_file'], 'route-catalog')
        if not isinstance(frozen, list) or not isinstance(registered, list): raise ValueError('ROUTE_ARRAY_REQUIRED')
        found = set(); frozen_details = {}
        for row in frozen:
            key = (row.get('method'), row.get('path')); contract = expected.get(key)
            if not contract or key in found: raise ValueError('FROZEN_ROUTE_SET_MISMATCH')
            found.add(key); frozen_details[key] = row
            for field in ('controller', 'service'):
                text = row.get(field)
                if not isinstance(text, str) or not text.strip() or re.search(r'EXPLICIT_V2_SERVICE|CURRENT_.*RESPONSE|PLACEHOLDER|TODO|MOCK', text): raise ValueError('NON_CONCRETE_ROUTE_IMPLEMENTATION')
            if row.get('status') != 'IMPLEMENTED' or row['request_dto'] != contract['request_dto'] or row['response_dto'] != contract['response_dto']: raise ValueError('FROZEN_ROUTE_DTO_OR_STATUS_MISMATCH')
            result['frozen_routes'].append({k: row[k] for k in ('method', 'path', 'controller', 'service', 'request_dto', 'response_dto', 'status')})
        if len(expected) != 129 or found != set(expected): raise ValueError('FROZEN_ROUTE_SET_MISMATCH')
        seen = set()
        for row in registered:
            key = str(row.get('method')) + ' ' + str(row.get('path'))
            if key in seen or not re.fullmatch(r'(?:GET|POST|PUT|PATCH|DELETE) /(?:api|hooks)/[A-Za-z0-9_/:.*-]+', key): raise ValueError('REGISTERED_ROUTE_INVALID_OR_DUPLICATE')
            seen.add(key)
            if re.search(r'/(?:subscriptions|worktrees)(?:/|$)', row['path']): raise ValueError('RETIRED_SUBSCRIPTION_ROUTE_EXPOSED')
            if row.get('status') == 'UNSUPPORTED_BY_FROZEN_SCHEMA':
                if key not in UNSUPPORTED or not row.get('reason'): raise ValueError('UNSUPPORTED_ROUTE_NOT_FROZEN_EXCEPTION')
                projection = {k: row[k] for k in ('method', 'path', 'status', 'scope')}
                projection['reason_code'] = 'RETIRED_DOMAIN_WRITE'
            else:
                if row.get('status') != 'IMPLEMENTED': raise ValueError('REGISTERED_ROUTE_NOT_IMPLEMENTED')
                logical = (row.get('method'), row.get('path', '').removeprefix('/api'))
                matching_frozen = frozen_details.get(logical) if row.get('scope') == 'FROZEN_S0' else None
                if row.get('scope') == 'FROZEN_S0' and not matching_frozen: raise ValueError('REGISTERED_FROZEN_ROUTE_MISMATCH')
                for field in ('controller', 'service', 'request_dto', 'response_dto'):
                    value = row.get(field)
                    if matching_frozen:
                        if value != matching_frozen.get(field): raise ValueError('REGISTERED_FROZEN_IMPLEMENTATION_MISMATCH')
                    elif not isinstance(value, str) or not value.strip() or re.search(r'EXPLICIT_V2_SERVICE|CURRENT_.*RESPONSE|PLACEHOLDER|TODO|MOCK', value): raise ValueError('NON_CONCRETE_RETAINED_ROUTE_IMPLEMENTATION')
                projection = {k: row[k] for k in ('method', 'path', 'status', 'scope', 'controller', 'service', 'request_dto', 'response_dto')}
            result['registered_routes'].append(projection)
        if not all(method + ' /api' + route in seen for method, route in expected): raise ValueError('FROZEN_ROUTE_NOT_REGISTERED')
        result['registered_count'] = len(seen); result['passed'] = True
    except (KeyError, OSError, TypeError, ValueError): problems.append('ACTUAL_ROUTE_COVERAGE_INCOMPLETE')
    return result, problems


def physical_gates(latest, records):
    cases = {name: value for (stage, name), value in latest.items() if stage == 'S3' and value['eligible']}
    gates = {}
    for point in S3.SYNC_POINTS:
        good_case = any('S3-CRASH ' + point + ' actual SIGKILL' in name for name in cases)
        def sync_record(r):
            if r.get('case_id') != 'S3-CRASH-' + point or r.get('killed_signal') != 'SIGKILL' or r.get('independent_recovery') is not True: return False
            group = r.get('_evidence_group')
            related = [v for v in records if group and v.get('_evidence_group') == group and v.get('sync_run_id') == r.get('sync_run_id')]
            before = [v for v in related if v.get('checkpoint') == point and type(v.get('pid')) is int and v['pid'] > 0]
            after = [v for v in related if v.get('checkpoint') == 'RECOVER' and type(v.get('pid')) is int and v['pid'] > 0 and v.get('workspace_state') == 'READY' and v.get('foreign_key_errors') == 0]
            return any(a['pid'] != b['pid'] for a in before for b in after)
        proof = any(sync_record(r) for r in records)
        gates[point] = {'case_passed': good_case, 'physical_record': proof, 'passed': good_case and proof}
    for point in S3.OUTBOX_POINTS:
        def match(r):
            a = r.get('actual', {})
            return r.get('case_id') == 'outbox-kill-' + point.lower() and isinstance(a, dict) and a.get('killed_signal') == 'SIGKILL' and type(a.get('initial_worker_pid')) is int and type(a.get('recovery_worker_pid')) is int and a['initial_worker_pid'] > 0 and a['recovery_worker_pid'] > 0 and a['initial_worker_pid'] != a['recovery_worker_pid'] and a.get('actual_effect_count') == 1
        good_case = any('dispatcher SIGKILL ' + point + ' ' in name for name in cases)
        proof = any(match(r) for r in records)
        gates[point] = {'case_passed': good_case, 'physical_record': proof, 'passed': good_case and proof}
    for mode in ('FETCH', 'CHECKOUT'):
        good_case = any('Sync SIGKILL during actual ' + mode + ' ' in name for name in cases)
        proof = any(S3.physical_git_record(r, mode) for r in records)
        gates['DURING_' + mode] = {'case_passed': good_case, 'physical_record': proof, 'passed': good_case and proof}
    return {'required': 14, 'passed': sum(g['passed'] for g in gates.values()), 'checkpoints': gates}


def collect_s4_results(index, index_path, output):
    pending, failures, artifacts, raw_records, proofs, receipts, processed_roots = [], [], {}, {}, {}, {}, set()
    def artifact(path, kind):
        data = S3.regular_bytes(path); digest = sha(data)
        artifacts[(kind, digest)] = {'kind': kind, 'alias': alias(kind, digest, pathlib.Path(path).suffix if pathlib.Path(path).suffix in {'.png', '.json', '.log'} else ''), 'sha256': digest, 'bytes': len(data)}
        return digest
    def owned_records(value):
        try:
            root = S3.owned_run(value)
            if root in processed_roots: return
            processed_roots.add(root)
            receipt = root / 'qualification-result.json'
            if receipt.is_file():
                r = read_json(receipt); digest = artifact(receipt, 'receipt')
                receipts[digest] = {'sha256': digest, 'facts': safe_facts(r)}
            for file in sorted(root.glob('*/evidence/*.json')):
                if any(p.is_symlink() for p in (file, file.parent, file.parent.parent)): continue
                info = file.lstat()
                if info.st_uid != os.getuid() or info.st_nlink != 1: continue
                r = read_json(file)
                if isinstance(r, dict):
                    digest = artifact(file, 'evidence'); r['_evidence_group'] = sha(str(file.parent.parent).encode()); raw_records[digest] = r; proofs[digest] = {'sha256': digest, 'facts': safe_facts(r)}
            for directory in ('evidence', 'artifacts', 'screenshots', 'browser-artifacts'):
                for file in root.glob('*/' + directory + '/*.png'):
                    if file.resolve().is_relative_to(root) and not any(p.is_symlink() for p in (file, file.parent, file.parent.parent)):
                        info = file.lstat()
                        if info.st_uid == os.getuid() and info.st_nlink == 1: artifact(file, 'browser-artifact')
        except (OSError, ValueError, json.JSONDecodeError): pending.append('OWNED_PROOF_ROOT_UNAVAILABLE')
    def discover_roots(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key in {'retained_root', 'retained_roots'}:
                    for r in (item.values() if isinstance(item, dict) else item if isinstance(item, list) else [item]):
                        if isinstance(r, str): owned_records(r)
                elif isinstance(item, (dict, list)): discover_roots(item)
        elif isinstance(value, list):
            for item in value: discover_roots(item)
    branch, head, entry = git('branch', '--show-current'), git('rev-parse', 'HEAD'), index.get('entry_head')
    if not isinstance(entry, str) or not SHA1.fullmatch(entry): raise ValueError('ENTRY_HEAD_REQUIRED')
    execution_head = index.get('execution_head', entry)
    if not isinstance(execution_head, str) or not SHA1.fullmatch(execution_head): raise ValueError('EXECUTION_HEAD_INVALID')
    relation = 'EXECUTION_HEAD'
    sealed = {}
    if head != execution_head:
        report = subprocess.run(['git', 'show', 'HEAD:' + S3.repo_path(index.get('report_path', 'tests/workspace-v2/s4-validation-results.json'))], cwd=ROOT, capture_output=True, check=False)
        sealed = json.loads(report.stdout) if report.returncode == 0 else {}
        if git('rev-parse', 'HEAD^') == execution_head and sealed.get('final_head') == 'SELF' and sealed.get('sealed_by') == 'containing commit': relation = 'SEALED_CONTAINING_COMMIT'
        else: failures.append('UNEXPECTED_CURRENT_HEAD')
    if subprocess.run(['git', 'merge-base', '--is-ancestor', entry, head], cwd=ROOT).returncode: failures.append('ENTRY_NOT_CURRENT_ANCESTOR')
    if index.get('branch') != branch: failures.append('BRANCH_IDENTITY_MISMATCH')
    rows, latest, covered, issues = suite_history(index.get('root_suites', []), artifact)
    pending.extend(issues)
    for spec in index.get('root_suites', []):
        try:
            text = S3.regular_bytes(spec['log']).decode('utf8', errors='replace')
            for root in re.findall(r'^S1B retained sandbox: (.+)$', text, re.M): owned_records(root.strip())
        except (KeyError, OSError, ValueError): pass
        discover_roots(spec)
    bundles = []
    paths = index.get('evidence_files', ['/tmp/' + n for n in BUNDLES])
    supplied = {pathlib.Path(p).name for p in paths}
    if not set(BUNDLES).issubset(supplied): pending.append('MANDATORY_AGENT_BUNDLES_MISSING')
    for file in paths:
        try:
            data = read_json(file); digest = artifact(file, 'agent-bundle')
            bundles.append({'bundle_id': pathlib.Path(file).name if pathlib.Path(file).name in BUNDLES else alias('bundle', digest), 'sha256': digest, 'facts': safe_facts(data)})
            discover_roots(data)
        except (OSError, ValueError, json.JSONDecodeError): pending.append('AGENT_BUNDLE_UNAVAILABLE')
    all_files = {p.relative_to(ROOT).as_posix() for p in (ROOT / 'tests/workspace-v2/s4').glob('*.test.cjs')}
    missing = sorted(all_files - covered)
    if missing: pending.append('S4_TEST_FILE_COVERAGE_INCOMPLETE')
    stages = evaluate_case_gates(latest, index.get('expected_s4_cases'))
    for stage, gate in stages.items():
        if not gate['passed']: pending.append(stage + '_EXACT_LATEST_CASE_GATE_INCOMPLETE')
    extras = public_cases(latest, 'V9_EXTRA')
    if not extras or not all(c['qualified'] for c in extras): pending.append('RELEVANT_SHARED_V9_EXTRA_REGRESSION_MISSING')
    frozen, frozen_problems = verify_frozen(entry); failures.extend(frozen_problems)
    routes, route_problems = route_gate(index.get('route_coverage', {}), artifact); pending.extend(route_problems)
    checks = []
    check_ids = set()
    for spec in index.get('checks', []):
        identifier = spec.get('id'); row = {'id': identifier if identifier in CHECKS else 'additional_check', 'command': clean_command(spec.get('command', [])), 'exit_code': spec.get('exit_code')}
        try: row['log_sha256'] = artifact(spec['log'], 'check')
        except (KeyError, OSError, ValueError): pending.append('CHECK_LOG_UNAVAILABLE')
        if spec.get('exit_code') != 0: pending.append('REQUIRED_CHECK_NOT_PASSED')
        elif identifier in CHECKS and 'log_sha256' in row: check_ids.add(identifier)
        checks.append(row)
    if not CHECKS.issubset(check_ids): pending.append('REQUIRED_BUILD_CONTRACT_ARCHITECTURE_CHECKS_MISSING')
    review = []
    for spec in index.get('review_gates', []):
        status = spec.get('status')
        if status not in {'PASS', 'PENDING', 'FAIL'}: status = 'PENDING'
        review.append({'gate_id': 'review-' + str(len(review) + 1), 'name_sha256': sha(str(spec.get('name')).encode()), 'status': status})
        if status == 'FAIL': failures.append('INDEPENDENT_REVIEW_FAILED')
        elif status != 'PASS': pending.append('INDEPENDENT_REVIEW_PENDING')
    if not review: pending.append('INDEPENDENT_REVIEW_REQUIRED')
    crash = physical_gates(latest, list(raw_records.values()))
    if crash['passed'] != 14: pending.append('FOURTEEN_REAL_SIGKILL_PROOFS_INCOMPLETE')
    if not any(a['kind'] == 'browser-artifact' for a in artifacts.values()): pending.append('REAL_BROWSER_ARTIFACT_HASH_REQUIRED')
    if not any(r.get('actual_production_entry') is True and r.get('status') == 'PASS' for r in raw_records.values()): pending.append('REAL_PRODUCTION_ENTRY_PROOF_REQUIRED')
    source = set(index.get('source_paths', []))
    source.add('tests/workspace-v2/s3/collect-results.py')
    if relation == 'SEALED_CONTAINING_COMMIT': source.update(sealed.get('qualified_source_test_sha256', {}).keys())
    source.update(p.relative_to(ROOT).as_posix() for directory in ('back/applicationV2', 'src/v2', 'tests/workspace-v2/s4') for p in (ROOT / directory).rglob('*') if p.is_file() and p.suffix in {'.ts', '.tsx', '.cjs', '.mjs', '.py', '.less', '.json'})
    source.update(git('diff', '--name-only', 'HEAD').splitlines())
    source_hashes = {}
    for value in sorted(source):
        if not value: continue
        try:
            name = repo_name(value)
            if (ROOT / name).resolve() == output.resolve() or name.endswith(('validation-results.json', 'IMPLEMENTATION_REPORT.md')): continue
            source_hashes[name] = sha(S3.regular_bytes(ROOT / name))
        except (OSError, ValueError):
            if value != '.gitignore': pending.append('QUALIFIED_SOURCE_HASH_UNAVAILABLE')
    if relation == 'SEALED_CONTAINING_COMMIT' and source_hashes != sealed.get('qualified_source_test_sha256'):
        failures.append('SOURCES_DIFFER_FROM_SEALED_QUALIFICATION')
    notes = []
    for spec in index.get('initial_failure_notes', []):
        row = {'note_sha256': sha(json.dumps(spec, sort_keys=True).encode()), 'classification': 'INITIAL_FAILURE_RETAINED'}
        if isinstance(spec, dict):
            if spec.get('scope') in SCOPES: row['scope'] = spec['scope']
            if type(spec.get('exit_code')) is int: row['exit_code'] = spec['exit_code']
            if spec.get('log'):
                try: row['log_sha256'] = artifact(spec['log'], 'initial-failure')
                except (OSError, ValueError): row['artifact_available'] = False
        notes.append(row)
    status = 'FAIL' if failures else 'PENDING' if pending else 'PASS'
    result = {'stage': 'S4', 'status': status, 'timestamp_utc': dt.datetime.now(dt.timezone.utc).isoformat(), 'branch': branch, 'entry_head': entry, 'execution_head': execution_head, 'final_head': 'SELF', 'sealed_by': 'containing commit', 'repository_identity': {'name': 'ZhiXu', 'branch': branch, 'head_relation': relation}, 'collector': {'private_index_sha256': sha(S3.regular_bytes(index_path)), 'case_identity': 'SHA256 of exact parsed name, deduplicated per stage by chronological listed qualification results', 'arbitrary_private_strings_published': False, 'raw_logs_published': False, 'raw_screenshots_published': False, 'absolute_host_paths_published': False, 'scope_distinctions_preserved': True}, 'suites': rows, 'stage_gates': stages, 'relevant_v9_extra_cases': extras, 's4_file_coverage': {'expected': sorted(all_files), 'covered': sorted(covered & all_files), 'missing': missing}, 'route_coverage': routes, 'checks': checks, 'review_gates': review, 'physical_SIGKILL_gates': crash, 'frozen_inputs': frozen, 'agent_bundles': bundles, 'artifacts': sorted(artifacts.values(), key=lambda a: (a['kind'], a['sha256'])), 'receipts': list(receipts.values()), 'evidence_records': list(proofs.values()), 'qualified_source_test_sha256': source_hashes, 'initial_failure_notes': notes, 'pending_gates': sorted(set(pending)), 'failed_gates': sorted(set(failures)), 'ZHI_XU_V2_S4_PRODUCT_INTEGRATION_PASS': 'YES' if status == 'PASS' else 'NO', 'READY_FOR_S5_REVIEW': 'YES' if status == 'PASS' else 'NO'}
    validate_public(result)
    write_public_output(output, json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return result



def write_public_output(output, text):
    # Report replacement is the only mutation. Never follow an output symlink
    # or modify a hard-linked/device target, and do not leave a partial report.
    if output.is_symlink(): raise ValueError('UNSAFE_OUTPUT')
    if output.exists():
        info = output.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid(): raise ValueError('UNSAFE_OUTPUT')
    descriptor, temporary = tempfile.mkstemp(prefix='.s4-evidence-', dir=output.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(text); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def validate_public(value, key=''):
    """Final boundary rejects host paths/URLs outside explicit logical route fields."""
    if isinstance(value, dict):
        for k, v in value.items(): validate_public(v, k)
    elif isinstance(value, list):
        for v in value: validate_public(v, key)
    elif isinstance(value, str):
        if key == 'path':
            frozen_paths = {r['path'] for r in read_json(ROOT / 'docs/architecture/v2/contracts/api-contracts.json')['routes']}
            if value in frozen_paths or re.fullmatch(r'/(?:api|hooks)/[A-Za-z0-9_/:.*-]+', value): return
        if re.search(r'(?:https?|ssh|file)://', value) or S3.ABSOLUTE.search(value): raise ValueError('PRIVATE_PATH_IN_PUBLIC_REPORT')


def example_index():
    return {'entry_head': git('rev-parse', 'HEAD'), 'execution_head': git('rev-parse', 'HEAD'), 'branch': git('branch', '--show-current'), 'expected_s4_cases': None, 'root_suites': [{'id': 's4-final', 'name': 'Final actual S4 cases', 'stage': 'S4', 'scope': 'http', 'role': 'qualification', 'command': ['node', 'tests/workspace-v2/s4/run.cjs'], 'log': '/tmp/actual-private-log', 'exit_code': None}, {'id': 's1b-initial', 'stage': 'S1B', 'scope': 'cold', 'command': ['node', 'tests/workspace-v2/s1b/run.cjs'], 'log': '/tmp/initial-full-log', 'exit_code': 1}, {'id': 's1b-retry', 'stage': 'S1B', 'scope': 'focused_retry', 'command': ['node', 'tests/workspace-v2/s1b/run.cjs', 'full-disaster.test.cjs'], 'log': '/tmp/focused-retry-log', 'exit_code': 0}], 'checks': [{'id': c, 'command': [], 'log': '/tmp/actual-check-log', 'exit_code': None} for c in sorted(CHECKS)], 'route_coverage': {'file': '/tmp/actual-app-129-coverage.json', 'registered_file': '/tmp/actual-app-registered-routes.json'}, 'review_gates': [{'name': 'Independent implementation audit', 'status': 'PENDING'}], 'evidence_files': ['/tmp/' + name for name in BUNDLES], 'initial_failure_notes': [{'scope': 'cold', 'log': '/tmp/initial-full-log', 'exit_code': 1}]}


def self_test():
    secret = 'DO_NOT_PUBLISH_PRIVATE_SENTINEL'
    projected = safe_facts({'password': secret, secret: True, secret + '_hash': 'a' * 64, 'env': {'value': secret}, 'config': secret, 'stdout': secret, 'status': secret, 'runs': [{'id': 17, 'submission_key': 'event:31', 'status': 'SUCCESS', 'config': secret}], 'events': [{'id': 31, 'task_run_id': 17, 'event_key': 'b' * 64, 'status': 'SUBMITTED'}], 'actual_production_entry': True})
    assert secret not in json.dumps(projected) and projected['runs'][0]['submission_key'] == 'event:31'
    assert projected['events'][0]['task_run_id'] == 17 and projected['actual_production_entry'] is True
    assert safe_facts({'id': True, 'submission_key': 'event:0'}) == {}
    assert secret not in json.dumps(clean_command('PASSWORD=' + secret + ' node tests/workspace-v2/s4/run.cjs --password ' + secret + ' /private/person/secret.json'))
    with tempfile.TemporaryDirectory() as directory:
        p = pathlib.Path(directory); failed = p / 'failed.log'; retry = p / 'retry.log'; badexit = p / 'badexit.log'; skipped = p / 'skip.log'
        failed.write_text('✔ same pass (1ms)\n✖ ' + secret + ' (2ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n')
        retry.write_text('✔ ' + secret + ' (3ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n')
        specs = [{'stage': 'S1B', 'scope': 'cold', 'log': str(failed), 'command': [], 'exit_code': 1}, {'stage': 'S1B', 'scope': 'focused_retry', 'log': str(retry), 'command': [], 'exit_code': 0}]
        rows, latest, _, issues = suite_history(specs, lambda file, kind: sha(pathlib.Path(file).read_bytes()))
        assert not issues and len(latest) == 2 and all(v['eligible'] for v in latest.values())
        assert rows[0]['exit_code'] == 1 and rows[0]['qualification'] == 'SUPERSEDED_BY_LATER_EXACT_CASE_RESULTS'
        assert secret not in json.dumps(public_cases(latest, 'S1B')) and secret not in json.dumps(rows)
        assert rows[0]['case_outcomes'][1]['case_id'] == rows[1]['case_outcomes'][0]['case_id']
        assert rows[0]['case_outcomes'][1]['status'] == 'FAIL' and rows[1]['case_outcomes'][0]['status'] == 'PASS'
        badexit.write_text(retry.read_text()); _, last, _, _ = suite_history([dict(specs[1], log=str(badexit), exit_code=1)], lambda file, kind: '')
        assert not next(iter(last.values()))['eligible']
        skipped.write_text('✔ same pass (1ms)\nℹ tests 1\nℹ pass 0\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\n')
        _, last, _, _ = suite_history([dict(specs[1], log=str(skipped))], lambda file, kind: '')
        assert not next(iter(last.values()))['eligible']
        routes = read_json(ROOT / 'docs/architecture/v2/contracts/api-contracts.json')['routes']
        frozen_rows = [{**row, 'controller': 'SelfTestController', 'service': 'SelfTestDomain', 'status': 'IMPLEMENTED'} for row in routes]
        registered_rows = [{**row, 'path': '/api' + row['path'], 'scope': 'FROZEN_S0'} for row in frozen_rows]
        frozen_file = p / 'routes.json'; registered_file = p / 'registered.json'
        frozen_file.write_text(json.dumps(frozen_rows)); registered_file.write_text(json.dumps(registered_rows))
        route_spec = {'file': str(frozen_file), 'registered_file': str(registered_file)}
        assert route_gate(route_spec, lambda file, kind: sha(pathlib.Path(file).read_bytes()))[0]['passed']
        registered_rows.append({**registered_rows[0], 'path': '/api/subscriptions'})
        registered_file.write_text(json.dumps(registered_rows))
        assert not route_gate(route_spec, lambda file, kind: '')[0]['passed']
        frozen_rows[0]['service'] = 'EXPLICIT_V2_SERVICE'
        frozen_file.write_text(json.dumps(frozen_rows))
        assert not route_gate(route_spec, lambda file, kind: '')[0]['passed']
        link = p / 'link'; link.symlink_to(failed)
        try: S3.regular_bytes(link); raise AssertionError('symlink read accepted')
        except OSError: pass
    validate_public({'route_coverage': {'path': '/api/tasks/:id'}, 'source': 'tests/workspace-v2/s4/run.cjs'})
    try: validate_public({'message': '/Users/person/secret'}); raise AssertionError('private path accepted')
    except ValueError: pass
    try: validate_public({'path': '/Users/person/secret'}); raise AssertionError('private path disguised as HTTP path accepted')
    except ValueError: pass
    synthetic = {(stage, 'case-' + str(i)): {'status': 'PASS', 'eligible': True, 'suite_id': 'self-test'} for stage, count in {**EXPECTED, 'S4': 2}.items() for i in range(count)}
    assert all(g['passed'] for g in evaluate_case_gates(synthetic, 2).values())
    synthetic[('S2', 'case-0')]['eligible'] = False
    assert not evaluate_case_gates(synthetic, 2)['S2']['passed']
    synthetic[('S2', 'case-0')]['eligible'] = True
    del synthetic[('S1B', 'case-0')]
    assert not evaluate_case_gates(synthetic, 2)['S1B']['passed']
    synthetic[('S3', 'unexpected-extra-case')] = {'status': 'PASS', 'eligible': True, 'suite_id': 'self-test'}
    assert not evaluate_case_gates(synthetic, 2)['S3']['passed']
    assert len(EXPECTED) == 5 and EXPECTED == {'S1A': 68, 'S2': 112, 'S1B': 36, 'S3': 81, 'V9': 210}
    print(json.dumps({'collector_self_test': 'PASS', 'private_field_and_command_projection': 'PASS', 'exact_case_retry_preserves_failed_exit': 'PASS', 'unexplained_exit_and_skip_fail_closed': 'PASS', 'symlink_rejected': 'PASS', 'exact_raw_case_identity': 'PASS', 'concrete_129_route_mapping': 'PASS', 'mandatory_regression_counts': EXPECTED}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--index', type=pathlib.Path); parser.add_argument('--output', type=pathlib.Path)
    parser.add_argument('--self-test', action='store_true'); parser.add_argument('--example-index', action='store_true')
    args = parser.parse_args()
    if args.self_test: self_test(); return 0
    if args.example_index: print(json.dumps(example_index(), indent=2)); return 0
    if not args.index or not args.output: parser.error('--index and --output are required')
    if args.output.is_symlink(): parser.error('output leaf must not be a symlink')
    output = args.output.resolve()
    if not (output.is_relative_to(ROOT) or output.is_relative_to(pathlib.Path('/tmp').resolve())): parser.error('output must be repository or private temporary path')
    try: result = collect_s4_results(read_json(args.index), args.index, output)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, subprocess.SubprocessError):
        failed = {'stage': 'S4', 'status': 'FAIL', 'sealed_by': 'containing commit', 'final_head': 'SELF', 'failed_gates': ['INVALID_OR_UNAVAILABLE_QUALIFICATION_INPUT'], 'ZHI_XU_V2_S4_PRODUCT_INTEGRATION_PASS': 'NO', 'READY_FOR_S5_REVIEW': 'NO'}
        try: write_public_output(output, json.dumps(failed, indent=2) + '\n')
        except (OSError, ValueError): pass
        print(json.dumps({'collector': 'FAIL', 'error_code': 'INVALID_OR_UNAVAILABLE_QUALIFICATION_INPUT'})); return 1
    print(json.dumps({'collector': result['status'], 'S4_unique_cases': result['stage_gates']['S4']['tests'], 'pending_gates': len(result['pending_gates']), 'failed_gates': len(result['failed_gates'])}))
    return {'PASS': 0, 'FAIL': 1, 'PENDING': 2}[result['status']]


if __name__ == '__main__': raise SystemExit(main())
