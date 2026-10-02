import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Space, Typography } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
export function TaskResourceReferences({
  kind,
  id,
  onBlocked,
}: {
  kind: 'python' | 'node' | 'worktree' | 'repository';
  id: number;
  onBlocked?: (blocked: boolean) => void;
}) {
  useI18nLocale();
  const [references, setReferences] = useState<any>();
  const load = async () => {
    const response = await request.get(
      `${config.apiPrefix}task-resources/${kind}/${id}/references`,
    );
    if (response.code === 200) {
      setReferences(response.data);
      onBlocked?.(response.data.tasks_count + response.data.defaults_count > 0);
    }
  };
  useEffect(() => {
    setReferences(undefined);
    onBlocked?.(true);
    load().catch(() => {});
  }, [kind, id]);
  return (
    <Card
      size="small"
      title={tr('ui.template.usedByTasksValue', {
        p0: references?.tasks_count ?? '…',
      })}
      extra={
        <Button size="small" onClick={load}>
          {tr('ui.refreshReferences')}
        </Button>
      }
    >
      <Space direction="vertical">
        {references?.tasks.map((task: any) => (
          <Typography.Link
            key={task.id}
            href={`${config.baseUrl}tasks?task_id=${task.id}`}
          >
            {task.name} {tr('ui.taskVariant411')} {task.id}
          </Typography.Link>
        ))}
        {references?.defaults.map((binding: any) => (
          <span key={binding.id}>
            {binding.repository_id
              ? tr('ui.presentation.repositoryId', {
                  id: binding.repository_id,
                })
              : tr('ui.presentation.subscriptionId', {
                  id: binding.subscription_id,
                })}{' '}
            {tr('ui.runtimeDefault')} {binding.kind}
          </span>
        ))}
        {references &&
          references.tasks_count + references.defaults_count > 0 && (
            <Alert
              type="info"
              message={tr(
                'ui.deletionIsProtectedRemoveTaskAndRuntimeDefaultReferencesFirst',
              )}
            />
          )}
      </Space>
    </Card>
  );
}
