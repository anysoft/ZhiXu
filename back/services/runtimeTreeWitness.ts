import path from 'path';
import fs from 'fs';

let packageRoot = __dirname;
for (;;) {
  const manifest = path.join(packageRoot, 'package.json');
  if (fs.existsSync(manifest)) {
    if (JSON.parse(fs.readFileSync(manifest, 'utf8')).name !== '@anysoft/zhixu')
      throw Error('RUNTIME_TREE_HELPER_UNAVAILABLE');
    break;
  }
  const parent = path.dirname(packageRoot);
  if (parent === packageRoot) throw Error('RUNTIME_TREE_HELPER_UNAVAILABLE');
  packageRoot = parent;
}

/** The acquisition tool and application execute the same canonical algorithm. */
export const runtimeTreeDigest: (
  root: string,
) => Promise<{ sha256: string; entry_count: number; bytes: number }> =
  require(path.join(
    packageRoot,
    'scripts/release-v2/runtime-tree.cjs',
  )).runtimeTreeDigest;
