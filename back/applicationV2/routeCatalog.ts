/** Auditable controller and domain ownership, paired with actual Express registration. */
export function serviceForRoute(controller: string, route: string) {
  if (controller === 'workspaceApiRoutes')
    return route.includes('/files') ||
      route.includes('/directories') ||
      route.includes('/search')
      ? 'WorkspaceFileService'
      : route.includes('reclaim')
      ? 'WorkspaceReclaimService + WorkspacePreservationService'
      : 'WorkspaceLifecycleService + WorkspaceStore';
  if (controller === 'gitApiRoutes')
    return route.includes('discovery')
      ? 'GitWorkspaceDiscovery'
      : route.includes('sync')
      ? 'GitWorkspaceSyncService + WorkspaceSyncScheduler'
      : route.includes('trigger')
      ? 'WorkspaceGitUpdateTriggers'
      : 'WorkspaceGitAdapter + CandidateGitResources';
  if (controller === 'repositoryApiRoutes') return 'CandidateGitResources';
  if (controller === 'taskApiRoutes')
    return /(?:task-runs|\/run|\/stop|\/runs|\/logs)/.test(route)
      ? 'TaskExecutionService'
      : 'TaskService + TaskResourceResolver';
  if (controller === 'resourceApiRoutes')
    return route.includes('config-assets')
      ? 'CandidateConfigAssets'
      : route.includes('config') || route.includes('hooks')
      ? 'WorkspaceStore + Config DTO adapters'
      : 'WorkspaceEnvironmentService + TaskResourceResolver';
  if (controller === 'triggerApiRoutes') return 'CandidateTaskTriggers';
  if (controller === 'runtimeApiRoutes')
    return 'CandidateRuntimeDomain + RuntimeOperationService + PythonEnvironmentService + NodeEnvironmentService';
  if (controller === 'CandidateNotificationDomain.routes')
    return 'CandidateNotificationDomain + NotificationService';
  if (controller === 'registerBackupApi')
    return 'WorkspaceBackupService + WorkspaceRestoreService + BackupOperations';
  if (controller === 'V2PanelAuth + registerRetainedApi')
    return 'V2PanelAuth + WorkspaceStore';
  return 'V2Application + WorkspaceStore';
}
export const extensionReasons: Record<string, string> = {
  'GET /system/git-identity':
    'Read the real CAS version before the frozen identity update.',
  'POST /tasks/:id/restore-discovered':
    'Explicitly restore a returned discovered source without enabling its Task.',
  'GET /backups/usage':
    'Expose real preservation quota and retained storage usage.',
  'GET /restores/:id/preview':
    'Present validated restore effects before confirmation.',
  'GET /backups/:id/preservation': 'Expose actual preservation holds.',
};
export function retainedDtoForRoute(
  controller: string,
  route: string,
  method: string,
) {
  const noBody = method === 'GET' || method === 'HEAD';
  if (controller === 'runtimeApiRoutes')
    return {
      request_dto: noBody
        ? 'NONE'
        : 'back/applicationV2/runtimeApi.ts#options + retained Python/Node validators',
      response_dto: route.includes('/operations')
        ? 'back/api/runtime.ts#operationDto + publicRuntimeValue'
        : 'back/applicationV2/runtimeApi.ts#publicRuntimeValue',
    };
  if (controller === 'CandidateNotificationDomain.routes')
    return {
      request_dto: noBody
        ? 'NONE'
        : route.includes('/notification-policy')
        ? 'CandidateNotificationDomain.savePolicy'
        : route.includes('/notification-channels')
        ? 'CandidateNotificationDomain.save/test'
        : 'CandidateNotificationDomain.retry/notifySystem',
      response_dto: route.includes('/notification-policy')
        ? 'CandidateNotificationDomain.policy'
        : route.includes('/notification-channels')
        ? 'CandidateNotificationDomain.channelDto'
        : 'CandidateNotificationDomain.routes explicit SQL projection',
    };
  if (controller === 'registerBackupApi')
    return {
      request_dto: noBody
        ? 'NONE'
        : 'back/applicationV2/backupApi.ts#body/phrase + bounded multipart',
      response_dto: route.includes('/operations')
        ? 'back/services/backup/operations.ts#BackupOperations.get'
        : route.includes('/download')
        ? 'Encrypted portable archive bytes'
        : route.includes('/restore')
        ? 'back/applicationV2/backupApi.ts#status/restore preview'
        : 'back/applicationV2/backupApi.ts#publicManifest/usage',
    };
  if (controller === 'taskApiRoutes')
    return {
      request_dto: noBody
        ? 'NONE'
        : 'back/applicationV2/taskApi.ts#taskApiRoutes validators',
      response_dto: 'back/applicationV2/taskApi.ts#taskDto/runDto',
    };
  if (controller === 'gitApiRoutes')
    return {
      request_dto: noBody
        ? 'NONE'
        : 'back/applicationV2/gitApi.ts#gitApiRoutes validators',
      response_dto: 'back/applicationV2/gitApi.ts#identity/syncDto',
    };
  if (route.includes('/user/notification') && method === 'PUT')
    return {
      request_dto: 'NONE',
      response_dto: 'Error<NOTIFICATION_CHANNEL_API_REQUIRED>',
    };
  if (route.includes('/storage-retention/'))
    return {
      request_dto:
        'back/applicationV2/retainedApi.ts#retention request validators',
      response_dto: 'Error<SUBSCRIPTION_RETENTION_RETIRED>',
    };
  return {
    request_dto: noBody
      ? 'NONE'
      : route.startsWith('/hooks/')
      ? 'CandidateTaskTriggers.authenticateWebhook/receiveWebhook'
      : 'back/applicationV2/retainedApi.ts + V2PanelAuth strict validators',
    response_dto: route.startsWith('/hooks/')
      ? 'CandidateTaskTriggers.receiveWebhook'
      : route.includes('/system/log')
      ? 'Owned bounded system log bytes'
      : route.includes('/user')
      ? 'V2PanelAuth.current/login/initialize + retained account projections'
      : 'back/applicationV2/application.ts#wireHttp + retained settings projections',
  };
}
