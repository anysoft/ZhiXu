import { createHash } from 'crypto';
import { fail } from '../services/workspaceV2/errors';
import { objectJson, requestIdentity } from '../services/workspaceV2/lifecycle';
import type { OperationRow } from '../services/workspaceV2/types';
import type { V2Services } from './types';

/** One active WorkspaceOperation already owns recovery. The alias is an admission
 * receipt on that operation, never a second owner, status or recovery queue. */
export async function resumeWorkspaceOperation(
  s: V2Services,
  workspaceId: number,
  expectedVersion: number,
  requestKey: string,
) {
  const request = requestIdentity(requestKey, {
    operation: 'RECOVER',
    workspace_id: workspaceId,
    expected_version: expectedVersion,
  });
  const keyHash = createHash('sha256').update(request.key).digest('hex');
  const operation = await s.leases.withWorkspace(
    workspaceId,
    'RECOVER_ADMISSION',
    async (lease) =>
      s.store.transaction(async (tx) => {
        const workspace = await tx.workspace(workspaceId);
        if (workspace.storage_state === 'PRESENT')
          await s.roots
            .requireOwned(workspace)
            .catch(() => fail('WORKSPACE_RECOVERY_REQUIRED'));
        const prior = (
          await tx.all<OperationRow>(
            `SELECT o.* FROM WorkspaceOperations o WHERE
      o.request_key=? OR EXISTS(SELECT 1 FROM json_each(json_extract(o.root_marker,'$.recovery_requests')) alias
      WHERE json_extract(alias.value,'$.key_hash')=?)`,
            [request.key, keyHash],
          )
        )[0];
        if (prior) {
          const aliases = objectJson(prior.root_marker).recovery_requests;
          if (!Array.isArray(aliases)) fail('IDEMPOTENCY_KEY_CONFLICT');
          const receipt = aliases.find(
            (item) =>
              item && typeof item === 'object' && item.key_hash === keyHash,
          );
          if (
            !receipt ||
            prior.workspace_id !== workspaceId ||
            receipt.workspace_id !== workspaceId ||
            receipt.expected_version !== expectedVersion ||
            receipt.request_hash !== request.hash ||
            receipt.operation_id !== prior.id
          )
            fail('IDEMPOTENCY_KEY_CONFLICT');
          if (receipt.source_generation !== workspace.source_generation)
            fail('SOURCE_SUPERSEDED');
          return prior;
        }
        if (workspace.version !== expectedVersion)
          fail('WORKSPACE_VERSION_CONFLICT');
        if (!['ERROR', 'RECOVERY_REQUIRED'].includes(workspace.lifecycle_state))
          fail('WORKSPACE_NOT_READY');
        const op = (
          await tx.all<OperationRow>(
            "SELECT * FROM WorkspaceOperations WHERE workspace_id=? AND status IN ('PENDING','RUNNING','DRAINING','RECOVERY_REQUIRED') ORDER BY submitted_at,id LIMIT 1",
            [workspaceId],
          )
        )[0];
        if (
          !op ||
          ![
            'CREATE',
            'ARCHIVE',
            'UNARCHIVE',
            'FILE_MUTATION',
            'DELETE_RECLAIM',
          ].includes(op.operation_type)
        )
          fail('WORKSPACE_RECOVERY_REQUIRED');
        const marker = objectJson(op.root_marker),
          aliases = marker.recovery_requests ?? [];
        if (!Array.isArray(aliases) || aliases.length >= 32)
          fail('WORKSPACE_RECOVERY_REQUIRED');
        await lease.assertHeld();
        const updated = JSON.stringify({
          ...marker,
          recovery_requests: [
            ...aliases,
            {
              key_hash: keyHash,
              request_hash: request.hash,
              workspace_id: workspaceId,
              source_generation: workspace.source_generation,
              expected_version: expectedVersion,
              operation_id: op.id,
              accepted_at: new Date().toISOString(),
            },
          ],
        });
        if (
          !(
            await tx.run(
              'UPDATE WorkspaceOperations SET root_marker=? WHERE id=? AND root_marker=? AND status=?',
              [updated, op.id, op.root_marker, op.status],
            )
          ).changes
        )
          fail('WORKSPACE_VERSION_CONFLICT');
        return { ...op, root_marker: updated };
      }),
  );
  if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(operation.status))
    return s.lifecycle.operation(operation.id);
  if (operation.operation_type === 'FILE_MUTATION')
    await s.files.recover(workspaceId);
  else if (operation.operation_type === 'DELETE_RECLAIM')
    await s.reclaim.recover(workspaceId);
  else await s.lifecycle.recover(workspaceId);
  return s.lifecycle.operation(operation.id);
}
