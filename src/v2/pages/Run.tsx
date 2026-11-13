import React from 'react';
import { useParams, Link } from '@umijs/max';
import { Alert, Button, Card, Space, Table, Tabs, Typography } from 'antd';
import { call, list, useAction, useResource } from '../api';
import {
  Details,
  ErrorPanel,
  Fingerprint,
  Page,
  Reload,
  State,
  Time,
} from '../components';
import { useText, diagnostic } from '../i18n';
import { Logs } from '../features/Logs';
function ResourceSnapshot({ value }: { value: any }) {
  const t = useText();
  if (!value) return null;
  const runtimes = [
    ['PYTHON', value.python],
    ['NODE', value.node],
  ].filter(([, v]) => v);
  return (
    <>
      <Typography.Title level={5}>{t('resourceSnapshot')}</Typography.Title>
      <Details
        values={[
          ['globalVersion', value.global_env_version],
          [
            'profile',
            value.profile
              ? `#${value.profile.id} · v${value.profile.version}`
              : '—',
          ],
        ]}
      />
      <Table
        className="v2-section"
        rowKey="kind"
        pagination={false}
        dataSource={runtimes.map(([kind, row]: any) => ({ kind, ...row }))}
        columns={[
          {
            title: t('type'),
            dataIndex: 'kind',
            render: (v) => <State value={v} />,
          },
          { title: t('environment'), dataIndex: 'environment_id' },
          { title: t('assetRevision'), dataIndex: 'revision_id' },
          { title: t('build'), dataIndex: 'build_id' },
          { title: t('runtime'), dataIndex: 'runtime_id' },
          { title: t('toolchain'), dataIndex: 'toolchain_id' },
        ]}
      />
      <Table
        rowKey={(r: any) => `${r.binding_id}:${r.revision_id}`}
        pagination={false}
        dataSource={value.config_revisions || []}
        columns={[
          { title: t('asset'), dataIndex: 'asset_id' },
          { title: t('assetRevision'), dataIndex: 'revision_id' },
          { title: t('configBindings'), dataIndex: 'binding_id' },
          { title: t('version'), dataIndex: 'binding_version' },
        ]}
      />
    </>
  );
}
export default function RunPage() {
  const id = Number(useParams().id),
    t = useText(),
    data = useResource(`/task-runs/${id}`, 1500),
    attempts = useResource(`/task-runs/${id}/attempts`, 2500),
    events = useResource(`/task-runs/${id}/events`, 2500),
    action = useAction();
  const row = data.data,
    snapshot = row?.source_snapshot;
  return (
    <Page
      title={t('runId', { id })}
      actions={
        <>
          <Reload onClick={() => void data.reload()} loading={data.loading} />
          {row && ['QUEUED', 'RESOLVING', 'RUNNING'].includes(row.status) && (
            <Button
              danger
              loading={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await call(`/task-runs/${id}/cancel`, {
                    method: 'POST',
                    body: {},
                  });
                  await data.reload();
                })
              }
            >
              {t('stop')}
            </Button>
          )}
        </>
      }
    >
      <ErrorPanel error={data.error || action.error} />
      {row && (
        <>
          <Card>
            <Details
              values={[
                ['status', <State value={row.status} />],
                [
                  'task',
                  row.task_id ? (
                    <Link to={`/tasks/${row.task_id}`}>#{row.task_id}</Link>
                  ) : (
                    '—'
                  ),
                ],
                [
                  'workspace',
                  <Link to={`/workspaces/${row.workspace_id}`}>
                    #{row.workspace_id}
                  </Link>,
                ],
                ['started', <Time value={row.started_at} />],
                ['finished', <Time value={row.finished_at} />],
                ['attempts', row.attempt_count],
                ['queueReason', row.queue?.reason],
                ['concurrency', <State value={row.concurrency_policy} />],
              ]}
            />
            {row.error_code && (
              <Alert
                className="v2-section"
                showIcon
                type={row.status === 'SKIPPED' ? 'warning' : 'error'}
                message={diagnostic(row.error_code)}
                description={row.error_code}
              />
            )}
          </Card>
          <Tabs
            className="v2-section"
            items={[
              {
                key: 'logs',
                label: t('logs'),
                children: <Logs path={`/task-runs/${id}/log`} />,
              },
              {
                key: 'snapshot',
                label: t('sourceSnapshot'),
                children: (
                  <Card>
                    {snapshot ? (
                      <>
                        <Details
                          values={[
                            ['type', <State value={snapshot.workspace_type} />],
                            ['sourceGeneration', snapshot.source_generation],
                            ['contentRevision', snapshot.content_revision],
                            ['entrypoint', snapshot.relative_entrypoint],
                            ['cwd', <State value={snapshot.cwd_mode} />],
                            [
                              'historicalCommit',
                              <Fingerprint value={snapshot.git?.commit} />,
                            ],
                            [
                              'inventoryHash',
                              <Fingerprint value={snapshot.inventory_hash} />,
                            ],
                            ['version', snapshot.task_definition_version],
                          ]}
                        />
                        <ResourceSnapshot
                          value={snapshot.effective_resource_versions}
                        />
                      </>
                    ) : (
                      <Alert type="info" message={t('noScriptExecuted')} />
                    )}
                  </Card>
                ),
              },
              {
                key: 'attempts',
                label: t('attempts'),
                children: (
                  <>
                    <ErrorPanel error={attempts.error} />
                    <Table
                      rowKey="id"
                      pagination={false}
                      dataSource={list(attempts.data)}
                      columns={[
                        { title: t('id'), dataIndex: 'id' },
                        { title: t('attempts'), dataIndex: 'attempt_number' },
                        {
                          title: t('status'),
                          dataIndex: 'status',
                          render: (value) => <State value={value} />,
                        },
                        { title: t('diagnostics'), dataIndex: 'error_code' },
                      ]}
                    />
                  </>
                ),
              },
              {
                key: 'events',
                label: t('events'),
                children: (
                  <>
                    <ErrorPanel error={events.error} />
                    <Table
                      rowKey="sequence"
                      pagination={false}
                      dataSource={events.data?.events || []}
                      columns={[
                        { title: t('position'), dataIndex: 'sequence' },
                        { title: t('type'), dataIndex: 'type' },
                        {
                          title: t('details'),
                          dataIndex: 'safe_metadata',
                          render: (value) => (
                            <code>{JSON.stringify(value)}</code>
                          ),
                        },
                      ]}
                    />
                  </>
                ),
              },
            ]}
          />
        </>
      )}
    </Page>
  );
}
