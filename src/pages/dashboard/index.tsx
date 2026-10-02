import { formatPercent, formatNumber } from '@/utils/format';
import { translateEnum, translateError } from '@/utils/i18n';
import { formatDateTime, formatDuration, formatBytes } from '@/utils/format';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Select,
  Space,
  Statistic,
  Table,
} from 'antd';
import { obsGet, RunDetail } from '@/components/observability';
import config from '@/utils/config';
export default function Dashboard() {
  useI18nLocale();
  const [range, setRange] = useState('24h'),
    [data, setData] = useState<any>(),
    [run, setRun] = useState<number>();
  const load = () =>
    obsGet('observability/summary?range=' + range).then(setData);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [range]);
  const count = (s: string) =>
    data?.counts.find((x: any) => x.status === s)?.count ?? 0;
  return (
    <Card title={tr('ui.observability')}>
      <Space>
        <Select
          value={range}
          onChange={setRange}
          options={['24h', '7d', '30d'].map((value) => ({
            value,
            label: tr('ui.range.' + value),
          }))}
        />
        <Button onClick={load}>{tr('ui.refresh')}</Button>
        <a href={config.baseUrl + 'runs'}>{tr('ui.allRuns')}</a>
      </Space>
      <Row gutter={16} style={{ margin: '20px 0' }}>
        {[
          [tr('ui.dashboard.tasks'), data?.tasks.total ?? 0],
          [tr('ui.dashboard.enabled'), data?.tasks.enabled ?? 0],
          [tr('ui.dashboard.ready'), data?.tasks.ready ?? 0],
          [tr('ui.dashboard.success'), count('SUCCESS')],
          [tr('ui.dashboard.failure'), count('FAILED')],
          [tr('ui.dashboard.timeout'), count('TIMEOUT')],
          [
            tr('ui.dashboard.successRate'),
            data?.success_rate === null
              ? '—'
              : formatPercent(data?.success_rate ?? 0),
          ],
        ].map(([title, value]) => (
          <Col key={title} span={3}>
            <Statistic title={title} value={value} />
          </Col>
        ))}
      </Row>
      <Space>
        {data?.queue.map((r: any) => (
          <a key={r.status} href={`${config.baseUrl}runs?status=${r.status}`}>
            {translateEnum('taskRun', r.status)}: {formatNumber(r.count)}
          </a>
        ))}
      </Space>
      {['failures', 'recent', 'longest', 'unhealthy'].map((key) => (
        <Card
          key={key}
          title={
            {
              failures: tr('ui.dashboard.failures'),
              recent: tr('ui.dashboard.recent'),
              longest: tr('ui.dashboard.longest'),
              unhealthy: tr('ui.dashboard.unhealthy'),
            }[key]
          }
          style={{ marginTop: 16 }}
        >
          <Table
            rowKey={key === 'unhealthy' ? 'task_id' : 'id'}
            pagination={false}
            dataSource={data?.[key] ?? []}
            columns={
              key === 'unhealthy'
                ? [
                    { title: tr('ui.task'), dataIndex: 'name' },
                    {
                      title: tr('ui.health'),
                      dataIndex: 'health_state',
                      render: (value: unknown) =>
                        translateEnum('health', value),
                    },
                    {
                      title: tr('ui.consecutiveFailures'),
                      dataIndex: 'consecutive_failures',
                    },
                    {
                      title: tr('ui.lastRun'),
                      dataIndex: 'last_run_id',
                      render: (id) => (
                        <Button type="link" onClick={() => setRun(id)}>
                          {id}
                        </Button>
                      ),
                    },
                  ]
                : [
                    {
                      title: tr('ui.run'),
                      dataIndex: 'id',
                      render: (id) => (
                        <Button type="link" onClick={() => setRun(id)}>
                          {id}
                        </Button>
                      ),
                    },
                    { title: tr('ui.task'), dataIndex: 'task_id' },
                    {
                      title: tr('ui.status'),
                      dataIndex: 'status',
                      render: (value: unknown) =>
                        translateEnum('taskRun', value),
                    },
                    {
                      title: tr('ui.finished'),
                      dataIndex: 'finished_at',
                      render: (value: any) => formatDateTime(value),
                    },
                    {
                      title: tr('ui.error'),
                      dataIndex: 'error_code',
                      render: (value: unknown) =>
                        value ? translateError(value) : '—',
                    },
                    {
                      title: tr('ui.duration'),
                      dataIndex: 'duration_ms',
                      render: (value: number | null) =>
                        formatDuration(value === null ? null : value / 1000),
                    },
                  ]
            }
          />
        </Card>
      ))}
      <Alert
        style={{ marginTop: 16 }}
        message={tr(
          'ui.template.storageValueRunsValueLogBytesValueDeliveryAttemptsAutomaticHistoryDeletionIsOFF',
          {
            p0: data?.storage.run_count ?? 0,
            p1: data?.storage.log_bytes ?? 0,
            p2: data?.storage.delivery_count ?? 0,
          },
        )}
      />
      <RunDetail id={run} onClose={() => setRun(undefined)} />
    </Card>
  );
}
