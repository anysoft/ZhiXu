import React, { useState } from 'react';
import { Link } from '@umijs/max';
import { Select, Space, Table, Typography } from 'antd';
import { list, query, useResource } from '../api';
import {
  ErrorPanel,
  Page,
  Reload,
  State,
  Time,
  enumOptions,
} from '../components';
import { useText, diagnostic } from '../i18n';
export default function RunsPage() {
  const t = useText(),
    [page, setPage] = useState(1),
    [status, setStatus] = useState<string>(),
    [workspace, setWorkspace] = useState<number>();
  const data = useResource(
      query('/task-runs', { page, size: 20, status, workspace_id: workspace }),
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
        <Space>
          <Select
            allowClear
            value={workspace}
            onChange={(value) => {
              setWorkspace(value);
              setPage(1);
            }}
            placeholder={t('workspace')}
            style={{ width: 230 }}
            options={list(workspaces.data).map((item: any) => ({
              value: item.id,
              label: item.name,
            }))}
          />
          <Select
            allowClear
            value={status}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            placeholder={t('status')}
            style={{ width: 190 }}
            options={enumOptions([
              'QUEUED',
              'RESOLVING',
              'RUNNING',
              'SUCCESS',
              'FAILED',
              'SKIPPED',
              'CANCELLED',
              'INTERRUPTED',
              'RECOVERY_REQUIRED',
            ])}
          />
        </Space>
      </div>
      <ErrorPanel error={data.error} />
      <Table
        rowKey="id"
        dataSource={list(data.data)}
        loading={data.loading && !data.data}
        pagination={{
          current: page,
          pageSize: 20,
          total: data.data?.total || 0,
          onChange: setPage,
        }}
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
