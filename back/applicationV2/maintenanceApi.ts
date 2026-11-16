import type { RouteMap, V2Services } from './types';
import { StorageMaintenance } from '../services/storageMaintenance';
import { object, text } from './taskValidation';

/** Authenticated application maintenance; the service owns preview, locks and deletion boundaries. */
export function maintenanceApiRoutes(
  s: V2Services,
  maintenance: StorageMaintenance,
): RouteMap {
  return {
    'GET /maintenance/settings': async ({ query }) => {
      object(query, []);
      return maintenance.getSettings();
    },
    'PUT /maintenance/settings': async ({ body }) =>
      maintenance.saveSettings(
        object(body, [
          'auto_enabled',
          'task_days',
          'runtime_days',
          'cache_days',
        ]),
      ),
    'GET /maintenance/usage': async ({ query }) => {
      object(query, []);
      return maintenance.usage();
    },
    'POST /maintenance/preview': async ({ body }) =>
      maintenance.preview(
        object(body, [
          'kind',
          'from',
          'to',
          'ids',
          'mode',
          'status',
          'workspace_id',
          'task_id',
        ]),
      ),
    'POST /maintenance/clean': async ({ body }) => {
      const input = object(body, ['preview_id'], ['preview_id']);
      return maintenance.clean({ preview_id: text(input.preview_id, 100) });
    },
  };
}
