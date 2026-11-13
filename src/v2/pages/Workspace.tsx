import React, { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from '@umijs/max';
import {
  Alert,
  Button,
  Card,
  Modal,
  Space,
  Table,
  Tabs,
  Typography,
} from 'antd';
import { list, useResource, WorkspaceDto } from '../api';
import {
  Details,
  ErrorPanel,
  Fingerprint,
  Page,
  Reload,
  State,
} from '../components';
import { useText } from '../i18n';
import { WorkspaceFiles } from '../features/Files';
import {
  ConfigBindings,
  EnvironmentPanel,
  RuntimeDefaults,
} from '../features/Resources';
import { Discovery, GitPanel, SyncHistory, SyncPolicy } from '../features/Git';
export default function WorkspacePage() {
  const id = Number(useParams().id),
    t = useText(),
    location = useLocation(),
    search = new URLSearchParams(location.search),
    data = useResource<WorkspaceDto>(`/workspaces/${id}`, 2500),
    [tab, setTab] = useState(search.get('tab') || 'overview'),
    [dirty, setDirty] = useState(false);
  const operationId = search.get('operation'),
    operation = useResource(
      operationId
        ? `/workspaces/${id}/operations/${encodeURIComponent(operationId)}`
        : null,
      2000,
    ),
    tasks = useResource(`/tasks?workspace_id=${id}&size=200`);
  const ws = data.data,
    changed = () => {
      void data.reload();
      void tasks.reload();
    };
  const changeTab = (value: string) =>
    dirty
      ? Modal.confirm({
          title: t('discardTitle'),
          content: t('discardHelp'),
          okText: t('confirm'),
          cancelText: t('cancel'),
          onOk: () => {
            setDirty(false);
            setTab(value);
          },
        })
      : setTab(value);
  useEffect(() => {
    const next = new URLSearchParams(location.search).get('tab');
    if (next && next !== tab) changeTab(next);
  }, [location.search]);
  return (
    <Page
      title={ws?.name || t('workspaceId', { id })}
      subtitle={
        ws ? (
          <Space>
            <State value={ws.type} />
            <State value={ws.lifecycle_state} />
            <State value={ws.storage_state} />
            <Typography.Text type="secondary">#{id}</Typography.Text>
          </Space>
        ) : undefined
      }
      actions={
        <>
          <Link to="/workspaces">
            <Button>{t('back')}</Button>
          </Link>
          <Reload onClick={() => void data.reload()} loading={data.loading} />
        </>
      }
    >
      <ErrorPanel error={data.error || operation.error} />
      {operation.data && (
        <Alert
          className="v2-error"
          showIcon
          type={operation.data.status === 'FAILED' ? 'error' : 'info'}
          message={
            <Space>
              {t('operationId')}
              <Typography.Text code>{operation.data.id}</Typography.Text>
              <State value={operation.data.status} />
            </Space>
          }
          description={operation.data.error_code || operation.data.phase}
        />
      )}
      {ws && (
        <Tabs
          activeKey={tab}
          onChange={changeTab}
          destroyInactiveTabPane
          items={[
            {
              key: 'overview',
              label: t('overview'),
              children: (
                <Card>
                  <Details
                    values={[
                      ['type', <State value={ws.type} />],
                      ['version', ws.version],
                      ['sourceGeneration', ws.source_generation],
                      ['contentRevision', ws.content_revision],
                      [
                        'inventoryHash',
                        <Fingerprint value={ws.content_inventory_hash} />,
                      ],
                      ['tasks', ws.task_count],
                      ...(ws.git
                        ? ([
                            [
                              'repository',
                              <Link to="/repository">
                                #{ws.git.repository_id}
                              </Link>,
                            ],
                            ['refName', ws.git.ref_name],
                            [
                              'currentCommit',
                              <Fingerprint
                                value={
                                  ws.git.last_verified_commit ||
                                  ws.git.applied_commit ||
                                  ws.git.resolved_commit
                                }
                              />,
                            ],
                          ] as Array<[string, any]>)
                        : []),
                    ]}
                  />
                </Card>
              ),
            },
            {
              key: 'files',
              label: t('files'),
              children: (
                <WorkspaceFiles
                  key={id}
                  workspace={ws}
                  onChanged={changed}
                  onDirty={setDirty}
                />
              ),
            },
            {
              key: 'tasks',
              label: t('tasks'),
              children: (
                <>
                  <Link to={`/tasks?workspace_id=${id}`}>
                    <Button
                      type="primary"
                      disabled={!ws.capabilities.create_task}
                    >
                      {t('newTask')}
                    </Button>
                  </Link>
                  <ErrorPanel error={tasks.error} />
                  <Table
                    className="v2-section"
                    rowKey="id"
                    dataSource={list(tasks.data)}
                    pagination={false}
                    columns={[
                      {
                        title: t('name'),
                        dataIndex: 'name',
                        render: (value, row: any) => (
                          <Link to={`/tasks/${row.id}`}>{value}</Link>
                        ),
                      },
                      {
                        title: t('entrypoint'),
                        render: (_, row: any) =>
                          row.source?.relative_entrypoint,
                      },
                      {
                        title: t('language'),
                        render: (_, row: any) => (
                          <State value={row.source?.language} />
                        ),
                      },
                      {
                        title: t('status'),
                        render: (_, row: any) => (
                          <State value={row.enabled ? 'enabled' : 'disabled'} />
                        ),
                      },
                    ]}
                  />
                </>
              ),
            },
            {
              key: 'runtime',
              label: t('runtime'),
              children: <RuntimeDefaults workspace={ws} onChanged={changed} />,
            },
            {
              key: 'environment',
              label: t('environment'),
              children: (
                <EnvironmentPanel
                  scope="workspaces"
                  id={id}
                  editable={ws.capabilities.write_files}
                  onChanged={changed}
                />
              ),
            },
            {
              key: 'config',
              label: t('config'),
              children: (
                <ConfigBindings
                  scope="workspaces"
                  id={id}
                  editable={ws.capabilities.write_files}
                  onChanged={changed}
                />
              ),
            },
            ...(ws.type === 'GIT'
              ? [
                  {
                    key: 'git',
                    label: t('git'),
                    children: <GitPanel workspace={ws} onChanged={changed} />,
                  },
                  {
                    key: 'sync-policy',
                    label: t('syncPolicy'),
                    children: <SyncPolicy workspace={ws} />,
                  },
                  {
                    key: 'sync-history',
                    label: t('syncHistory'),
                    children: <SyncHistory workspace={ws} />,
                  },
                  {
                    key: 'discovery',
                    label: t('discovery'),
                    children: <Discovery workspace={ws} onChanged={changed} />,
                  },
                ]
              : []),
          ]}
        />
      )}
    </Page>
  );
}
