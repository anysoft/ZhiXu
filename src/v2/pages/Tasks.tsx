import React, { useRef, useState } from 'react';
import { Link, history, useLocation } from '@umijs/max';
import { Button, Popconfirm, Select, Space, Table } from 'antd';
import { call, list, query, requestKey, useAction, useResource } from '../api';
import { ErrorPanel, Page, Reload, State, enumOptions } from '../components';
import { useText } from '../i18n';
import { TaskEditor } from '../features/TaskEditor';
export function RunButton({
  id,
  disabled = false,
}: {
  id: number;
  disabled?: boolean;
}) {
  const t = useText(),
    action = useAction(),
    key = useRef(requestKey());
  return (
    <>
      <Button
        type="primary"
        size="small"
        disabled={disabled}
        loading={action.busy}
        onClick={() =>
          void action.run(async () => {
            const run = await call(`/tasks/${id}/run`, {
              method: 'POST',
              body: { wait_mode: 'WAIT' },
              key: key.current,
            });
            key.current = requestKey();
            history.push(`/runs/${run.id}`);
          })
        }
      >
        {t('execute')}
      </Button>
      <ErrorPanel error={action.error} />
    </>
  );
}
export default function TasksPage() {
  const t = useText(),
    search = new URLSearchParams(useLocation().search),
    [workspace, setWorkspace] = useState<number | undefined>(
      Number(search.get('workspace_id')) || undefined,
    ),
    [type, setType] = useState<string>(),
    [enabled, setEnabled] = useState<string>(),
    [language, setLanguage] = useState<string>(),
    [page, setPage] = useState(1),
    [editing, setEditing] = useState<any>(
      search.has('entrypoint') ? {} : undefined,
    ),
    action = useAction();
  const data = useResource(
      query('/tasks', {
        page,
        size: 20,
        workspace_id: workspace,
        workspace_type: type,
        enabled,
        language,
      }),
      3000,
    ),
    workspaces = useResource('/workspaces?size=200');
  const rows = list(data.data);
  return (
    <Page
      title={t('tasks')}
      actions={
        <>
          <Reload onClick={() => void data.reload()} loading={data.loading} />
          <Button type="primary" onClick={() => setEditing({})}>
            {t('newTask')}
          </Button>
        </>
      }
    >
      <div className="v2-toolbar">
        <Space wrap>
          <Select
            value={workspace}
            allowClear
            placeholder={t('workspace')}
            style={{ width: 240 }}
            options={list(workspaces.data).map((item: any) => ({
              value: item.id,
              label: item.name,
            }))}
            onChange={(value) => {
              setWorkspace(value);
              setPage(1);
            }}
          />
          <Select
            value={type}
            allowClear
            placeholder={t('type')}
            style={{ width: 140 }}
            options={enumOptions(['LOCAL', 'GIT'])}
            onChange={(value) => {
              setType(value);
              setPage(1);
            }}
          />
          <Select
            value={enabled}
            allowClear
            placeholder={t('status')}
            style={{ width: 150 }}
            options={[
              { value: 'true', label: t('enabled') },
              { value: 'false', label: t('disabled') },
            ]}
            onChange={(value) => {
              setEnabled(value);
              setPage(1);
            }}
          />
          <Select
            value={language}
            allowClear
            placeholder={t('language')}
            style={{ width: 230 }}
            options={enumOptions([
              'PYTHON',
              'JAVASCRIPT',
              'TYPESCRIPT',
              'SHELL',
            ])}
            onChange={(value) => {
              setLanguage(value);
              setPage(1);
            }}
          />
        </Space>
      </div>
      <ErrorPanel error={data.error || action.error} />
      <Table
        rowKey="id"
        dataSource={rows}
        loading={data.loading && !data.data}
        pagination={{
          current: page,
          pageSize: 20,
          total: data.data?.total || 0,
          onChange: setPage,
        }}
        columns={[
          {
            title: t('name'),
            dataIndex: 'name',
            render: (value, row: any) => (
              <Link to={`/tasks/${row.id}`}>{value}</Link>
            ),
          },
          {
            title: t('workspace'),
            render: (_, row: any) => (
              <Link to={`/workspaces/${row.source?.workspace_id}`}>
                #{row.source?.workspace_id}
              </Link>
            ),
          },
          {
            title: t('entrypoint'),
            render: (_, row: any) => (
              <code>{row.source?.relative_entrypoint}</code>
            ),
          },
          {
            title: t('language'),
            render: (_, row: any) => <State value={row.source?.language} />,
          },
          {
            title: t('status'),
            render: (_, row: any) => (
              <Space>
                <State value={row.enabled ? 'enabled' : 'disabled'} />
                {row.discovery_state === 'RETIRED' && <State value="RETIRED" />}
              </Space>
            ),
          },
          {
            title: t('actions'),
            render: (_, row: any) => (
              <Space wrap>
                {row.discovery_state === 'RETIRED' && (
                  <Button
                    size="small"
                    onClick={() =>
                      void action.run(async () => {
                        await call(`/tasks/${row.id}/restore-discovered`, {
                          method: 'POST',
                          body: { expected_version: row.version },
                        });
                        await data.reload();
                      })
                    }
                  >
                    {t('restoreTask')}
                  </Button>
                )}
                <RunButton
                  id={row.id}
                  disabled={row.discovery_state === 'RETIRED'}
                />
                <Button
                  size="small"
                  onClick={() =>
                    void action.run(async () =>
                      setEditing(await call('/tasks/' + row.id)),
                    )
                  }
                >
                  {t('edit')}
                </Button>
                <Button
                  size="small"
                  onClick={() =>
                    void action.run(async () => {
                      await call(`/tasks/${row.id}/enabled`, {
                        method: 'PUT',
                        body: {
                          enabled: !row.enabled,
                          expected_version: row.version,
                        },
                      });
                      await data.reload();
                    })
                  }
                >
                  {t(row.enabled ? 'disable' : 'enable')}
                </Button>
                <Popconfirm
                  title={t('confirmDelete')}
                  onConfirm={() =>
                    action.run(async () => {
                      await call(`/tasks/${row.id}`, {
                        method: 'DELETE',
                        body: { expected_version: row.version },
                      });
                      await data.reload();
                    })
                  }
                >
                  <Button size="small" danger>
                    {t('delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      {editing && (
        <TaskEditor
          task={editing.id ? editing : undefined}
          workspaceId={workspace}
          entrypoint={search.get('entrypoint') || undefined}
          onClose={() => setEditing(undefined)}
          onSaved={(value) => {
            setEditing(undefined);
            history.push('/tasks/' + value.id);
          }}
        />
      )}
    </Page>
  );
}
