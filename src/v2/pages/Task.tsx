import React, { useState } from 'react';
import { Link, history, useParams } from '@umijs/max';
import { Alert, Button, Card, Form, Input, Space, Table, Tabs } from 'antd';
import { call, list, useAction, useResource } from '../api';
import {
  Details,
  ErrorPanel,
  FormDialog,
  Page,
  Reload,
  State,
  Time,
  required,
} from '../components';
import { useText } from '../i18n';
import { TaskEditor } from '../features/TaskEditor';
import { ConfigBindings, EnvironmentPanel, Hooks } from '../features/Resources';
import { Triggers } from '../features/Triggers';
import { RunButton } from './Tasks';
import { NotificationPolicy } from './Notifications';
function Health({ id }: { id: number }) {
  const t = useText(),
    health = useResource(`/tasks/${id}/health`, 5000),
    stats = useResource(`/tasks/${id}/stats`, 5000);
  return (
    <Card className="v2-section" title={t('health')}>
      <ErrorPanel error={health.error || stats.error} />
      <Details
        values={[
          ['consecutiveFailures', health.data?.consecutive_failures],
          [
            'lastRun',
            health.data?.last_run_id ? (
              <Link to={`/runs/${health.data.last_run_id}`}>
                #{health.data.last_run_id}
              </Link>
            ) : (
              '—'
            ),
          ],
          ['total', stats.data?.total],
          ['status.SUCCESS', stats.data?.success],
          ['status.FAILED', stats.data?.failed],
          ['status.SKIPPED', stats.data?.skipped],
        ]}
      />
    </Card>
  );
}
export default function TaskPage() {
  const id = Number(useParams().id),
    t = useText(),
    data = useResource(`/tasks/${id}`),
    runs = useResource(`/tasks/${id}/runs?size=50`, 3000),
    action = useAction(),
    [editing, setEditing] = useState(false),
    [cloning, setCloning] = useState(false),
    [readiness, setReadiness] = useState<any>();
  const row = data.data,
    workspace = useResource(
      row ? `/workspaces/${row.source.workspace_id}` : null,
    ),
    editable = workspace.data?.lifecycle_state === 'READY';
  const changed = () => {
    void data.reload();
    setReadiness(undefined);
  };
  return (
    <Page
      title={row?.name || t('taskId', { id })}
      subtitle={
        row ? (
          <Space>
            <State value={row.source.language} />
            <State value={row.enabled ? 'enabled' : 'disabled'} />
            <code>{row.source.relative_entrypoint}</code>
          </Space>
        ) : undefined
      }
      actions={
        <>
          <Reload onClick={() => void data.reload()} />
          {row && (
            <>
              <Button disabled={!editable} onClick={() => setEditing(true)}>
                {t('edit')}
              </Button>
              <Button disabled={!editable} onClick={() => setCloning(true)}>
                {t('clone')}
              </Button>
              <RunButton
                id={id}
                disabled={
                  !workspace.data?.capabilities.run_task ||
                  row.discovery_state === 'RETIRED'
                }
              />
            </>
          )}
        </>
      }
    >
      <ErrorPanel error={data.error || workspace.error || action.error} />
      {row && (
        <Tabs
          items={[
            {
              key: 'overview',
              label: t('overview'),
              children: (
                <>
                  <Card>
                    <Details
                      values={[
                        ['description', row.description],
                        [
                          'workspace',
                          <Link to={`/workspaces/${row.source.workspace_id}`}>
                            #{row.source.workspace_id}
                          </Link>,
                        ],
                        ['entrypoint', row.source.relative_entrypoint],
                        ['cwd', <State value={row.source.cwd_mode} />],
                        ['version', row.version],
                        [
                          'concurrency',
                          <State value={row.execution.concurrency} />,
                        ],
                        ['maxAttempts', row.execution.max_attempts],
                        ['source', <State value={row.origin} />],
                      ]}
                    />
                    <Alert
                      className="v2-section"
                      type="info"
                      message={t('readinessHelp')}
                    />
                    <Button
                      className="v2-section"
                      loading={action.busy}
                      onClick={() =>
                        void action.run(async () =>
                          setReadiness(await call(`/tasks/${id}/resources`)),
                        )
                      }
                    >
                      {t('validate')}
                    </Button>
                    {readiness && (
                      <>
                        <State value={readiness.status} />
                        <Table
                          rowKey={(_, index) => String(index)}
                          pagination={false}
                          dataSource={readiness.diagnostics || []}
                          columns={[
                            { title: t('diagnostics'), dataIndex: 'code' },
                            { title: t('type'), dataIndex: 'resource_type' },
                            { title: t('id'), dataIndex: 'resource_id' },
                          ]}
                        />
                      </>
                    )}
                  </Card>
                  <Health id={id} />
                </>
              ),
            },
            {
              key: 'triggers',
              label: t('triggers'),
              children: (
                <Triggers
                  task={row}
                  workspace={workspace.data}
                  onChanged={changed}
                />
              ),
            },
            {
              key: 'env',
              label: t('environment'),
              children: (
                <EnvironmentPanel
                  scope="tasks"
                  id={id}
                  editable={editable}
                  onChanged={changed}
                />
              ),
            },
            {
              key: 'config',
              label: t('configBindings'),
              children: (
                <ConfigBindings
                  scope="tasks"
                  id={id}
                  editable={editable}
                  onChanged={changed}
                />
              ),
            },
            {
              key: 'hooks',
              label: t('hooks'),
              children: (
                <Hooks task={row} editable={editable} onChanged={changed} />
              ),
            },
            {
              key: 'notifications',
              label: t('notifications'),
              children: <NotificationPolicy taskId={id} />,
            },
            {
              key: 'runs',
              label: t('runs'),
              children: (
                <>
                  <ErrorPanel error={runs.error} />
                  <Table
                    rowKey="id"
                    pagination={false}
                    dataSource={list(runs.data)}
                    columns={[
                      {
                        title: t('id'),
                        dataIndex: 'id',
                        render: (value) => (
                          <Link to={`/runs/${value}`}>#{value}</Link>
                        ),
                      },
                      {
                        title: t('status'),
                        dataIndex: 'status',
                        render: (value) => <State value={value} />,
                      },
                      {
                        title: t('started'),
                        dataIndex: 'started_at',
                        render: (value) => <Time value={value} />,
                      },
                      { title: t('attempts'), dataIndex: 'attempt_count' },
                      { title: t('diagnostics'), dataIndex: 'error_code' },
                    ]}
                  />
                </>
              ),
            },
          ]}
        />
      )}
      {cloning && (
        <FormDialog
          title={t('clone')}
          initial={{ name: row.name }}
          onClose={() => setCloning(false)}
          onSubmit={async (v) => {
            const next = await call(`/tasks/${id}/clone`, {
              method: 'POST',
              body: { name: v.name, expected_version: row.version },
            });
            history.push(`/tasks/${next.id}`);
            await data.reload();
          }}
        >
          <Form.Item name="name" label={t('name')} rules={[required()]}>
            <Input />
          </Form.Item>
        </FormDialog>
      )}
      {editing && (
        <TaskEditor
          task={row}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            changed();
          }}
        />
      )}
    </Page>
  );
}
