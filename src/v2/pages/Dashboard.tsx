import React from 'react';
import { Link } from '@umijs/max';
import { Button, Card, Space, Statistic, Table, Typography } from 'antd';
import { ArrowRightOutlined, PlusOutlined } from '@ant-design/icons';
import { list, useResource } from '../api';
import { ErrorPanel, Page, State, Time } from '../components';
import { useText } from '../i18n';
function LatestSync({ workspace }: { workspace: any }) {
  const t = useText(),
    sync = useResource(`/workspaces/${workspace.id}/sync-history?size=1`, 5000),
    latest = list(sync.data)[0] as any;
  return (
    <div className="v2-toolbar">
      <Link to={`/workspaces/${workspace.id}?tab=sync-history`}>
        {workspace.name}
      </Link>
      {sync.error ? (
        <ErrorPanel error={sync.error} />
      ) : latest ? (
        <Space>
          <State value={latest.status} />
          {latest.error_code && (
            <Typography.Text type="danger">{latest.error_code}</Typography.Text>
          )}
        </Space>
      ) : (
        <Typography.Text type="secondary">{t('empty')}</Typography.Text>
      )}
    </div>
  );
}
export default function DashboardPage() {
  const t = useText(),
    summary = useResource('/observability/summary', 4000),
    workspaces = useResource('/workspaces?size=1', 5000),
    tasks = useResource('/tasks?size=1', 5000),
    recovery = useResource(
      '/workspaces?lifecycle_state=RECOVERY_REQUIRED&size=1',
      5000,
    ),
    runs = useResource('/task-runs?size=6', 3000),
    git = useResource('/workspaces?type=GIT&size=5', 7000);
  return (
    <Page
      title={t('welcome')}
      subtitle={t('dashboardHelp')}
      actions={
        <Link to="/workspaces">
          <Button type="primary" icon={<PlusOutlined />}>
            {t('newWorkspace')}
          </Button>
        </Link>
      }
    >
      <ErrorPanel error={summary.error || workspaces.error || tasks.error} />
      <div className="v2-card-grid">
        {[
          [t('workspaces'), workspaces.data?.total],
          [t('tasks'), tasks.data?.total],
          [t('running'), summary.data?.running],
          [t('failed'), summary.data?.failed],
          [t('recoveryRequired'), recovery.data?.total],
        ].map(([title, value], index) => (
          <Card key={index} className="v2-metric">
            <Statistic
              title={title}
              value={value === undefined ? '—' : (value as number)}
            />
          </Card>
        ))}
      </div>
      <Card
        title={t('recentRuns')}
        extra={
          <Link to="/runs">
            {t('viewAll')} <ArrowRightOutlined />
          </Link>
        }
      >
        <ErrorPanel error={runs.error} />
        <Table
          size="small"
          rowKey="id"
          dataSource={list(runs.data)}
          pagination={false}
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
              render: (id: number) => (
                <Link to={`/workspaces/${id}`}>#{id}</Link>
              ),
            },
            {
              title: t('status'),
              dataIndex: 'status',
              render: (value: string) => <State value={value} />,
            },
            {
              title: t('started'),
              dataIndex: 'started_at',
              render: (value: string) => <Time value={value} />,
            },
          ]}
        />
      </Card>
      <div className="v2-columns v2-section">
        <Card
          title={t('syncHistory')}
          extra={<Link to="/workspaces">{t('viewAll')}</Link>}
        >
          <ErrorPanel error={git.error} />
          {list(git.data).map((item: any) => (
            <LatestSync key={item.id} workspace={item} />
          ))}
          {!list(git.data).length && (
            <Typography.Text type="secondary">{t('empty')}</Typography.Text>
          )}
        </Card>
        <Card title={t('workspaceSummary')}>
          <Typography.Paragraph>{t('localHelp')}</Typography.Paragraph>
          <Link to="/workspaces">
            <Button>{t('newWorkspace')}</Button>
          </Link>
          <Typography.Paragraph className="v2-section">
            {t('gitHelp')}
          </Typography.Paragraph>
          <Link to="/repository">
            <Button>{t('repositories')}</Button>
          </Link>
        </Card>
      </div>
    </Page>
  );
}
