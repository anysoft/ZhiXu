import fs from 'fs/promises';
import path from 'path';
import { WorkspaceStore } from './store';
import {
  verifyGitRepositoryAsset,
  GitRepositoryAssetProof,
  gitRepositoryKey,
} from './gitStorage';
import { fail, errorCode } from './errors';

export interface RepositoryAssetOptions {
  /** Authenticated copies derive new paths; the previous host path is never followed. */
  relocated?: boolean;
  leaseFds?: number[];
}
export interface RepositoryAssetIdentity {
  repository_id: number;
  storage_key: string;
}
interface RepositoryAssetRow {
  id: number;
  host: string | null;
  storage_state: string;
  storage_path: string | null;
}

async function collect(store: WorkspaceStore, options: RepositoryAssetOptions) {
  const rows = await store.all<RepositoryAssetRow>(
    'SELECT id,host,storage_state,storage_path FROM Repositories ORDER BY id',
  );
  const proofs: GitRepositoryAssetProof[] = [];
  for (const row of rows) {
    // Non-materialized metadata may exist without a repository checkout. Every
    // READY row, including unused and reclaimed-only rows, owns required bytes.
    gitRepositoryKey(row);
    if (row.storage_state === 'READY')
      proofs.push(
        await verifyGitRepositoryAsset(store, store.dataRoot, row.id, options),
      );
  }
  return proofs;
}

/** Must run inside backup freeze or a caller-owned repository admission boundary. */
export async function verifyRepositoryAssets(
  store: WorkspaceStore,
  options: RepositoryAssetOptions = {},
): Promise<RepositoryAssetIdentity[]> {
  try {
    return (await collect(store, options)).map((proof) => ({
      repository_id: proof.repository_id,
      storage_key: proof.storage_key,
    }));
  } catch (error: unknown) {
    const code = errorCode(error);
    fail(
      code === 'WORKSPACE_OPERATION_FAILED'
        ? 'WORKSPACE_RECOVERY_REQUIRED'
        : code,
    );
  }
}

/** Offline candidate/restore only: validate the complete set before relocating any row. */
export async function reconcileRepositoryAssets(
  store: WorkspaceStore,
): Promise<RepositoryAssetIdentity[]> {
  try {
    const proofs = await collect(store, { relocated: true });
    await store.transaction(async (tx) => {
      const current = await tx.all<{ id: number }>(
        "SELECT id FROM Repositories WHERE storage_state='READY' ORDER BY id",
      );
      if (
        current.length !== proofs.length ||
        current.some((row, index) => row.id !== proofs[index].repository_id)
      )
        fail('WORKSPACE_RECOVERY_REQUIRED');
      for (const proof of proofs) {
        const stat = await fs.lstat(proof.bare);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.dev !== proof.device ||
          stat.ino !== proof.inode ||
          proof.bare !== path.join(store.dataRoot, proof.storage_key)
        )
          fail('WORKSPACE_RECOVERY_REQUIRED');
        await tx.run('UPDATE Repositories SET storage_path=? WHERE id=?', [
          proof.bare,
          proof.repository_id,
        ]);
      }
    });
    return proofs.map((proof) => ({
      repository_id: proof.repository_id,
      storage_key: proof.storage_key,
    }));
  } catch (error: unknown) {
    const code = errorCode(error);
    fail(
      code === 'WORKSPACE_OPERATION_FAILED'
        ? 'WORKSPACE_RECOVERY_REQUIRED'
        : code,
    );
  }
}
