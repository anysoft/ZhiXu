import React, { useState } from 'react';
import { Link } from '@umijs/max';
import { Select, Table, Typography } from 'antd';
import { list, query, useResource } from '../api';
import { ErrorPanel, Page, Reload, State, Time } from '../components';
import { useText, diagnostic } from '../i18n';
import {
  HistoryFilters,
  HistoryCleanup,
  historyPagination,
  historyTerminal,
  recentHistory,
  HistoryWindow,
} from '../features/History';
export default function RunsPage() {
  const t = useText(),
    [page, setPage] = useState(1),
    [size, setSize] = useState(20),
    [window, setWindow] = useState<HistoryWindow>(() => recentHistory()),
    [selected, setSelected] = useState<React.Key[]>([]),
    [status, setStatus] = useState<string>(),
    [workspace, setWorkspace] = useState<number>();
  const data = useResource(
      query('/task-runs', {
        page,
        size,
        status,
        workspace_id: workspace,
        from: window.from,
        to: window.to,
      }),
      2500,
    ),
    workspaces = useResource('/workspaces?size=200');
  return (
    <Page
      title={t('runs')}
      actions={
        <Reload onClick={() => void data.reload()} loading={data.loading} />
      }
    >
      <div className="v2-toolbar">
        <HistoryFilters
          value={window}
          onChange={(value) => {
            setWindow(value);
            setPage(1);
            setSelected([]);
          }}
          status={status}
          onStatus={(value) => {
            setStatus(value);
            setPage(1);
            setSelected([]);
          }}
          statuses={[
            'QUEUED',
            'RESOLVING',
            'RUNNING',
            'SUCCESS',
            'FAILED',
            'TIMEOUT',
            'SKIPPED',
            'CANCELLED',
            'INTERRUPTED',
            'RECOVERY_REQUIRED',
          ]}
        >
          <Select
            aria-label={t('workspace')}
            allowClear
            value={workspace}
            onChange={(value) => {
              setWorkspace(value);
              setPage(1);
              setSelected([]);
            }}
            placeholder={t('workspace')}
            style={{ width: 230 }}
            options={list(workspaces.data).map((item: any) => ({
              value: item.id,
              label: item.name,
            }))}
          />
        </HistoryFilters>
      </div>
      <HistoryCleanup
        kind="task"
        filters={{
          from: window.from,
          to: window.to,
          status,
          workspace_id: workspace,
        }}
        selected={selected}
        onClean={async () => {
          setSelected([]);
          setPage(1);
          await data.reload();
        }}
      />
      <ErrorPanel error={data.error} />
      <Table
        rowKey="id"
        dataSource={list(data.data)}
        loading={data.loading && !data.data}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: setSelected,
          getCheckboxProps: (row: any) => ({
            disabled: !historyTerminal('task', row.status),
          }),
        }}
        pagination={historyPagination(
          page,
          size,
          data.data?.total || 0,
          (p, n) => {
            setPage(p);
            setSize(n);
            setSelected([]);
          },
        )}
        columns={[
          {
            title: t('id'),
            dataIndex: 'id',
            render: (id: number) => <Link to={`/runs/${id}`}>#{id}</Link>,
          },
          {
            title: t('task'),
            dataIndex: 'task_id',
            render: (id: number) =>
              id ? <Link to={`/tasks/${id}`}>#{id}</Link> : '—',
          },
          {
            title: t('workspace'),
            dataIndex: 'workspace_id',
            render: (id: number) => <Link to={`/workspaces/${id}`}>#{id}</Link>,
          },
          {
            title: t('status'),
            dataIndex: 'status',
            render: (value: string) => <State value={value} />,
          },
          { title: t('attempts'), dataIndex: 'attempt_count' },
          {
            title: t('started'),
            dataIndex: 'started_at',
            render: (value: string) => <Time value={value} />,
          },
          {
            title: t('diagnostics'),
            dataIndex: 'error_code',
            render: (value: string) =>
              value ? (
                <Typography.Text type="secondary" title={value}>
                  {diagnostic(value)}
                </Typography.Text>
              ) : (
                '—'
              ),
          },
        ]}
      />
    </Page>
  );
}
