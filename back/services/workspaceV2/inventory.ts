import fs from 'fs/promises';
import { constants, Stats } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { workspaceRelative } from '../workspaceFiles';
import { fail } from './errors';
import type { Inventory, InventoryEntry, WorkspaceRow } from './types';
import { WorkspaceLimits, workspaceLimits } from './limits';

export const OWNER_MARKER = '.platform-workspace-owner.json';

export { workspaceLimits } from './limits';
export type { WorkspaceLimits } from './limits';

export function relativeWorkspacePath(value: string, root = false): string {
  workspaceRelative(value, root);
  // Express may already have decoded once. Ambiguous double-encoded traversal
  // is rejected here too, without changing the existing v9 path algorithm.
  if (/%(?:25)*(?:2e|2f|5c|00|0a|0d)/i.test(value))
    fail('WORKSPACE_PATH_INVALID', 400);
  if (
    value
      .split('/')
      .some((part) => /^\.platform-(?:run-|node-|workspace-)/i.test(part))
  )
    fail('WORKSPACE_PATH_FORBIDDEN', 403);
  return value;
}

export function sameFileIdentity(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

export function hashWorkspaceRecords(
  records: readonly InventoryEntry[],
): string {
  const canonical = [...records]
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map((entry) =>
      entry.kind === 'file'
        ? {
            path: entry.path,
            kind: entry.kind,
            mode: entry.mode,
            size: entry.size,
            sha256: entry.sha256,
          }
        : { path: entry.path, kind: entry.kind, mode: entry.mode, size: 0 },
    );
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Complete user-source fingerprint. The caller retains the Workspace EX lease. */
export async function scanWorkspace(
  root: string,
  type: WorkspaceRow['type'],
  input: Partial<WorkspaceLimits> = {},
): Promise<Inventory> {
  const limits = workspaceLimits(input);
  const entries: InventoryEntry[] = [];
  const initialRoot = await fs.lstat(root);
  if (
    !initialRoot.isDirectory() ||
    initialRoot.isSymbolicLink() ||
    (await fs.realpath(root)) !== root
  )
    fail('WORKSPACE_PATH_FORBIDDEN', 403);
  const deadline =
    process.hrtime.bigint() +
    BigInt(limits.inventoryDeadlineMs) * BigInt(1000000);
  let fileCount = 0;
  let totalBytes = 0;
  const budget = () => {
    if (process.hrtime.bigint() > deadline) fail('SOURCE_UNVERIFIED');
    if (
      entries.length > limits.maxWorkspaceEntries ||
      totalBytes > limits.maxWorkspaceBytes
    )
      fail('WORKSPACE_QUOTA_EXCEEDED', 413);
  };
  const walk = async (relative: string, depth: number): Promise<void> => {
    budget();
    if (depth > limits.maxDirectoryDepth) fail('WORKSPACE_QUOTA_EXCEEDED', 413);
    const target = relative ? path.join(root, relative) : root;
    const directory = await fs.lstat(target);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (await fs.realpath(target)) !== target
    )
      fail('WORKSPACE_PATH_FORBIDDEN', 403);
    const members = await fs.opendir(target);
    for await (const entry of members) {
      const name = entry.name;
      budget();
      const member = relative ? `${relative}/${name}` : name;
      const absolute = path.join(root, member);
      const info = await fs.lstat(absolute);
      if (!relative && name === OWNER_MARKER) continue;
      if (!relative && name === '.git' && type === 'GIT') {
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          fail('WORKSPACE_PATH_FORBIDDEN', 403);
        continue;
      }
      if (/^\.platform-(?:run-|node-|workspace-)/i.test(name))
        fail('WORKSPACE_RECOVERY_REQUIRED');
      relativeWorkspacePath(member);
      if (
        Buffer.byteLength(member) > limits.maxRelativePathBytes ||
        member.split('/').length > limits.maxDirectoryDepth
      )
        fail('WORKSPACE_QUOTA_EXCEEDED', 413);
      if (
        info.isSymbolicLink() ||
        (process.getuid && info.uid !== process.getuid())
      )
        fail('WORKSPACE_PATH_FORBIDDEN', 403);
      if (info.isDirectory()) {
        entries.push({
          path: member,
          kind: 'directory',
          mode: info.mode & 0o777,
          size: 0,
        });
        budget();
        await walk(member, depth + 1);
        const after = await fs.lstat(absolute);
        if (
          after.dev !== info.dev ||
          after.ino !== info.ino ||
          after.isSymbolicLink()
        )
          fail('WORKSPACE_FILE_CONFLICT');
        continue;
      }
      if (!info.isFile() || info.nlink !== 1)
        fail('WORKSPACE_PATH_FORBIDDEN', 403);
      if (info.size > limits.maxSourceFileBytes)
        fail('WORKSPACE_FILE_TOO_LARGE', 413);
      if (totalBytes + info.size > limits.maxWorkspaceBytes)
        fail('WORKSPACE_QUOTA_EXCEEDED', 413);
      const handle = await fs.open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let digest: string;
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          !sameFileIdentity(info, opened)
        )
          fail('WORKSPACE_FILE_CONFLICT');
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(
          Math.min(Math.max(opened.size, 1), 1024 * 1024),
        );
        let consumed = 0;
        while (true) {
          budget();
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            consumed,
          );
          if (!bytesRead) break;
          consumed += bytesRead;
          if (consumed > limits.maxSourceFileBytes)
            fail('WORKSPACE_FILE_TOO_LARGE', 413);
          hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await handle.stat();
        if (
          consumed !== opened.size ||
          !sameFileIdentity(opened, after) ||
          !sameFileIdentity(after, await fs.lstat(absolute))
        )
          fail('WORKSPACE_FILE_CONFLICT');
        digest = hash.digest('hex');
      } finally {
        await handle.close();
      }
      fileCount++;
      totalBytes += info.size;
      entries.push({
        path: member,
        kind: 'file',
        mode: info.mode & 0o777,
        size: info.size,
        sha256: digest,
      });
      budget();
    }
  };
  await walk('', 0);
  const finalRoot = await fs.lstat(root);
  if (
    initialRoot.dev !== finalRoot.dev ||
    initialRoot.ino !== finalRoot.ino ||
    finalRoot.isSymbolicLink()
  )
    fail('WORKSPACE_PATH_FORBIDDEN', 403);
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  );
  return {
    hash: hashWorkspaceRecords(entries),
    fileCount,
    totalBytes,
    entryCount: entries.length,
    entries,
  };
}

export async function requireDiskBudget(
  root: string,
  bytes: number,
  limits: WorkspaceLimits,
) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) fail('DISK_BUDGET_EXCEEDED');
  const capability: unknown = 'statfs' in fs ? fs.statfs : undefined;
  if (typeof capability !== 'function') fail('DISK_BUDGET_EXCEEDED', 503);
  const disk: unknown = await capability(root);
  if (
    !disk ||
    typeof disk !== 'object' ||
    !('bavail' in disk) ||
    !('bsize' in disk) ||
    typeof disk.bavail !== 'number' ||
    typeof disk.bsize !== 'number' ||
    disk.bavail * disk.bsize < limits.minimumFreeBytes + bytes
  )
    fail('DISK_BUDGET_EXCEEDED', 413);
}
