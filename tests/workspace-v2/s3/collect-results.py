#!/usr/bin/env python3
"""Collect private S3 receipts into a public, hash-addressed qualification report.

No raw log, assertion payload, environment assignment, Config content, credential,
or host absolute path is copied. Missing evidence produces PENDING, never PASS.
Exit codes: 0 PASS, 1 FAIL, 2 PENDING. --self-test does not require private inputs.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import shlex
import stat
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[3]
DEFAULT_EVIDENCE = [pathlib.Path('/tmp/s3-' + name + '-evidence.json') for name in
                    ('git', 'outbox', 'discovery-scheduler')]
EXPECTED_REGRESSIONS = {'S1A': 68, 'S2': 112, 'S1B': 36, 'V9': 210}
GITIGNORE_SHA = '78f778aa7cc3494334676046b883b672c9e98f3fb28adfd3868b9aa99aef4893'
SYNC_POINTS = ('BEFORE_FETCH', 'AFTER_FETCH', 'BEFORE_FF_APPLY',
               'AFTER_PHYSICAL_HEAD_CHANGED', 'BEFORE_DISCOVERY', 'DURING_DISCOVERY',
               'AFTER_DISCOVERY', 'BEFORE_DB_SUCCESS_COMMIT', 'AFTER_DB_COMMIT')
OUTBOX_POINTS = ('BEFORE_OUTBOX_DISPATCH', 'AFTER_TASK_RUN_INSERT', 'BEFORE_OUTBOX_ACK')
HEX = re.compile(r'^[a-f0-9]{64}$')
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
ABSOLUTE = re.compile(r'(?<![A-Za-z0-9])(?:file://)?/[^\s\]\[()<>"\']*')
SAFE_CODE = re.compile(r'^[A-Z][A-Z0-9_]{0,100}$')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular_bytes(path, max_bytes=64 * 1024 * 1024):
    """Never follow a leaf symlink or read a device while collecting artifacts."""
    path = pathlib.Path(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(fd, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
            raise ValueError('UNSAFE_OR_OVERSIZED_ARTIFACT')
        return handle.read()


def read_json(path):
    return json.loads(regular_bytes(path, 16 * 1024 * 1024))


def repo_path(value):
    """Only canonical relative names, never an arbitrary path from private JSON."""
    name = str(value)
    candidate = pathlib.PurePosixPath(name)
    if candidate.is_absolute() or '..' in candidate.parts or not candidate.parts:
        raise ValueError('NON_REPOSITORY_INPUT')
    resolved = (ROOT / candidate).resolve()
    if not resolved.is_relative_to(ROOT) or (ROOT / candidate).is_symlink():
        raise ValueError('NON_REPOSITORY_INPUT')
    return candidate.as_posix()


def reference(path):
    """Basename is useful to the operator; no private ancestry is published."""
    return pathlib.Path(path).name


def clean_text(value):
    value = ANSI.sub('', str(value))
    value = ABSOLUTE.sub('<owned-test-path>', value)
    value = re.sub(r'(?:https?|ssh|file)://\S+', '<private-location>', value)
    value = re.sub(r'\b[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|\'[^\']*\'|\S+)', 'ENV=<private>', value)
    return value[:1000]


def clean_command(command):
    parts = command if isinstance(command, list) else shlex.split(str(command))
    cleaned = []
    for part in map(str, parts):
        if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', part):
            cleaned.append(part.split('=', 1)[0] + '=<private>')
        elif pathlib.Path(part).is_absolute():
            try:
                relative = pathlib.Path(part).relative_to(ROOT).as_posix()
                cleaned.append(relative if relative.startswith(('tests/', 'back/', 'docs/', 'scripts/')) else '<owned-test-path>')
            except ValueError:
                cleaned.append(pathlib.Path(part).name if pathlib.Path(part).name in ('node', 'python3', 'python', 'tsc', 'pnpm', 'git') else '<owned-test-path>')
        else:
            cleaned.append(clean_text(part))
    return cleaned


def parse_log(text):
    text = ANSI.sub('', text)
    summaries, current, cases = [], None, []
    for line in text.splitlines():
        match = re.match(r'^\s*(?:ℹ|#)?\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+([\d.]+)\s*$', line)
        if match:
            key, raw = match.groups()
            if key == 'tests':
                current = {}
                summaries.append(current)
            if current is not None:
                current[key] = float(raw) if key == 'duration_ms' else int(raw)
            continue
        match = re.match(r'^\s*([✔✖])\s+(.+?)\s+\(([\d.]+)ms\)\s*$', line)
        if match:
            mark, name, duration = match.groups()
            cases.append({'name': clean_text(name), 'status': 'PASS' if mark == '✔' else 'FAIL', 'duration_ms': float(duration)})
            continue
        match = re.match(r'^\s*(not ok|ok)\s+\d+\s+-\s+(.+?)(?:\s+#\s+(SKIP|TODO).*)?$', line)
        if match:
            mark, name, skipped = match.groups()
            cases.append({'name': clean_text(name), 'status': 'SKIPPED' if skipped else 'PASS' if mark == 'ok' else 'FAIL'})
    totals = {key: sum(item.get(key, 0) for item in summaries) for key in
              ('tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms')}
    return totals if summaries else None, cases


def owned_run(root):
    root = pathlib.Path(root)
    info = root.lstat()
    if root.resolve() != root or not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise ValueError('UNOWNED_RECEIPT_ROOT')
    marker = read_json(root / '.s1b-run-owner.json')
    if marker.get('version') != 1 or marker.get('root') != str(root) or marker.get('dev') != info.st_dev or marker.get('ino') != info.st_ino:
        raise ValueError('UNOWNED_RECEIPT_ROOT')
    return root


def safe_facts(record, depth=0):
    """Deliberate allowlist: arbitrary strings and nested snapshots are omitted."""
    if depth > 8:
        return {}
    facts = {}
    for key, value in record.items():
        if key in ('case_id', 'checkpoint') and isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,160}', value):
            facts[key] = value
        elif key in ('status', 'phase', 'error_code', 'result_code', 'rejection', 'killed_signal', 'signal', 'recovered_status', 'workspace_state', 'lifecycle_state', 'discovery_status', 'git_update_status', 'event_status', 'sync_status', 'outbox_status'):
            if value is None or isinstance(value, str) and SAFE_CODE.fullmatch(value):
                facts[key] = value
        elif key == 'id':
            if type(value) is int and value > 0:
                facts[key] = value
        elif key == 'submission_key':
            if isinstance(value, str) and re.fullmatch(r'event:[1-9][0-9]*', value):
                facts[key] = value
        elif key == 'event_key':
            if isinstance(value, str) and HEX.fullmatch(value):
                facts[key] = value
        elif key in ('runs', 'events') and isinstance(value, list):
            facts[key] = [safe_facts(item, depth + 1) for item in value[:10000] if isinstance(item, dict)]
            if len(value) > 10000:
                facts[key + '_truncated'] = True
        elif isinstance(value, bool):
            facts[key] = value
        elif isinstance(value, (int, float)) and re.fullmatch(r'(?:.*_(?:id|ids|count|counts|bytes|ms|pid|pids|version|revision|generation|exit_code)|attempts|controllers|outboxes|taskRuns|tests|pass|fail)', key):
            facts[key] = value
        elif isinstance(value, str) and re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', value) and re.search(r'commit|sha256|hash', key):
            facts[key] = value
        elif key == 'actual' and isinstance(value, dict):
            nested = safe_facts(value, depth + 1)
            if nested:
                facts[key] = nested
    return facts


def command_files(command):
    parts = command if isinstance(command, list) else shlex.split(str(command))
    files = set()
    for part in map(str, parts):
        if part.endswith('.test.cjs'):
            name = pathlib.Path(part).name
            local = ROOT / 'tests/workspace-v2/s3' / name
            if local.is_file():
                files.add(local.relative_to(ROOT).as_posix())
    if any('--test-name-pattern' in str(part) or '--test-skip-pattern' in str(part) for part in parts):
        return set()
    return files


def physical_git_record(record, mode):
    """Older in-process recovery records cannot prove this physical gate."""
    controller = record.get('controller_pid')
    recovery = record.get('recovery_controller_pid')
    return (record.get('case_id') == 'S3-INFLIGHT-' + mode
            and record.get('actual_inflight') is True
            and bool(record.get('live_git_pids'))
            and record.get('killed_signal') == 'SIGKILL'
            and type(record.get('recovery_exit_code')) is int
            and record['recovery_exit_code'] == 0
            and type(controller) is int and controller > 0
            and type(recovery) is int and recovery > 0
            and controller != recovery)


def verify_hashes(mapping):
    verified, mismatches = {}, []
    for value, expected in sorted(mapping.items()):
        try:
            name = repo_path(value)
            if not isinstance(expected, str) or not HEX.fullmatch(expected):
                raise ValueError('INVALID_EXPECTED_HASH')
            actual = sha(regular_bytes(ROOT / name))
            verified[name] = actual
            if actual != expected:
                mismatches.append(name)
        except (OSError, ValueError):
            mismatches.append(clean_text(value))
    return {'verified': len(mapping) - len(mismatches), 'expected': len(mapping), 'mismatches': mismatches, 'sha256': verified}


def historical_blob_hash(name, baseline):
    result = subprocess.run(['git', 'show', baseline + ':' + name], cwd=ROOT, capture_output=True, check=False)
    return sha(result.stdout) if result.returncode == 0 else None


def collect_results(index, index_path, output):
    pending, failures, suites, artifacts, receipts = [], [], [], {}, {}
    raw_records, evidence_records, evidence_files = {}, {}, []
    latest_cases, covered = {}, set()
    paths = [pathlib.Path(value) for value in index.get('evidence_files', DEFAULT_EVIDENCE)]
    branch = subprocess.run(['git', 'branch', '--show-current'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    entry = index.get('entry_head')
    head_relation = 'ENTRY_HEAD'
    if not isinstance(entry, str) or not re.fullmatch(r'[a-f0-9]{40}', entry):
        pending.append('Explicit forty-character entry_head is required')
        head_relation = 'ENTRY_HEAD_UNSPECIFIED'
    elif head != entry:
        parent = subprocess.run(['git', 'rev-parse', 'HEAD^'], cwd=ROOT, capture_output=True, text=True, check=False).stdout.strip()
        report_name = repo_path(index.get('report_path', 'tests/workspace-v2/s3-validation-results.json'))
        committed = subprocess.run(['git', 'show', 'HEAD:' + report_name], cwd=ROOT, capture_output=True, check=False)
        sealed = json.loads(committed.stdout) if committed.returncode == 0 else {}
        if parent == entry and sealed.get('final_head') == 'SELF' and sealed.get('sealed_by') == 'containing commit':
            head_relation = 'CONTAINING_COMMIT_PARENT_IS_ENTRY'
        else:
            head_relation = 'UNEXPECTED_HEAD'
            failures.append('Current HEAD is neither entry_head nor its sealed containing commit')
    if not branch or index.get('branch', branch) != branch:
        failures.append('Repository branch identity does not match the private index')

    def artifact(path, kind):
        data = regular_bytes(path)
        digest = sha(data)
        key = kind + ':' + digest
        artifacts[key] = {'kind': kind, 'name': reference(path), 'sha256': digest, 'bytes': len(data)}
        return digest

    def records_from_root(root):
        try:
            root = owned_run(root)
            receipt = root / 'qualification-result.json'
            if receipt.is_file():
                data = read_json(receipt)
                digest = artifact(receipt, 'receipt')
                receipts[digest] = {'name': receipt.name, 'sha256': digest, **{k: data[k] for k in ('exit_code', 'signal', 'duration_ms', 'sampled_peak_process_tree_rss_bytes', 'sample_count') if k in data}}
            for file in sorted(root.glob('*/evidence/*.json')):
                if file.is_symlink() or file.parent.is_symlink() or file.parent.parent.is_symlink():
                    continue
                record = read_json(file)
                if not isinstance(record, dict):
                    continue
                digest = artifact(file, 'evidence')
                raw_records[digest] = record
                evidence_records[digest] = {'name': file.name, 'sha256': digest, 'facts': safe_facts(record)}
        except (OSError, ValueError, json.JSONDecodeError):
            pending.append('Retained proof unavailable: ' + reference(root))

    def ingest(spec, default_stage='S3'):
        log = spec.get('log') or spec.get('log_path')
        if not log:
            pending.append('Suite has no log: ' + clean_text(spec.get('name', spec.get('phase', 'unnamed'))))
            return
        try:
            data = regular_bytes(log)
        except (OSError, ValueError):
            pending.append('Missing suite log: ' + reference(log))
            return
        text = data.decode('utf-8', errors='replace')
        summary, cases = parse_log(text)
        stage = str(spec.get('stage', default_stage)).upper().replace('.', '').replace('_', '')
        stage = {'S1A': 'S1A', 'S1B': 'S1B', 'V9': 'V9', 'S2': 'S2', 'S3': 'S3'}.get(stage, stage)
        command = spec.get('command', [])
        files = command_files(command)
        source_hash = sha(data)
        if spec.get('log_sha256') and spec['log_sha256'] != source_hash:
            failures.append('Log hash mismatch: ' + reference(log))
        artifact(log, 'log')
        row = {'name': clean_text(spec.get('name', spec.get('phase', reference(log)))), 'stage': stage,
               'command': clean_command(command), 'log': reference(log), 'log_sha256': source_hash,
               'exit_code': spec.get('exit_code'), 'summary': summary, 'case_count': len(cases), 'test_files': sorted(files)}
        suites.append(row)
        if not summary:
            pending.append('Node summary missing: ' + reference(log))
        if stage == 'S3':
            for case in cases:
                latest_cases[case['name']] = {**case, 'log': reference(log), 'log_sha256': source_hash}
            if summary and summary['fail'] == summary['cancelled'] == summary['skipped'] == summary['todo'] == 0 and summary['tests'] == summary['pass'] and spec.get('exit_code', 0) == 0:
                covered.update(files)
            # Earlier multi-file runs may include a now-requalified failed case.
            row['_case_names'] = [case['name'] for case in cases]
        elif stage in EXPECTED_REGRESSIONS:
            if spec.get('exit_code') != 0 or not summary or any(summary.get(k, 0) for k in ('fail', 'cancelled', 'skipped', 'todo')):
                failures.append('Regression suite failed/incomplete: ' + reference(log))
        for match in re.finditer(r'^S1B retained sandbox: (.+)$', text, re.M):
            records_from_root(match.group(1).strip())
        root = spec.get('retained_root')
        if root:
            records_from_root(root)

    for path in paths:
        if not path.is_file():
            pending.append('Private evidence bundle missing: ' + path.name)
            continue
        bundle = read_json(path)
        evidence_files.append({'name': path.name, 'sha256': artifact(path, 'private-index')})
        for spec in bundle.get('phases', bundle.get('suites', [])):
            default_stage = 'S3' if 's3/run.cjs' in str(spec.get('command', '')) else 'SHARED_REGRESSION'
            ingest(spec, default_stage)
        # Outbox receipts deliberately distinguish the complete run from
        # affected-case hardening and a later independent crash supplement.
        for key in ('final_combined', 'post_hardening', 'latest_crash_supplemental', 'cleanup_race'):
            if isinstance(bundle.get(key), dict):
                spec = {'name': 'Outbox ' + key, 'stage': 'S3', **bundle[key]}
                if not spec.get('log') and spec.get('retained_root'):
                    spec['log'] = str(pathlib.Path(spec['retained_root']) / 'logs/qualification.log')
                if not spec.get('command') and isinstance(spec.get('receipt_data'), dict):
                    spec['command'] = spec['receipt_data'].get('command', [])
                ingest(spec)
    for spec in index.get('root_suites', []):
        ingest(spec)

    for row in suites:
        names = row.pop('_case_names', [])
        if (row['stage'] == 'S3' and names and row['summary']
                and row['summary']['tests'] == len(names)
                and all(latest_cases.get(name, {}).get('status') == 'PASS' for name in names)):
            covered.update(row['test_files'])
        row['qualification'] = ('SUPERSEDED_BY_LATER_CASE_RESULTS' if row['summary'] and row['summary']['fail'] and names and all(latest_cases.get(name, {}).get('status') == 'PASS' for name in names)
                                else 'COMPLETE' if row['summary'] and not any(row['summary'].get(key, 0) for key in ('fail', 'cancelled', 'todo'))
                                else 'INCOMPLETE_OR_FAILED')
    all_files = {path.relative_to(ROOT).as_posix() for path in (ROOT / 'tests/workspace-v2/s3').glob('*.test.cjs')}
    missing_files = sorted(all_files - covered)
    if missing_files:
        pending.append('S3 test files lack completed passing coverage: ' + ', '.join(missing_files))
    bad_cases = [name for name, case in latest_cases.items() if case['status'] != 'PASS']
    if bad_cases:
        failures.append('Latest S3 cases failed/skipped: ' + ', '.join(bad_cases))
    if not latest_cases:
        pending.append('No individual S3 cases parsed')

    regression = {}
    for stage, expected in EXPECTED_REGRESSIONS.items():
        selected = [row for row in suites if row['stage'] == stage]
        # Index supplies the authoritative final regression run(s), not agent focused repeats.
        totals = {key: sum((row['summary'] or {}).get(key, 0) for row in selected) for key in ('tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo')}
        regression[stage] = {'expected': expected, **totals, 'passed': totals['tests'] == expected and totals['pass'] == expected and not any(totals[k] for k in ('fail', 'skipped', 'cancelled', 'todo'))}
        if not regression[stage]['passed']:
            pending.append(stage + ' exact regression gate not met')

    crash = {}
    records = list(raw_records.values())
    for point in SYNC_POINTS:
        case_ok = any(case['status'] == 'PASS' and ('S3-CRASH ' + point + ' actual SIGKILL') in name for name, case in latest_cases.items())
        record_ok = any(r.get('case_id') == 'S3-CRASH-' + point and r.get('killed_signal') == 'SIGKILL' and r.get('independent_recovery') is True for r in records)
        crash[point] = {'case_passed': case_ok, 'physical_record': record_ok, 'passed': case_ok and record_ok}
    for point in OUTBOX_POINTS:
        case_ok = any(case['status'] == 'PASS' and ('dispatcher SIGKILL ' + point + ' ') in name for name, case in latest_cases.items())
        def outbox_record(r):
            actual = r.get('actual', {})
            return r.get('case_id') == 'outbox-kill-' + point.lower() and isinstance(actual, dict) and actual.get('killed_signal') == 'SIGKILL' and actual.get('initial_worker_pid') != actual.get('recovery_worker_pid') and actual.get('actual_effect_count') == 1
        record_ok = any(outbox_record(r) for r in records)
        crash[point] = {'case_passed': case_ok, 'physical_record': record_ok, 'passed': case_ok and record_ok}
    for mode in ('FETCH', 'CHECKOUT'):
        case_ok = any(case['status'] == 'PASS' and ('Sync SIGKILL during actual ' + mode + ' ') in name for name, case in latest_cases.items())
        record_ok = any(physical_git_record(r, mode) for r in records)
        crash['DURING_' + mode] = {'case_passed': case_ok, 'physical_record': record_ok, 'passed': case_ok and record_ok}
    if not all(item['passed'] for item in crash.values()):
        pending.append('Required fourteen physical SIGKILL checkpoints incomplete')

    s2 = read_json(ROOT / 'tests/workspace-v2/s2-validation-results.json')
    s1b = read_json(ROOT / 'tests/workspace-v2/s1b-validation-results.json')
    frozen_map = s2['frozen_s0_sha256']
    if len(frozen_map) != 37:
        failures.append('Frozen S0 baseline must contain exactly 37 inputs')
    frozen = verify_hashes(frozen_map)
    history_map = {**s2.get('historical_s1a_sha256', {}), **s1b.get('frozen_inputs', {}).get('historical', {})}
    baseline = index.get('entry_head', 'HEAD')
    if not re.fullmatch(r'(?:[a-f0-9]{40}|HEAD)', baseline):
        raise ValueError('INVALID_BASELINE')
    for name in ('docs/architecture/v2/S1B_QUALIFICATION_REPORT.md', 'tests/workspace-v2/s1b-validation-results.json'):
        expected = historical_blob_hash(name, baseline)
        if expected:
            history_map[name] = expected
        else:
            pending.append('Missing committed historical baseline: ' + name)
    extra = index.get('frozen', {})
    if isinstance(extra, str):
        extra = read_json(extra)
    if isinstance(extra, dict):
        history_map.update(extra.get('historical', {}))
    historical = verify_hashes(history_map)
    ignore_expected = index.get('gitignore_expected_sha256', extra.get('gitignore_expected_sha256', GITIGNORE_SHA) if isinstance(extra, dict) else GITIGNORE_SHA)
    gitignore = verify_hashes({'.gitignore': ignore_expected})
    if frozen['mismatches'] or historical['mismatches'] or gitignore['mismatches']:
        failures.append('Frozen/historical/user .gitignore bytes changed')

    checks = []
    for check in index.get('checks', []):
        row = {'name': clean_text(check['name']), 'command': clean_command(check.get('command', [])), 'exit_code': check.get('exit_code')}
        try:
            row.update(log=reference(check['log']), log_sha256=artifact(check['log'], 'check'))
        except (OSError, ValueError, KeyError):
            pending.append('Missing check log: ' + row['name'])
        if check.get('exit_code') != 0:
            failures.append('Required check did not pass: ' + row['name'])
        checks.append(row)
    if not checks:
        pending.append('Root verification checks missing')

    review_gates = {}
    review_input = index.get('review_gates', {'independent_audit': 'PENDING'})
    if isinstance(review_input, list):
        review_input = {item['name']: item for item in review_input if isinstance(item, dict) and isinstance(item.get('name'), str)}
    if not isinstance(review_input, dict):
        raise ValueError('INVALID_REVIEW_GATES')
    for name, value in review_input.items():
        raw_status = value.get('status') if isinstance(value, dict) else value
        status = str(raw_status).upper()
        status = 'PASS' if status in ('PASS', 'YES', 'COMPLETE', 'COMPLETED', 'TRUE') else 'FAIL' if status in ('FAIL', 'FAILED', 'BLOCKED') else 'PENDING'
        review_gates[clean_text(name)] = status
        if status == 'FAIL':
            failures.append('Review gate failed: ' + clean_text(name))
        elif status != 'PASS':
            pending.append('Review gate incomplete: ' + clean_text(name))
    if not review_gates:
        pending.append('Independent review gate has not been recorded')

    failure_notes = []
    for note in index.get('initial_failure_notes', []):
        if not isinstance(note, dict):
            continue
        projection = {'reason': clean_text(note.get('reason', 'Initial run was superseded by the listed qualification evidence')),
                      'private_note_sha256': sha(json.dumps(note, sort_keys=True).encode())}
        if note.get('log'):
            projection['log'] = reference(note['log'])
            try:
                projection['log_sha256'] = artifact(note['log'], 'initial-run-log')
            except (OSError, ValueError):
                projection['log_available'] = False
        failure_notes.append(projection)

    source_paths = set(index.get('source_paths', []))
    source_paths.update(path.relative_to(ROOT).as_posix() for directory in ('back/services/gitWorkspaceV2', 'tests/workspace-v2/s3') for path in (ROOT / directory).rglob('*') if path.is_file() and path.suffix in ('.ts', '.cjs', '.py'))
    changed = subprocess.run(['git', 'diff', '--name-only', 'HEAD'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.splitlines()
    source_paths.update(name for name in changed if name.startswith(('back/', 'tests/')) and pathlib.Path(name).suffix in ('.ts', '.cjs', '.py'))
    source_paths.update(name for name in ('back/services/taskExecutionV2/gitUpdateAdmission.ts',) if (ROOT / name).is_file())
    source_hashes = {}
    for value in sorted(source_paths):
        name = repo_path(value)
        if (ROOT / name).resolve() == output.resolve() or (ROOT / name).name.endswith('validation-results.json'):
            continue
        source_hashes[name] = sha(regular_bytes(ROOT / name))

    status = 'FAIL' if failures else 'PENDING' if pending else 'PASS'
    result = {
        'stage': 'S3', 'status': status, 'timestamp_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
        'branch': clean_text(branch), 'entry_head': entry,
        'repository_identity': {'name': 'ZhiXu', 'branch': clean_text(branch), 'head_relation': head_relation},
        'sealed_by': 'containing commit', 'final_head': 'SELF',
        'collector': {'private_index_sha256': sha(regular_bytes(index_path)), 'raw_logs_published': False, 'absolute_host_paths_published': False, 'arbitrary_record_strings_published': False, 'case_deduplication': 'latest listed outcome per exact S3 case name; root suites follow agent focused evidence'},
        'checks': checks, 'suites': suites, 'review_gates': review_gates,
        'initial_failure_notes': failure_notes,
        'S3_unique_tests': {'tests': len(latest_cases), 'pass': sum(c['status'] == 'PASS' for c in latest_cases.values()), 'fail_or_skip': len(bad_cases), 'cases': [latest_cases[name] for name in sorted(latest_cases)]},
        'regression_gates': regression, 'S3_file_coverage': {'expected_files': sorted(all_files), 'covered_files': sorted(covered & all_files), 'missing_files': missing_files},
        'physical_SIGKILL_gates': {'required': 14, 'passed': sum(item['passed'] for item in crash.values()), 'checkpoints': crash},
        'frozen_inputs': {'frozen_s0': frozen, 'historical': historical, 'user_gitignore': gitignore},
        'private_evidence_bundles': evidence_files, 'artifacts': sorted(artifacts.values(), key=lambda item: (item['kind'], item['name'], item['sha256'])),
        'receipts': list(receipts.values()), 'evidence_records': sorted(evidence_records.values(), key=lambda item: (item['name'], item['sha256'])),
        'qualified_source_test_sha256': source_hashes,
        'pending_gates': sorted(set(pending)), 'failed_gates': sorted(set(failures)),
        'qualification_limits': ['Focused suites may precede later integration hardening; root-listed final runs take precedence per case.', 'Source and test hashes exclude this report output; the containing commit seals the report.', 'Private receipts and records remain in owned retained sandboxes; only hashes and allowlisted facts are public.'],
        'ZHI_XU_V2_S3_GIT_WORKSPACE_CONVERGENCE_PASS': 'YES' if status == 'PASS' else 'NO',
        'READY_FOR_S4_REVIEW': 'YES' if status == 'PASS' else 'NO',
    }
    serialized = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    # Last boundary check protects future edits to the structured projections.
    if ABSOLUTE.search(serialized) or re.search(r'(?:file|ssh|https?)://', serialized):
        raise ValueError('PRIVATE_PATH_OR_URL_IN_PUBLIC_REPORT')
    output.write_text(serialized)
    return result


def self_test():
    summary, cases = parse_log('✔ same case (1ms)\n✖ same case (2ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1\nℹ skipped 0\n')
    assert summary['tests'] == 2 and cases[-1]['status'] == 'FAIL'
    assert len({case['name']: case for case in cases}) == 1
    secret = 'DO_NOT_PUBLISH_FIXTURE_SECRET'
    facts = safe_facts({'case_id': 'S3-PRIVATE', 'env': secret, 'config': secret, 'snapshot': {'value': secret}, 'actual': {'stdout': secret, 'attempt_count': 1}, 'status': 'PASS'})
    assert secret not in json.dumps(facts) and facts['actual']['attempt_count'] == 1
    identities = safe_facts({'discovery_status': 'SUCCESS', 'git_update_status': 'APPLIED', 'event_status': 'DISPATCHED', 'sync_status': 'SUCCESS', 'runs': [{'id': 31, 'status': 'SUCCESS', 'submission_key': 'event:17', 'expected_git_commit': 'a' * 40, 'env': secret, 'config': secret}], 'events': [{'id': 17, 'task_run_id': 31, 'event_key': 'b' * 64, 'status': 'SUBMITTED', 'config': {'content': secret}}]})
    assert identities['runs'][0]['id'] == 31 and identities['runs'][0]['submission_key'] == 'event:17'
    assert identities['runs'][0]['expected_git_commit'] == 'a' * 40
    assert identities['events'][0]['id'] == 17 and identities['events'][0]['task_run_id'] == 31 and identities['events'][0]['event_key'] == 'b' * 64
    assert identities['discovery_status'] == 'SUCCESS' and secret not in json.dumps(identities)
    assert safe_facts({'id': True, 'submission_key': secret, 'event_key': secret}) == {}
    assert safe_facts({'submission_key': 'event:0'}) == {}
    bounded = safe_facts({'runs': [{'id': 1}] * 10001})
    assert len(bounded['runs']) == 10000 and bounded['runs_truncated'] is True
    command = clean_command('SECRET=' + secret + ' node tests/workspace-v2/s3/run.cjs /private/test/receipt.json')
    assert secret not in json.dumps(command) and '/private/' not in json.dumps(command)
    assert clean_text('/Users/private-person/test') == '<owned-test-path>'
    old = {'case_id': 'S3-INFLIGHT-FETCH', 'actual_inflight': True, 'live_git_pids': [102], 'controller_pid': 101}
    assert not physical_git_record(old, 'FETCH')
    fresh = {**old, 'killed_signal': 'SIGKILL', 'recovery_exit_code': 0, 'recovery_controller_pid': 103}
    assert physical_git_record(fresh, 'FETCH')
    assert not physical_git_record({**fresh, 'recovery_controller_pid': 101}, 'FETCH')
    assert not physical_git_record({**fresh, 'recovery_exit_code': 1}, 'FETCH')
    assert not physical_git_record({**fresh, 'killed_signal': 'SIGTERM'}, 'FETCH')
    print(json.dumps({'collector_self_test': 'PASS', 'privacy_projection': 'PASS', 'duplicate_case_handling': 'PASS', 'physical_git_fresh_recovery': 'PASS', 'bounded_event_run_identities': 'PASS'}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--index', type=pathlib.Path)
    parser.add_argument('--output', type=pathlib.Path)
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if not args.index or not args.output:
        parser.error('--index and --output are required')
    output = args.output.resolve()
    if not output.is_relative_to(ROOT) and not output.is_relative_to(pathlib.Path('/tmp').resolve()):
        parser.error('output must be inside the repository or the private temporary directory')
    try:
        result = collect_results(read_json(args.index), args.index, output)
    except (OSError, ValueError, KeyError, json.JSONDecodeError, subprocess.SubprocessError):
        print(json.dumps({'collector': 'FAIL', 'error_code': 'INVALID_OR_UNAVAILABLE_QUALIFICATION_INPUT'}))
        return 1
    print(json.dumps({'collector': result['status'], 'S3_unique_tests': result['S3_unique_tests']['tests'], 'pending_gates': len(result['pending_gates']), 'failed_gates': len(result['failed_gates'])}))
    return {'PASS': 0, 'FAIL': 1, 'PENDING': 2}[result['status']]


if __name__ == '__main__':
    raise SystemExit(main())
