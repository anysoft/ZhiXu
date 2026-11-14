#!/usr/bin/env python3
"""Build two independent S5.R application exports with an explicit native tool input.

Native Git tools are a separately verified, frozen platform input. This checks
application reproducibility; it does not claim that their source build is bit
reproducible. No developer node_modules, HOME or credentials are inherited.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import platform
import shutil
import stat
import subprocess
import tarfile
import time


def sha256(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def command(argv, cwd, env, log, journal):
    start = time.monotonic_ns()
    with log.open('xb') as output:
        result = subprocess.run(argv, cwd=cwd, env=env, stdout=output,
                                stderr=subprocess.STDOUT)
    row = {'command': [str(arg) for arg in argv], 'exit_code': result.returncode,
           'duration_ms': (time.monotonic_ns() - start) / 1000000,
           'log': str(log), 'log_sha256': sha256(log)}
    with journal.open('a') as stream:
        stream.write(json.dumps(row) + '\n')
    if result.returncode:
        raise RuntimeError('S5R_BUILD_COMMAND_FAILED: ' + log.name)
    return row


def content_manifest(root):
    spec = importlib.util.spec_from_file_location(
        's5_sealer', pathlib.Path(__file__).parent.parent / 's5/seal-artifact.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    entries = module.artifact_entries(root)
    encoded = json.dumps(entries, ensure_ascii=False, separators=(',', ':')).encode()
    return {'sha256': hashlib.sha256(encoded).hexdigest(), 'entries': entries}


def application_manifest(root):
    spec = importlib.util.spec_from_file_location(
        's5_builder', pathlib.Path(__file__).parent.parent / 's5/build-candidate.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.s5_asset_manifest(root)


def source_export(archive, output):
    output.mkdir(mode=0o700)
    seen = set()
    with tarfile.open(archive) as reader:
        for member in reader:
            relative = pathlib.PurePosixPath(member.name)
            if (relative.is_absolute() or '..' in relative.parts or
                    relative.as_posix() in seen or
                    not (member.isfile() or member.isdir())):
                raise ValueError('S5R_UNSAFE_SOURCE_ARCHIVE')
            seen.add(relative.as_posix())
            file = output.joinpath(*relative.parts)
            if member.isdir():
                file.mkdir(parents=True, exist_ok=True)
            else:
                file.parent.mkdir(parents=True, exist_ok=True)
                with reader.extractfile(member) as source, file.open('xb') as dest:
                    shutil.copyfileobj(source, dest)
                file.chmod(member.mode & 0o777)


def build(args, context, name, git_input):
    target = pathlib.Path(context['root']) / name
    target.mkdir(mode=0o700)
    source = target / 'source'
    source_export(args.source_archive, source)
    if (sha256(source / 'pnpm-lock.yaml') != context['lockfile_sha256'] or
            sha256(source / 'pnpm-workspace.yaml') != context['workspace_policy_sha256']):
        raise ValueError('S5R_LOCK_OR_POLICY_INPUT_MISMATCH')
    (source / 'bin').mkdir(exist_ok=True)
    shutil.copytree(args.git_tools, source / 'bin/git-tools', symlinks=True)
    if content_manifest(source / 'bin/git-tools') != git_input:
        raise ValueError('S5R_NATIVE_TOOLS_COPY_MISMATCH')
    home, temporary = target / 'home', target / 'tmp'
    home.mkdir(mode=0o700)
    temporary.mkdir(mode=0o700)
    toolbin = target / 'tool-bin'
    toolbin.mkdir(mode=0o700)
    for name, executable in [('node', args.node), ('npm', args.npm),
                             ('npx', args.npm.parent / 'npx-cli.js'),
                             ('pnpm', args.pnpm)]:
        (toolbin / name).symlink_to(executable)
    env = {'PATH': str(toolbin) + ':/usr/bin:/bin:/usr/sbin:/sbin',
           'HOME': str(home), 'TMPDIR': str(temporary), 'LANG': 'C.UTF-8',
           'CI': 'true', 'NODE_ENV': 'production',
           'SOURCE_DATE_EPOCH': str(context['source_date_epoch']),
           'ZHIXU_SQLITE_SOURCE_ARCHIVE': str(args.sqlite_source),
           'npm_config_nodedir': str(args.node_prefix)}
    journal = target / 'commands.jsonl'
    command([args.node, args.pnpm, 'install', '--frozen-lockfile', '--prod=false',
             '--store-dir', pathlib.Path(context['root']) / 'pnpm-store',
             '--registry=https://registry.npmjs.org', '--network-concurrency=8',
             '--child-concurrency=2', '--fetch-timeout=60000', '--fetch-retries=2'],
            source, env, target / 'install.log', journal)
    command([args.node, source / 'scripts/build-v2.cjs'], source, env,
            target / 'build.log', journal)
    outputs = {key: application_manifest(source / relative) for key, relative in
               [('backend', 'static/build'), ('frontend', 'static/dist-v2')]}
    store_env = dict(env, npm_config_store_dir=str(pathlib.Path(context['root']) / 'pnpm-store'))
    command([args.node, args.pnpm, 'prune', '--prod'], source,
            dict(store_env, npm_config_ignore_scripts='true'), target / 'prune.log', journal)
    # Execute the reviewed fork installer explicitly: a PNPM cache hit must not
    # substitute an old target addon for the required post-prune source rebuild.
    rebuild = ('const p=require("node:path");const s=require("node:child_process");'
               'const r=s.spawnSync(process.execPath,[p.join(p.dirname('
               'require.resolve("sqlite3/package.json")),"deps/install-secure.cjs")],'
               '{stdio:"inherit",env:process.env});'
               'if(r.error)throw r.error;process.exit(r.status??1);')
    command([args.node, '-e', rebuild], source,
            dict(store_env, ZHIXU_SQLITE_FORCE_REBUILD='1'),
            target / 'rebuild-production.log', journal)
    command([args.node, source / 'scripts/native/verify-sqlite.cjs'], source, env,
            target / 'native-driver-source.log', journal)
    if sha256(source / 'pnpm-lock.yaml') != context['lockfile_sha256']:
        raise ValueError('S5R_FROZEN_LOCKFILE_CHANGED')
    release = target / 'release'
    release.mkdir(mode=0o700)
    for relative in ['static/build', 'static/dist-v2', 'node_modules', 'bin/git-tools',
                     'scripts/release-v2', 'scripts/native']:
        shutil.copytree(source / relative, release / relative, symlinks=True)
    root_files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
                  'version.yaml', 'LICENSE']
    for relative in root_files:
        shutil.copy2(source / relative, release / relative)
    (release / 'shell').mkdir()
    for helper in (source / 'shell').glob('*.py'):
        shutil.copy2(helper, release / 'shell' / helper.name)
    shutil.copy2(source / 'scripts/start-v2.cjs', release / 'scripts/start-v2.cjs')
    (release / 'scripts/release').mkdir()
    shutil.copy2(source / 'scripts/release/entrypoint.cjs', release / 'scripts/release/entrypoint.cjs')
    command([args.node, release / 'scripts/native/verify-sqlite.cjs'], release, env,
            target / 'native-driver-release.log', journal)
    command([args.node, release / 'scripts/native/prepare-git-tools.cjs'], release, env,
            target / 'native-git-release.log', journal)
    actual = {key: application_manifest(release / relative) for key, relative in
              [('backend', 'static/build'), ('frontend', 'static/dist-v2')]}
    if actual != outputs or content_manifest(release / 'bin/git-tools') != git_input:
        raise ValueError('S5R_RELEASE_COPY_MISMATCH')
    addons = [{'path': file.relative_to(release).as_posix(),
               'sha256': sha256(file), 'bytes': file.stat().st_size}
              for file in sorted((release / 'node_modules').rglob('*.node')) if file.is_file()]
    if not addons:
        raise ValueError('S5R_NATIVE_ADDON_MISSING')
    manifests = {**outputs, 'helpers': application_manifest(release / 'shell'),
                 'entrypoints': application_manifest(release / 'scripts'),
                 'native_git_tools': git_input}
    result = {**context, 'source_archive_sha256': sha256(args.source_archive),
              'os': platform.system(), 'architecture': platform.machine(),
              'kernel': platform.release(), 'build_name': target.name,
              'source_root': str(source), 'release_root': str(release),
              'independent_source_export': True, 'production_mode': True,
              'inherited_developer_node_modules': False,
              'environment_user_secrets_inherited': False,
              'native_rebuilt_after_prune': True, 'native_addons': addons,
              'native_git_tools_source_build_bit_reproducibility': 'NOT_CLAIMED',
              'native_git_tools_explicit_shared_input_sha256': git_input['sha256'],
              'root_files_sha256': {name: sha256(release / name) for name in root_files},
              'manifests': manifests}
    identity = {'git': context['candidate_git_sha'], 'tree': context['candidate_tree_sha'],
                'manifests': {key: value['sha256'] for key, value in manifests.items()},
                'native_addons': addons, 'root_files': result['root_files_sha256']}
    result['artifact_sha256'] = hashlib.sha256(json.dumps(
        identity, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    (target / 'candidate.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'build': target.name, 'status': 'BUILT',
                      'artifact_sha256': result['artifact_sha256']}), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-archive', required=True, type=pathlib.Path)
    parser.add_argument('--context', required=True, type=pathlib.Path)
    parser.add_argument('--node', required=True, type=pathlib.Path)
    parser.add_argument('--pnpm', required=True, type=pathlib.Path)
    parser.add_argument('--npm', required=True, type=pathlib.Path)
    parser.add_argument('--git-tools', required=True, type=pathlib.Path)
    parser.add_argument('--sqlite-source', required=True, type=pathlib.Path)
    parser.add_argument('--node-prefix', required=True, type=pathlib.Path)
    parser.add_argument('--single-build', choices=['build-A', 'build-B'])
    args = parser.parse_args()
    for file in [args.source_archive, args.context, args.node, args.pnpm, args.npm,
                 args.git_tools, args.sqlite_source, args.node_prefix]:
        if not file.is_absolute() or not file.exists():
            raise ValueError('S5R_EXPLICIT_ABSOLUTE_INPUT_REQUIRED')
    context = json.loads(args.context.read_text())
    root = pathlib.Path(context['root'])
    info = root.lstat()
    marker = json.loads((root / '.s5r-owner.json').read_text())
    if (root.resolve() != root or not stat.S_ISDIR(info.st_mode) or
            info.st_uid != os.getuid() or info.st_mode & 0o077 or
            marker.get('stage') != 'S5.R' or marker.get('nonce') != context['owner_nonce'] or
            marker.get('dev') != info.st_dev or marker.get('ino') != info.st_ino):
        raise ValueError('S5R_OWNED_BUILD_ROOT_REQUIRED')
    for key, length in [('candidate_git_sha', 40), ('candidate_tree_sha', 40),
                        ('source_archive_sha256', 64), ('lockfile_sha256', 64),
                        ('workspace_policy_sha256', 64), ('native_git_manifest_sha256', 64),
                        ('sqlite_source_archive_sha256', 64)]:
        value = context[key]
        if len(value) != length or any(c not in '0123456789abcdef' for c in value):
            raise ValueError('S5R_INPUT_IDENTITY_REQUIRED')
    if (sha256(args.source_archive) != context['source_archive_sha256'] or
            sha256(args.git_tools / 'manifest.json') != context['native_git_manifest_sha256'] or
            sha256(args.sqlite_source) != context['sqlite_source_archive_sha256']):
        raise ValueError('S5R_TRUSTED_BUILD_INPUT_MISMATCH')
    context.update(node_version=subprocess.check_output([args.node, '--version'], text=True).strip(),
                   pnpm_version=subprocess.check_output([args.node, args.pnpm, '--version'], text=True).strip(),
                   npm_version=subprocess.check_output([args.node, args.npm, '--version'], text=True).strip())
    if (context['pnpm_version'] != '10.34.9' or context['npm_version'] != '11.21.2' or
            context['node_version'] != 'v22.23.5'):
        raise ValueError('S5R_PINNED_BUILD_TOOL_VERSION_REQUIRED')
    git_input = content_manifest(args.git_tools)
    names = [args.single_build] if args.single_build else ['build-A', 'build-B']
    results = [build(args, context, name, git_input) for name in names]
    if len(results) == 2:
        comparison = {key: results[0]['manifests'][key] == results[1]['manifests'][key]
                      for key in ['backend', 'frontend', 'helpers', 'entrypoints', 'native_git_tools']}
        proof = {'candidate_git_sha': context['candidate_git_sha'], 'comparison': comparison,
                 'bit_for_bit_application_outputs': all(comparison.values()),
                 'native_git_source_build_reproducibility': 'NOT_CLAIMED_SHARED_FROZEN_INPUT',
                 'builds': results}
        (root / 'reproducibility.json').write_text(json.dumps(proof, indent=2) + '\n')
        if not all(comparison.values()):
            raise RuntimeError('S5R_APPLICATION_REPRODUCIBILITY_MISMATCH')
        print(json.dumps({'independent_build_comparison': comparison}), flush=True)


if __name__ == '__main__':
    main()
