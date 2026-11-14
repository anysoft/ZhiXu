#!/usr/bin/env python3
"""Build two independent source exports with pinned dependencies in an owned domain.

No existing checkout output, user configuration or node_modules is a build input.
Failures and both full manifests are retained. This does not publish anything.
"""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import shutil
import stat
import subprocess
import tarfile
import time


def s5_run_command(command, directory, environment, log, journal):
    started = time.time()
    with log.open('wb') as output:
        result = subprocess.run(command, cwd=directory, env=environment,
                                stdout=output, stderr=subprocess.STDOUT)
    row = {'command': command, 'exit_code': result.returncode,
           'duration_ms': round((time.time() - started) * 1000, 3),
           'log': str(log), 'log_sha256': hashlib.sha256(log.read_bytes()).hexdigest()}
    with journal.open('a') as stream:
        stream.write(json.dumps(row) + '\n')
    if result.returncode:
        raise RuntimeError('S5_BUILD_COMMAND_FAILED')
    return row


def s5_asset_manifest(directory):
    rows = []
    for current, directories, names in os.walk(directory, followlinks=False):
        directories.sort()
        for name in directories:
            if (pathlib.Path(current) / name).is_symlink():
                raise ValueError('S5_OUTPUT_SYMLINK')
        for name in sorted(names):
            file = pathlib.Path(current) / name
            info = file.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError('S5_OUTPUT_NOT_REGULAR')
            data = file.read_bytes()
            rows.append({'path': file.relative_to(directory).as_posix(),
                         'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    # Matches the JS fixture: depth-first traversal, all entries in one sorted order.
    rows.sort(key=lambda item: tuple(item['path'].split('/')))
    encoded = json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()
    return {'files': rows, 'file_count': len(rows), 'bytes': sum(r['bytes'] for r in rows),
            'sha256': hashlib.sha256(encoded).hexdigest()}


def s5_build_candidate(args, name, context):
    root, repo = pathlib.Path(context['root']), pathlib.Path(args.repository).resolve()
    target = root / name
    target.mkdir(mode=0o700)
    source = target / 'source'
    source.mkdir(mode=0o700)
    archive = target / 'source.tar'
    with archive.open('wb') as stream:
        subprocess.run(['git', 'archive', '--format=tar', args.commit], cwd=repo,
                       stdout=stream, check=True)
    with tarfile.open(archive) as reader:
        for member in reader:
            relative = pathlib.PurePosixPath(member.name)
            if relative.is_absolute() or '..' in relative.parts or not (member.isfile() or member.isdir()):
                raise ValueError('S5_SOURCE_ARCHIVE_UNSAFE')
            file = source.joinpath(*relative.parts)
            if member.isdir():
                file.mkdir(parents=True, exist_ok=True)
            else:
                file.parent.mkdir(parents=True, exist_ok=True)
                with reader.extractfile(member) as src, file.open('xb') as dest:
                    shutil.copyfileobj(src, dest)
                file.chmod(member.mode & 0o777)
    home, temporary = target / 'home', target / 'tmp'
    home.mkdir(mode=0o700)
    temporary.mkdir(mode=0o700)
    environment = {'PATH': str(pathlib.Path(args.node).resolve().parent) + ':/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',
                   'HOME': str(home), 'TMPDIR': str(temporary), 'LANG': 'C.UTF-8',
                   'CI': 'true', 'NODE_ENV': 'production', 'SOURCE_DATE_EPOCH': context['source_date_epoch']}
    journal = target / 'commands.jsonl'
    install = s5_run_command([args.node, args.pnpm, 'install', '--frozen-lockfile', '--prod=false',
                              '--store-dir', str(root / 'pnpm-store'), '--registry=https://registry.npmjs.org',
                              '--network-concurrency=8', '--child-concurrency=2', '--fetch-timeout=60000',
                              '--fetch-retries=2'], source, environment, target / 'install.log', journal)
    locked = hashlib.sha256((source / 'pnpm-lock.yaml').read_bytes()).hexdigest()
    s5_run_command([args.node, str(source / 'scripts/build-v2.cjs')], source, environment,
                   target / 'build.log', journal)
    manifests = {'backend': s5_asset_manifest(source / 'static/build'),
                 'frontend': s5_asset_manifest(source / 'static/dist-v2')}
    s5_run_command([args.node, args.pnpm, 'prune', '--prod'], source,
                   dict(environment, npm_config_ignore_scripts='true',
                        npm_config_store_dir=str(root / 'pnpm-store')), target / 'prune.log', journal)
    s5_run_command([args.node, args.pnpm, 'rebuild', '--prod'], source,
                   dict(environment, npm_config_store_dir=str(root / 'pnpm-store')),
                   target / 'rebuild-production.log', journal)
    driver_check = ('const s=require("sqlite3");const d=new s.Database(":memory:",e=>{'
                    'if(e)throw e;d.get("PRAGMA integrity_check",(e,r)=>{if(e)throw e;'
                    'if(r.integrity_check!=="ok")throw Error("SQLITE_INTEGRITY_FAILED");'
                    'd.close(e=>{if(e)throw e;process.stdout.write("SQLITE_NATIVE_READY\\n")})})});')
    s5_run_command([args.node, '-e', driver_check], source, environment,
                   target / 'native-driver-source.log', journal)
    if hashlib.sha256((source / 'pnpm-lock.yaml').read_bytes()).hexdigest() != locked:
        raise ValueError('S5_FROZEN_LOCKFILE_CHANGED')
    release = target / 'release'
    release.mkdir(mode=0o700)
    for relative in ['static/build', 'static/dist-v2', 'node_modules', 'scripts/release-v2']:
        src = source / relative
        if src.exists():
            shutil.copytree(src, release / relative, symlinks=True)
    for relative in ['package.json', 'pnpm-lock.yaml', 'version.yaml', 'LICENSE']:
        shutil.copy2(source / relative, release / relative)
    (release / 'shell').mkdir()
    for helper in (source / 'shell').glob('*.py'):
        shutil.copy2(helper, release / 'shell' / helper.name)
    shutil.copy2(source / 'scripts/start-v2.cjs', release / 'scripts/start-v2.cjs')
    (release / 'scripts/release').mkdir()
    shutil.copy2(source / 'scripts/release/entrypoint.cjs', release / 'scripts/release/entrypoint.cjs')
    s5_run_command([args.node, '-e', driver_check], release, environment,
                   target / 'native-driver-release.log', journal)
    native_addons = [{'path': file.relative_to(release).as_posix(),
                      'bytes': file.stat().st_size,
                      'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}
                     for file in sorted((release / 'node_modules').rglob('*.node')) if file.is_file()]
    if not native_addons:
        raise ValueError('S5_TARGET_NATIVE_ADDON_MISSING')
    # Immutable artifact files have independent inodes, rather than PNPM store hardlinks.
    if (s5_asset_manifest(release / 'static/build') != manifests['backend'] or
            s5_asset_manifest(release / 'static/dist-v2') != manifests['frontend']):
        raise ValueError('S5_RELEASE_COPY_MISMATCH')
    manifests['helpers'] = s5_asset_manifest(release / 'shell')
    manifests['entrypoints'] = s5_asset_manifest(release / 'scripts')
    root_files = {name: hashlib.sha256((release / name).read_bytes()).hexdigest()
                  for name in ['package.json', 'pnpm-lock.yaml', 'version.yaml', 'LICENSE']}
    for artifact in [release / 'static/build', release / 'static/dist-v2', release / 'shell', release / 'scripts']:
        for current, directories, names in os.walk(artifact):
            for name in names:
                file = pathlib.Path(current) / name
                file.chmod(file.stat().st_mode & ~0o222)
            for name in directories:
                folder = pathlib.Path(current) / name
                folder.chmod(folder.stat().st_mode & ~0o222)
        artifact.chmod(artifact.stat().st_mode & ~0o222)
    result = {'candidate_git_sha': args.commit, 'candidate_tree_sha': context['tree_sha'],
              'source_archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
              'lockfile_sha256': locked, 'node_version': context['node_version'],
              'pnpm_version': context['pnpm_version'], 'os': platform.system(),
              'architecture': platform.machine(), 'kernel': platform.release(),
              'production_mode': True, 'independent_source_export': True,
              'native_addons': native_addons, 'native_rebuilt_after_prune': True,
              'root_files_sha256': root_files,
              'inherited_developer_node_modules': False, 'environment_user_secrets_inherited': False,
              'install': install, 'manifests': manifests, 'source_root': str(source),
              'release_root': str(release)}
    result['artifact_sha256'] = hashlib.sha256(json.dumps({
        'candidate_git_sha': args.commit, 'lockfile_sha256': locked,
        'backend': manifests['backend']['sha256'], 'frontend': manifests['frontend']['sha256'],
        'helpers': manifests['helpers']['sha256'], 'entrypoints': manifests['entrypoints']['sha256'],
        'root_files_sha256': root_files, 'native_addons': native_addons},
        sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    (target / 'candidate.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'build': target.name, 'status': 'BUILT', 'artifact_sha256': result['artifact_sha256']}), flush=True)
    return result


def s5_build_main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--context', type=pathlib.Path, required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--pnpm', required=True)
    args = parser.parse_args()
    if len(args.commit) != 40 or any(c not in '0123456789abcdef' for c in args.commit):
        raise ValueError('S5_FULL_SOURCE_COMMIT_REQUIRED')
    context = json.loads(args.context.read_text())
    root = pathlib.Path(context['root'])
    info = root.lstat()
    owner_file = root / '.s5-owner.json'
    marker = json.loads(owner_file.read_text())
    if (root.is_symlink() or root.resolve() != root or info.st_uid != os.getuid() or
            info.st_mode & 0o077 or owner_file.is_symlink() or owner_file.stat().st_nlink != 1 or
            marker.get('stage') != 'S5' or marker.get('nonce') != context['owner_nonce']):
        raise ValueError('S5_OWNED_BUILD_ROOT_REQUIRED')
    repo = pathlib.Path(args.repository).resolve()
    context.update(tree_sha=subprocess.check_output(['git', 'rev-parse', args.commit + '^{tree}'], cwd=repo, text=True).strip(),
                   source_date_epoch=subprocess.check_output(['git', 'show', '-s', '--format=%ct', args.commit], cwd=repo, text=True).strip(),
                   node_version=subprocess.check_output([args.node, '--version'], text=True).strip(),
                   pnpm_version=subprocess.check_output([args.node, args.pnpm, '--version'], text=True).strip())
    results = [s5_build_candidate(args, name, context) for name in ['build-A', 'build-B']]
    comparison = {key: results[0]['manifests'][key] == results[1]['manifests'][key]
                  for key in ['backend', 'frontend', 'helpers', 'entrypoints']}
    (root / 'reproducibility.json').write_text(json.dumps({
        'candidate_git_sha': args.commit, 'comparison': comparison,
        'bit_for_bit_backend_frontend': all(comparison.values()),
        'builds': results}, indent=2) + '\n')
    print(json.dumps({'independent_build_comparison': comparison}), flush=True)


if __name__ == '__main__':
    s5_build_main()
