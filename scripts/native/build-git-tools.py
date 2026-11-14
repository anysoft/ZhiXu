#!/usr/bin/env python3
"""Build client-only OpenSSH with pinned static crypto in a uniquely owned root.
No host installation, host configuration or existing output is overwritten.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import uuid

PINS = json.loads(Path(__file__).with_name('git-tools-sources.json').read_text())
SSH_FILES = ('bin/ssh', 'bin/ssh-keygen', 'libexec/ssh-sk-helper', 'libexec/ssh-pkcs11-helper')
FILES = SSH_FILES + ('bin/git', 'libexec/git-core/git-remote-http')
RECIPE_INPUTS = {name: Path(__file__).with_name(name).read_bytes() for name in ['build-git-tools.py', 'build-git-tools.sh', 'git-tools-sources.json', 'README.md']}
ACTIVE = None


def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def interrupted(signum, _frame):
    if ACTIVE is not None:
        try:
            os.killpg(ACTIVE.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    raise InterruptedError('NATIVE_TOOL_BUILD_INTERRUPTED_' + str(signum))


def regular(file, maximum):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > maximum:
            raise ValueError('SOURCE_NOT_REGULAR')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            data = stream.read(maximum + 1)
        after = os.fstat(fd)
        if len(data) != st.st_size or (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('SOURCE_CHANGED')
        return data
    finally:
        os.close(fd)


def acquire(name, pin, cache):
    file = cache / Path(pin['url']).name
    if not file.exists():
        temporary = cache / ('.download-' + uuid.uuid4().hex)
        try:
            with urllib.request.urlopen(pin['url'], timeout=60) as response, temporary.open('xb') as out:
                if response.status != 200 or not response.url.startswith('https://'):
                    raise ValueError('SOURCE_HTTPS_REJECTED')
                size = 0
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    size += len(block)
                    if size > 80 * 1024 * 1024:
                        raise ValueError('SOURCE_SIZE_LIMIT')
                    out.write(block)
                length = response.headers.get('Content-Length')
                if length and size != int(length):
                    raise ValueError('SOURCE_TRUNCATED')
            if digest(temporary) != pin['sha256']:
                raise ValueError('SOURCE_DIGEST_REJECTED_' + name)
            os.replace(temporary, file)
        finally:
            temporary.unlink(missing_ok=True)
    data = regular(file, 80 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != pin['sha256']:
        raise ValueError('SOURCE_DIGEST_REJECTED_' + name)
    return file


def extract(archive, parent):
    # Reviewed release archives contain only directories, regular files and bounded
    # in-tree links. Reject devices/FIFOs and escaping paths before extraction.
    with tarfile.open(archive) as tar:
        entries = tar.getmembers()
        if len(entries) > 30000 or sum(x.size for x in entries) > 400 * 1024 * 1024:
            raise ValueError('SOURCE_EXPANSION_LIMIT')
        tops = set()
        for entry in entries:
            target = parent / entry.name
            if entry.name.startswith('/') or '..' in Path(entry.name).parts:
                raise ValueError('SOURCE_PATH_REJECTED')
            tops.add(Path(entry.name).parts[0])
            if not (entry.isdir() or entry.isfile() or entry.issym() or entry.islnk()):
                raise ValueError('SOURCE_TYPE_REJECTED')
            if entry.issym() or entry.islnk():
                link = target.parent / entry.linkname if entry.issym() else parent / entry.linkname
                if Path(entry.linkname).is_absolute() or os.path.commonpath([parent, link.resolve()]) != str(parent):
                    raise ValueError('SOURCE_LINK_REJECTED')
        if len(tops) != 1:
            raise ValueError('SOURCE_ROOT_REJECTED')
        # Python 3.9 on the isolated Debian11 builder has no filter argument.
        # Extract regular files first so no member can traverse an archive link.
        for entry in entries:
            if entry.isdir():
                (parent / entry.name).mkdir(parents=True, exist_ok=True, mode=0o755)
        for entry in entries:
            if entry.isfile():
                target = parent / entry.name
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(entry) as source, target.open('xb') as out:
                    shutil.copyfileobj(source, out)
                target.chmod(entry.mode & 0o755)
                os.utime(target, (entry.mtime, entry.mtime), follow_symlinks=False)
        for entry in entries:
            target = parent / entry.name
            if entry.issym():
                target.symlink_to(entry.linkname)
            elif entry.islnk():
                os.link(parent / entry.linkname, target)
    return parent / next(iter(tops))


def main():
    global ACTIVE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--source-cache', required=True, type=Path)
    parser.add_argument('--work-parent', required=True, type=Path)
    parser.add_argument('--jobs', type=int, default=2, choices=range(1, 9))
    options = parser.parse_args()
    if os.environ.get('NODE_TLS_REJECT_UNAUTHORIZED') == '0':
        raise ValueError('TLS_BYPASS_REJECTED')
    for directory in (options.source_cache, options.work_parent, options.output.parent):
        if not directory.is_absolute() or directory.resolve() != directory or not directory.is_dir():
            raise ValueError('OWNED_CANONICAL_PARENT_REQUIRED')
        st = directory.stat()
        if st.st_uid != os.getuid() or st.st_mode & 0o022:
            raise ValueError('OWNED_PROTECTED_PARENT_REQUIRED')
    if options.work_parent.stat().st_dev != options.output.parent.stat().st_dev:
        raise ValueError('ATOMIC_OUTPUT_REQUIRES_SAME_FILESYSTEM')
    if options.output.exists() or options.output.is_symlink():
        raise ValueError('OUTPUT_EXISTS_REFUSING_TO_OVERWRITE')
    nonce = uuid.uuid4().hex
    lock_path = options.output.parent / ('.' + options.output.name + '.build.lock')
    lock = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    identity = os.fstat(lock)
    work = None
    try:
        os.write(lock, nonce.encode())
        work = Path(tempfile.mkdtemp(prefix='git-tools-' + nonce[:12] + '-', dir=options.work_parent))
        for directory in ('sources', 'logs', 'stage'):
            (work / directory).mkdir(mode=0o700)
        receipt = {'nonce': nonce, 'started_at': time.time(), 'commands': [], 'work_dev': work.stat().st_dev, 'work_ino': work.stat().st_ino}
        (work / '.zhixu-native-owner.json').write_text(json.dumps(receipt, indent=2) + '\n')
        env = {key: value for key, value in os.environ.items() if key not in ('CFLAGS', 'CPPFLAGS', 'LDFLAGS', 'LIBS', 'DYLD_LIBRARY_PATH', 'LD_LIBRARY_PATH', 'PKG_CONFIG_PATH', 'CONFIG_SITE')}
        env.update(CONFIG_SITE='/dev/null', CFLAGS='-O2 -ffile-prefix-map=' + str(work) + '=/usr/src/zhixu-native -fdebug-prefix-map=' + str(work) + '=/usr/src/zhixu-native', ZERO_AR_DATE='1')
        def run(argv, cwd, timeout=900):
            global ACTIVE
            index = len(receipt['commands'])
            started = time.monotonic()
            with (work / 'logs' / (str(index) + '.stdout')).open('wb') as stdout, (work / 'logs' / (str(index) + '.stderr')).open('wb') as stderr:
                ACTIVE = subprocess.Popen([str(x) for x in argv], cwd=cwd, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
                receipt['active_process'] = {'pid': ACTIVE.pid, 'pgid': ACTIVE.pid, 'started_at': time.time(), 'argv': [str(x) for x in argv]}
                (work / '.zhixu-native-owner.json').write_text(json.dumps(receipt, indent=2) + '\n')
                try:
                    code = ACTIVE.wait(timeout=timeout)
                except BaseException:
                    try:
                        os.killpg(ACTIVE.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    ACTIVE.wait()
                    raise
                finally:
                    ACTIVE = None
                    receipt.pop('active_process', None)
            receipt['commands'].append({'argv': [str(x) for x in argv], 'exit': code, 'monotonic_ms': (time.monotonic() - started) * 1000})
            (work / '.zhixu-native-owner.json').write_text(json.dumps(receipt, indent=2) + '\n')
            if code:
                raise RuntimeError('BUILD_COMMAND_FAILED_' + str(index))
        sources = {name: extract(acquire(name, pin, options.source_cache), work / 'sources') for name, pin in PINS.items() if isinstance(pin, dict) and 'url' in pin}
        crypto = work / 'stage/usr/local/zhixu-git-crypto'
        zlib = work / 'stage/usr/local/zhixu-git-zlib'
        run(['perl', 'Configure', 'no-shared', 'no-module', 'no-tests', '--prefix=/usr/local/zhixu-git-crypto', '--openssldir=/usr/local/zhixu-git-crypto/ssl', '--libdir=lib'], sources['openssl'])
        run(['make', '-j' + str(options.jobs)], sources['openssl'])
        run(['make', 'install_sw', 'DESTDIR=' + str(work / 'stage')], sources['openssl'])
        run(['./configure', '--static', '--prefix=/usr/local/zhixu-git-zlib'], sources['zlib'])
        run(['make', '-j' + str(options.jobs)], sources['zlib'])
        run(['make', 'check'], sources['zlib'])
        run(['make', 'install', 'DESTDIR=' + str(work / 'stage')], sources['zlib'])
        run(['./configure', '--prefix=/usr/local/zhixu-git-tools', '--sysconfdir=/dev/null', '--with-ssl-dir=' + str(crypto), '--with-zlib=' + str(zlib), '--without-rpath', '--without-pam', '--without-kerberos5', '--without-libedit', '--without-ldns', '--without-selinux', '--without-security-key-builtin'] + (['--with-libs=-ldl -pthread'] if platform.system() == 'Linux' else []), sources['openssh'])
        run(['make', '-j' + str(options.jobs), 'ssh', 'ssh-keygen', 'ssh-sk-helper', 'ssh-pkcs11-helper'], sources['openssh'])
        mbedtls = work / 'stage/usr/local/zhixu-git-mbedtls'
        run(['make', '-j' + str(options.jobs), 'lib', 'CFLAGS=' + env['CFLAGS']], sources['mbedtls'])
        (mbedtls / 'lib').mkdir(parents=True)
        shutil.copytree(sources['mbedtls'] / 'include', mbedtls / 'include')
        for name in ['libmbedtls.a', 'libmbedx509.a', 'libmbedcrypto.a']:
            shutil.copyfile(sources['mbedtls'] / 'library' / name, mbedtls / 'lib' / name)
        curl = work / 'stage/usr/local/zhixu-git-curl'
        ca_bundle = '/etc/ssl/cert.pem' if platform.system() == 'Darwin' else '/etc/ssl/certs/ca-certificates.crt'
        if not Path(ca_bundle).is_file():
            raise ValueError('SYSTEM_CA_BUNDLE_REQUIRED')
        env.update(CPPFLAGS='-I' + str(mbedtls / 'include') + ' -I' + str(zlib / 'include'), LDFLAGS='-L' + str(mbedtls / 'lib') + ' -L' + str(zlib / 'lib'), PKG_CONFIG='false', PKG_CONFIG_LIBDIR='')
        run(['./configure', '--prefix=/usr/local/zhixu-git-curl', '--disable-shared', '--enable-static', '--without-openssl', '--with-mbedtls=' + str(mbedtls), '--with-zlib=' + str(zlib), '--with-ca-bundle=' + ca_bundle, '--without-libpsl', '--without-brotli', '--without-zstd', '--without-nghttp2', '--without-nghttp3', '--without-ngtcp2', '--without-libidn2', '--without-libssh2', '--disable-ldap', '--disable-ldaps', '--disable-rtsp', '--disable-dict', '--disable-telnet', '--disable-tftp', '--disable-pop3', '--disable-imap', '--disable-smtp', '--disable-gopher', '--disable-mqtt', '--disable-smb', '--disable-manual'], sources['curl'])
        run(['make', '-j' + str(options.jobs)], sources['curl'])
        run(['make', 'install', 'DESTDIR=' + str(work / 'stage')], sources['curl'])
        curl_libraries = [str(curl / 'lib/libcurl.a'), str(mbedtls / 'lib/libmbedtls.a'), str(mbedtls / 'lib/libmbedx509.a'), str(mbedtls / 'lib/libmbedcrypto.a'), str(zlib / 'lib/libz.a')]
        curl_libraries += ['-framework', 'SystemConfiguration', '-framework', 'CoreFoundation', '-lpthread'] if platform.system() == 'Darwin' else ['-ldl', '-lpthread']
        make_git = ['make', '-j' + str(options.jobs), 'prefix=/usr/local/zhixu-git-tools', 'NO_GETTEXT=YesPlease', 'NO_TCLTK=YesPlease', 'NO_PERL=YesPlease', 'NO_PYTHON=YesPlease', 'NO_EXPAT=YesPlease', 'NO_OPENSSL=YesPlease', 'CURL_CONFIG=' + str(curl / 'bin/curl-config'), 'CURLDIR=' + str(curl), 'CURL_LDFLAGS=' + ' '.join(curl_libraries), 'ZLIB_PATH=' + str(zlib), 'CFLAGS=' + env['CFLAGS'], 'LDFLAGS=' + env['LDFLAGS']]
        run(make_git + ['git', 'git-remote-http'], sources['git'])
        output = work / 'output'
        output.mkdir(mode=0o755)
        for name in SSH_FILES:
            target = output / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            shutil.copyfile(sources['openssh'] / target.name, target)
            target.chmod(0o755)
        for name, source in [('bin/git', sources['git'] / 'git'), ('libexec/git-core/git-remote-http', sources['git'] / 'git-remote-http')]:
            target = output / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            shutil.copyfile(source, target)
            target.chmod(0o755)
        run([output / 'bin/git', '--version'], work)
        git_version = (work / 'logs' / (str(len(receipt['commands']) - 1) + '.stdout')).read_text().strip()
        if git_version != 'git version ' + PINS['git']['version']:
            raise ValueError('ACTUAL_GIT_VERSION_REJECTED')
        run([output / 'bin/git', '--list-cmds=builtins'], work)
        builtins = (work / 'logs' / (str(len(receipt['commands']) - 1) + '.stdout')).read_text().splitlines()
        import re
        if not builtins or any(not re.fullmatch(r'[a-z0-9][a-z0-9-]*', name) for name in builtins):
            raise ValueError('GIT_BUILTIN_LIST_REJECTED')
        links = {'libexec/git-core/git-' + name: 'bin/git' for name in builtins}
        links.update({'bin/git-' + name: 'bin/git' for name in ('upload-pack', 'receive-pack', 'upload-archive')})
        links['libexec/git-core/git-remote-https'] = 'libexec/git-core/git-remote-http'
        for name, target in links.items():
            (output / name).symlink_to(os.path.relpath(output / target, (output / name).parent))
        run([output / 'bin/ssh', '-V'], work)
        version = (work / 'logs' / (str(len(receipt['commands']) - 1) + '.stderr')).read_text()
        if 'OpenSSH_10.6p2' not in version or 'OpenSSL 3.5.9' not in version:
            raise ValueError('ACTUAL_SSH_VERSION_REJECTED')
        linkage = []
        for name in FILES:
            command = ['otool', '-L', output / name] if platform.system() == 'Darwin' else ['ldd', output / name]
            run(command, work, 30)
            text = (work / 'logs' / (str(len(receipt['commands']) - 1) + '.stdout')).read_text()
            if any(x in text for x in ('libcrypto.', 'libssl.', 'libz.')):
                raise ValueError('DYNAMIC_CRYPTO_OR_ZLIB_REJECTED')
            linkage.append({'file': name, 'output': text})
        licenses = {}
        for name, source in [('git-COPYING', sources['git'] / 'COPYING'), ('curl-COPYING', sources['curl'] / 'COPYING'), ('mbedtls-LICENSE', sources['mbedtls'] / 'LICENSE'), ('openssh-LICENCE', sources['openssh'] / 'LICENCE'), ('openssl-LICENSE', sources['openssl'] / 'LICENSE.txt'), ('zlib-license-header.h', sources['zlib'] / 'zlib.h')]:
            target = output / 'licenses' / name
            target.parent.mkdir(exist_ok=True, mode=0o755)
            shutil.copyfile(source, target)
            target.chmod(0o644)
            licenses['licenses/' + name] = digest(target)
        # Distribute the exact corresponding source archives and build recipe,
        # including the explicit Mbed TLS GPLv2-or-later license election.
        source_archives = {}
        for name, pin in PINS.items():
            if not isinstance(pin, dict) or 'url' not in pin:
                continue
            target = output / 'sources' / Path(pin['url']).name
            target.parent.mkdir(exist_ok=True, mode=0o755)
            shutil.copyfile(options.source_cache / target.name, target)
            target.chmod(0o644)
            source_archives['sources/' + target.name] = digest(target)
        recipe = {}
        for name in ['build-git-tools.py', 'build-git-tools.sh', 'git-tools-sources.json', 'README.md']:
            target = output / 'sources' / name
            target.write_bytes(RECIPE_INPUTS[name])
            target.chmod(0o644)
            recipe['sources/' + name] = digest(target)
        architecture = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64'}.get(platform.machine())
        if architecture is None:
            raise ValueError('UNSUPPORTED_NATIVE_ARCHITECTURE')
        manifest = {'format': 2, 'https_tls_backend': 'MbedTLS', 'mbedtls_version': PINS['mbedtls']['version'], 'mbedtls_source_sha256': PINS['mbedtls']['sha256'], 'mbedtls_license_election': 'GPL-2.0-or-later', 'licenses': licenses, 'source_archives': source_archives, 'source_recipe': recipe, 'git_version': PINS['git']['version'], 'git_source_sha256': PINS['git']['sha256'], 'curl_version': PINS['curl']['version'], 'curl_source_sha256': PINS['curl']['sha256'], 'links': links, 'git_builtins': builtins, 'publisher': PINS['publisher'], 'platform': 'darwin' if platform.system() == 'Darwin' else 'linux', 'architecture': architecture, 'openssh_version': PINS['openssh']['version'], 'openssh_source_sha256': PINS['openssh']['sha256'], 'openssl_version': PINS['openssl']['version'], 'openssl_source_sha256': PINS['openssl']['sha256'], 'zlib_version': PINS['zlib']['version'], 'zlib_source_sha256': PINS['zlib']['sha256'], 'crypto_linkage': 'static', 'files': {name: digest(output / name) for name in FILES}}
        (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (output / 'manifest.json').chmod(0o644)
        receipt.update(result='BUILT_AND_ACTUALLY_VERIFIED', actual_ssh_version=version.strip(), actual_git_version=git_version, system_ca_bundle=ca_bundle, linkage=linkage, manifest=manifest, finished_at=time.time())
        # Build logs stay in the owned work root for audit; release output is atomic.
        (work / 'build-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        os.rename(output, options.output)
        print(json.dumps({'result': receipt['result'], 'output': str(options.output), 'work_root': str(work), 'manifest_sha256': digest(options.output / 'manifest.json')}))
    finally:
        os.close(lock)
        named = lock_path.lstat()
        if (named.st_dev, named.st_ino) == (identity.st_dev, identity.st_ino):
            lock_path.unlink()


if __name__ == '__main__':
    os.umask(0o077)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, interrupted)
    main()
