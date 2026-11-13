import { randomUUID } from 'crypto';
import { WorkspaceBackupService } from './backup';
import { WorkspaceStore } from './store';
import { fail } from './errors';
import type { WorkspaceRow } from './types';
import { sha256 } from '../backup/files';

export interface PreservationProof {
  snapshot_key: string;
  workspace_id: number;
  source_generation: number;
  content_revision: number;
  inventory_hash: string;
  manifest_hash: string;
  verified_at: string;
  payload_bytes: number;
}

/** Holds are installed only from a real READY snapshot under the shared catalog lock. */
export class WorkspacePreservationService {
  constructor(readonly backup: WorkspaceBackupService) {}
  withCatalogLock<T>(action: () => Promise<T>) {
    return this.backup.withCatalogLock(action);
  }

  async verifyPreservation(
    snapshotId: string,
    row: WorkspaceRow,
  ): Promise<PreservationProof> {
    const { manifest } = await this.backup.snapshot(snapshotId);
    const entry = manifest.workspaces.find(
      (item) => item.workspace_id === row.id,
    );
    if (
      !entry ||
      !row.content_inventory_hash ||
      entry.workspace_type !== row.type ||
      entry.storage_state !== 'PRESENT' ||
      entry.source_generation !== row.source_generation ||
      entry.content_revision !== row.content_revision ||
      entry.content_inventory_hash !== row.content_inventory_hash
    )
      fail('WORKSPACE_PRESERVATION_REQUIRED');
    return {
      snapshot_key: snapshotId,
      workspace_id: row.id,
      source_generation: row.source_generation,
      content_revision: row.content_revision,
      inventory_hash: row.content_inventory_hash,
      manifest_hash: sha256(JSON.stringify(manifest) + '\n'),
      verified_at: new Date().toISOString(),
      payload_bytes: manifest.total_bytes,
    };
  }

  async installHold(
    proof: PreservationProof,
    store: WorkspaceStore = this.backup.store,
  ) {
    const row = await store.workspace(proof.workspace_id);
    if (
      row.source_generation !== proof.source_generation ||
      row.content_revision !== proof.content_revision ||
      row.content_inventory_hash !== proof.inventory_hash
    )
      fail('WORKSPACE_PRESERVATION_REQUIRED');
    const verified = await this.verifyPreservation(proof.snapshot_key, row);
    if (
      verified.manifest_hash !== proof.manifest_hash ||
      verified.payload_bytes !== proof.payload_bytes
    )
      fail('WORKSPACE_PRESERVATION_REQUIRED');
    await this.backup.recordPreservationHold(proof.snapshot_key, row.id, {
      ...proof,
      receipt_version: 1,
    });
    const existing = await store.all<{
      id: number;
      released_at: string | null;
    }>(
      'SELECT id,released_at FROM WorkspacePreservationHolds WHERE workspace_id=? AND snapshot_key=?',
      [row.id, proof.snapshot_key],
    );
    if (existing[0]) {
      if (existing[0].released_at) fail('WORKSPACE_PRESERVATION_REQUIRED');
      return existing[0].id;
    }
    const result = await store.run(
      `INSERT INTO WorkspacePreservationHolds(workspace_id,snapshot_key,source_generation,content_revision,inventory_hash,manifest_hash,receipt)
       VALUES(?,?,?,?,?,?,?)`,
      [
        row.id,
        proof.snapshot_key,
        proof.source_generation,
        proof.content_revision,
        proof.inventory_hash,
        proof.manifest_hash,
        JSON.stringify({
          ...proof,
          receipt_version: 1,
          verification_id: randomUUID(),
        }),
      ],
    );
    return result.lastID;
  }

  async usage() {
    const holds = await this.backup.store.all<{
      snapshot_key: string;
      receipt: string;
    }>(
      'SELECT snapshot_key,receipt FROM WorkspacePreservationHolds WHERE released_at IS NULL',
    );
    const snapshots = new Map<string, number>();
    for (const hold of holds) {
      const receipt = JSON.parse(hold.receipt) as PreservationProof;
      if (
        !Number.isSafeInteger(receipt.payload_bytes) ||
        receipt.payload_bytes < 0
      )
        fail('WORKSPACE_PRESERVATION_REQUIRED');
      snapshots.set(hold.snapshot_key, receipt.payload_bytes);
    }
    return {
      live_storage_bytes: (
        await this.backup.store.all<{ bytes: number }>(
          "SELECT COALESCE(SUM(total_bytes),0) AS bytes FROM Workspaces WHERE storage_state='PRESENT'",
        )
      )[0].bytes,
      preservation_storage_bytes: [...snapshots.values()].reduce(
        (a, b) => a + b,
        0,
      ),
      active_holds: holds.length,
      snapshots: snapshots.size,
    };
  }
}
