import fs from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { GitResourceError } from './gitSecurity';

const TOOL_PATHS = [
  'bin/ssh', 'bin/ssh-keygen', 'libexec/ssh-sk-helper',
  'libexec/ssh-pkcs11-helper', 'bin/git', 'libexec/git-core/git-remote-http',
] as const;
const EXPECTED = {
  openssh_version: '10.6p2',
  openssh_source_sha256: '9ae44872090cf2f06b3cf9ff147e7f16f309671340763ed2f99248398ae29d5b',
  openssl_version: '3.5.9',
  openssl_source_sha256: '603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a',
  zlib_version: '1.4',
  zlib_source_sha256: '02dd159783677a749c04adbdd02b55b8a2bcc7e054f51b76b549199a916ad584',
  git_version: '2.50.2',
  git_source_sha256: 'b9d6be0e286803466f998ced664566de3368534eca7eda6d5d9358e40f55c151',
  curl_version: '8.23.0',
  https_tls_backend: 'MbedTLS',
  mbedtls_version: '3.6.7',
  mbedtls_source_sha256: 'a7e8bcbec0e6f761b4af24f25677626b35f762f68eef79c08677a363212d11f6',
  mbedtls_license_election: 'GPL-2.0-or-later',
  curl_source_sha256: '8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5',
};
const reject = (): never => {
  throw new GitResourceError('Verified candidate Git tools are unavailable');
};
interface Generation {
  dev: number; ino: number; size: number; mtimeMs: number;
  ctimeMs: number; mode: number; uid: number; nlink: number;
}
const generation = (st: Generation) => [
  st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs, st.mode, st.uid, st.nlink,
].join(':');
const proofs = new Map<string, Map<string, string>>();
async function unchanged(proof: Map<string, string>) {
  for (const [file, expected] of proof) {
    const st = await fs.lstat(file).catch(() => null);
    if (!st || generation(st) !== expected) return false;
  }
  return true;
}
async function candidateRoot() {
  let current = __dirname;
  for (let i = 0; i < 6; i++) {
    const metadata = await fs.readFile(path.join(current, 'package.json'), 'utf8')
      .then(JSON.parse).catch(() => null);
    if (metadata?.name === '@anysoft/zhixu') return current;
    current = path.dirname(current);
  }
  return reject();
}

/** Trusted composition only. The immutable release manifest authenticates this
 * bundle; this gate checks its reviewed source pins, native bytes and internal
 * helper links. No environment variable or HTTP setting selects another root.
 */
export async function verifiedGitSshTools(rootOverride?: string) {
  const root = rootOverride ?? path.join(await candidateRoot(), 'bin/git-tools');
  if (!path.isAbsolute(root) || await fs.realpath(root) !== root) reject();
  const result = {
    ssh: path.join(root, 'bin/ssh'),
    sshKeygen: path.join(root, 'bin/ssh-keygen'),
    skHelper: path.join(root, 'libexec/ssh-sk-helper'),
    git: path.join(root, 'bin/git'),
    binPath: path.join(root, 'bin'),
    execPath: path.join(root, 'libexec/git-core'),
  };
  const previous = proofs.get(root);
  if (previous && await unchanged(previous)) return result;
  proofs.delete(root);
  const proof = new Map<string, string>();
  async function protectedDirectory(directory: string) {
    const st = await fs.lstat(directory);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o022) ||
        (st.uid !== 0 && st.uid !== process.getuid?.())) reject();
    proof.set(directory, generation(st));
  }
  await protectedDirectory(root);
  async function protectedBytes(relative: string, maxBytes: number) {
    let directory = root;
    for (const part of relative.split('/').slice(0, -1)) {
      directory = path.join(directory, part);
      await protectedDirectory(directory);
    }
    const file = path.join(root, relative);
    const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await fd.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes ||
          before.size < 1 || (before.mode & 0o022) ||
          (before.uid !== 0 && before.uid !== process.getuid?.())) reject();
      const bytes = await fd.readFile();
      const after = await fd.stat(), named = await fs.lstat(file);
      if (generation(before) !== generation(after) ||
          generation(before) !== generation(named) || bytes.length !== before.size)
        reject();
      proof.set(file, generation(before));
      return { bytes, mode: before.mode };
    } finally { await fd.close(); }
  }
  const manifest = JSON.parse((await protectedBytes('manifest.json', 65536)).bytes.toString());
  if (manifest.format !== 2 ||
      Object.entries(EXPECTED).some(([key, value]) => manifest[key] !== value) ||
      manifest.platform !== process.platform || manifest.architecture !== process.arch ||
      manifest.publisher !== 'ZhiXu controlled source build' ||
      manifest.crypto_linkage !== 'static' || !manifest.files ||
      Object.keys(manifest.files).sort().join('\n') !== [...TOOL_PATHS].sort().join('\n') ||
      !Array.isArray(manifest.git_builtins) || !manifest.git_builtins.length ||
      manifest.git_builtins.length > 300 || !manifest.links)
    reject();
  for (const relative of TOOL_PATHS) {
    const { bytes, mode } = await protectedBytes(relative, 64 * 1024 * 1024);
    if (!(mode & 0o111) || !/^[a-f0-9]{64}$/.test(manifest.files[relative]) ||
        createHash('sha256').update(bytes).digest('hex') !== manifest.files[relative])
      reject();
  }
  const links: Record<string, string> = {
    'libexec/git-core/git-remote-https': 'libexec/git-core/git-remote-http',
  };
  for (const name of manifest.git_builtins) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) reject();
    links['libexec/git-core/git-' + name] = 'bin/git';
  }
  for (const name of ['upload-pack', 'receive-pack', 'upload-archive'])
    links['bin/git-' + name] = 'bin/git';
  if (JSON.stringify(Object.entries(links).sort()) !==
      JSON.stringify(Object.entries(manifest.links).sort())) reject();
  for (const [relative, target] of Object.entries(links)) {
    const file = path.join(root, relative), st = await fs.lstat(file);
    if (!st.isSymbolicLink() ||
        await fs.readlink(file) !== path.relative(path.dirname(file), path.join(root, target)))
      reject();
  }
  const archives: Record<string, string> = {
    'sources/openssh-10.6p2.tar.gz': EXPECTED.openssh_source_sha256,
    'sources/openssl-3.5.9.tar.gz': EXPECTED.openssl_source_sha256,
    'sources/zlib-1.4.tar.gz': EXPECTED.zlib_source_sha256,
    'sources/git-2.50.2.tar.xz': EXPECTED.git_source_sha256,
    'sources/curl-8.23.0.tar.xz': EXPECTED.curl_source_sha256,
    'sources/mbedtls-3.6.7.tar.bz2': EXPECTED.mbedtls_source_sha256,
  };
  if (JSON.stringify(Object.entries(archives).sort()) !==
      JSON.stringify(Object.entries(manifest.source_archives || {}).sort())) reject();
  for (const [group, allowed, limit] of [
    [archives, Object.keys(archives), 80 * 1024 * 1024],
    [manifest.licenses, ['licenses/git-COPYING', 'licenses/curl-COPYING',
      'licenses/mbedtls-LICENSE', 'licenses/openssh-LICENCE',
      'licenses/openssl-LICENSE', 'licenses/zlib-license-header.h'], 1024 * 1024],
    [manifest.source_recipe, ['sources/build-git-tools.py', 'sources/build-git-tools.sh',
      'sources/git-tools-sources.json', 'sources/README.md'], 1024 * 1024],
  ] as [Record<string, string>, string[], number][]) {
    if (!group || Object.keys(group).sort().join('\n') !== allowed.sort().join('\n')) reject();
    for (const [relative, expected] of Object.entries(group)) {
      const { bytes } = await protectedBytes(relative, limit);
      if (!/^[a-f0-9]{64}$/.test(expected) ||
          createHash('sha256').update(bytes).digest('hex') !== expected) reject();
    }
  }
  const expectedEntries = new Set(['manifest.json', ...TOOL_PATHS,
    ...Object.keys(links), ...Object.keys(archives),
    ...Object.keys(manifest.licenses), ...Object.keys(manifest.source_recipe)]);
  const directories = new Set<string>(['']);
  for (const relative of expectedEntries) {
    let directory = path.posix.dirname(relative);
    while (directory !== '.') {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  for (const directory of directories) {
    const named = path.join(root, directory);
    await protectedDirectory(named);
    const expectedNames = [...expectedEntries, ...directories]
      .filter(relative => relative && (path.posix.dirname(relative) === '.' ? '' :
        path.posix.dirname(relative)) === directory)
      .map(relative => path.posix.basename(relative)).sort();
    const actualNames = (await fs.readdir(named)).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) reject();
  }
  // Directory generations cover link replacement; file generations cover changed
  // executable bytes. Recheck this proof on every use, hash only a new generation.
  if (!await unchanged(proof)) reject();
  proofs.set(root, proof);
  return result;
}
