import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Space,
  Switch,
  Table,
  Typography,
} from 'antd';
import { call, list, useAction, useResource } from '../api';
import {
  Details,
  ErrorPanel,
  FormDialog,
  Reload,
  State,
  Time,
  required,
} from '../components';
import { useText } from '../i18n';
import { formatStorageBytes } from './History';

export function ScheduledBackups({
  busy = false,
  onOperation,
  onRefreshSnapshots,
}: {
  busy?: boolean;
  onOperation: (operation: { id: string; status: string }) => void;
  onRefreshSnapshots: () => unknown;
}) {
  const t = useText(),
    settings = useResource('/backups/schedule', 5000),
    history = useResource('/backups/history', 5000),
    action = useAction(),
    [editing, setEditing] = useState(false);
  const value = settings.data;
  const reload = () => Promise.all([settings.reload(), history.reload()]);
  useEffect(() => {
    if (value?.last_result?.status === 'SUCCESS') void onRefreshSnapshots();
  }, [value?.last_result?.id, value?.last_result?.status, onRefreshSnapshots]);
  return (
    <>
      <Card className="v2-section" title={t('scheduledBackups')}>
        <Space wrap className="v2-section">
          <Button disabled={!value} onClick={() => setEditing(true)}>
            {t('scheduledEdit')}
          </Button>
          <Button
            loading={action.busy}
            disabled={busy || !value || value.running}
            onClick={() =>
              void action.run(async () => {
                const result = await call('/backups/schedule/run', {
                  method: 'POST',
                  body: {},
                });
                onOperation(result);
                await reload();
              })
            }
          >
            {t('scheduledRunNow')}
          </Button>
          <Reload
            onClick={() => void reload()}
            loading={settings.loading || history.loading}
          />
        </Space>
        <ErrorPanel error={settings.error || history.error || action.error} />
        <Typography.Paragraph type="secondary">
          {t('scheduledHelp')}
        </Typography.Paragraph>
        {value && (
          <Details
            values={[
              ['status', t(value.enabled ? 'enabled' : 'disabled')],
              ['scheduledDailyTime', value.time],
              ['timezone', value.timezone],
              ['backupMode', t('backupMode.LIGHTWEIGHT')],
              ['scheduledRetainCount', value.retain_count],
              ['scheduledNextRun', <Time value={value.next_run_at} />],
              ['scheduledRetryAt', <Time value={value.retry_at} />],
              [
                'scheduledCurrent',
                value.running ? <State value="RUNNING" /> : '—',
              ],
            ]}
          />
        )}
        {value?.last_result?.status === 'FAILED' && (
          <Alert
            className="v2-section"
            type="error"
            showIcon
            message={t('scheduledLastFailed')}
            description={
              <Typography.Text code>
                {value.last_result.error_code || 'BACKUP_OPERATION_FAILED'}
              </Typography.Text>
            }
          />
        )}
        <Typography.Paragraph type="secondary" className="v2-section">
          {t('scheduledRetentionHelp')}
        </Typography.Paragraph>
      </Card>
      <Card className="v2-section" title={t('scheduledHistory')}>
        <Typography.Paragraph type="secondary">
          {t('scheduledHistoryHelp')}
        </Typography.Paragraph>
        <Table
          rowKey="id"
          loading={history.loading && !history.data}
          dataSource={list(history.data)}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          scroll={{ x: 1000 }}
          columns={[
            {
              title: t('scheduledExecutedAt'),
              render: (_, row: any) => (
                <Time value={row.started_at || row.scheduled_at} />
              ),
            },
            {
              title: t('backupSource'),
              render: (_, row: any) =>
                t(
                  row.source === 'SCHEDULED'
                    ? 'backupSource.SCHEDULED'
                    : 'backupSource.MANUAL',
                ),
            },
            {
              title: t('backupMode'),
              render: (_, row: any) =>
                t(
                  `backupMode.${
                    row.mode === 'LIGHTWEIGHT' ? 'LIGHTWEIGHT' : 'FULL'
                  }`,
                ),
            },
            {
              title: t('status'),
              render: (_, row: any) => <State value={row.status} />,
            },
            {
              title: t('size'),
              render: (_, row: any) =>
                row.size === null || row.size === undefined
                  ? '—'
                  : formatStorageBytes(row.size),
            },
            {
              title: t('scheduledDuration'),
              render: (_, row: any) =>
                row.duration_ms === null || row.duration_ms === undefined
                  ? '—'
                  : `${(row.duration_ms / 1000).toFixed(1)} s`,
            },
            {
              title: t('diagnostics'),
              render: (_, row: any) => (
                <Space direction="vertical">
                  {row.error_code && (
                    <Typography.Text code>{row.error_code}</Typography.Text>
                  )}
                  {!!row.retention_errors?.length && (
                    <Typography.Text type="warning">
                      {t('scheduledRetentionWarning')}
                    </Typography.Text>
                  )}
                  {row.retention_errors?.map((error: any, index: number) => (
                    <Typography.Text code key={index}>
                      {error.error_code}
                    </Typography.Text>
                  ))}
                  {!row.error_code && !row.retention_errors?.length && '—'}
                </Space>
              ),
            },
          ]}
        />
      </Card>
      {editing && (
        <FormDialog
          title={t('scheduledEdit')}
          initial={value}
          onClose={() => setEditing(false)}
          onSubmit={async (input) => {
            await call('/backups/schedule', {
              method: 'PUT',
              body: {
                enabled: input.enabled,
                time: input.time,
                timezone: input.timezone,
                retain_count: input.retain_count,
              },
            });
            await reload();
          }}
        >
          <Form.Item
            name="enabled"
            label={t('scheduledEnabled')}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="time"
            label={t('scheduledDailyTime')}
            rules={[
              required(),
              {
                pattern: /^(?:[01]\d|2[0-3]):[0-5]\d$/,
                message: t('scheduledInvalidTime'),
              },
            ]}
          >
            <Input type="time" step={60} />
          </Form.Item>
          <Form.Item
            name="timezone"
            label={t('timezone')}
            rules={[
              required(),
              {
                validator: (_, zone) => {
                  try {
                    new Intl.DateTimeFormat('en', { timeZone: zone });
                    return zone
                      ? Promise.resolve()
                      : Promise.reject(
                          new Error(t('scheduledInvalidTimezone')),
                        );
                  } catch {
                    return Promise.reject(
                      new Error(t('scheduledInvalidTimezone')),
                    );
                  }
                },
              },
            ]}
          >
            <Input placeholder="Asia/Shanghai" />
          </Form.Item>
          <Form.Item
            name="retain_count"
            label={t('scheduledRetainCount')}
            rules={[required()]}
          >
            <InputNumber min={1} max={1000} precision={0} />
          </Form.Item>
          <Typography.Paragraph type="secondary">
            {t('scheduledRetentionHelp')}
          </Typography.Paragraph>
        </FormDialog>
      )}
    </>
  );
}
