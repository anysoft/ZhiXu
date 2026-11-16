import React, { useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Form,
  InputNumber,
  Space,
  Table,
  Switch,
  Typography,
} from 'antd';
import { call, useResource } from '../api';
import { ErrorPanel, FormDialog, Reload, Time } from '../components';
import { useText } from '../i18n';
import { HistoryCleanup, formatStorageBytes } from './History';

function RetentionInput({
  value,
  onChange,
  fallback,
  id,
}: {
  value?: number | null;
  onChange?: (value: number | null) => void;
  fallback: number;
  id?: string;
}) {
  const t = useText();
  return (
    <Space>
      <InputNumber
        id={id}
        aria-label={t('retentionDays')}
        min={1}
        max={36500}
        precision={0}
        disabled={value === null}
        value={value === null ? undefined : value}
        onChange={(v) => onChange?.(Number(v) || fallback)}
      />
      <Typography.Text>{t('days')}</Typography.Text>
      <Checkbox
        checked={value === null}
        onChange={(e) => onChange?.(e.target.checked ? null : fallback)}
      >
        {t('retainForever')}
      </Checkbox>
    </Space>
  );
}
export function StorageMaintenance() {
  const t = useText(),
    settings = useResource('/maintenance/settings'),
    usage = useResource('/maintenance/usage'),
    [editing, setEditing] = useState(false);
  const values = settings.data,
    data = usage.data;
  const reload = () => Promise.all([settings.reload(), usage.reload()]);
  const labels = {
    task_logs: 'maintenanceTaskLogs',
    runtime_logs: 'maintenanceRuntimeLogs',
    download_cache: 'maintenanceCache',
    temporary: 'maintenanceTemporary',
    database: 'maintenanceDatabase',
  };
  const retention = (value: number | null | undefined) =>
    value === null ? t('retainForever') : `${value ?? '—'} ${t('days')}`;
  return (
    <>
      <Space className="v2-section">
        <Reload onClick={() => void reload()} loading={usage.loading} />
        <Button disabled={!values} onClick={() => setEditing(true)}>
          {t('maintenanceEditPolicy')}
        </Button>
      </Space>
      <ErrorPanel error={settings.error || usage.error} />
      <Typography.Paragraph>{t('maintenanceHelp')}</Typography.Paragraph>
      {values?.last_automatic_result?.status === 'FAILED' && (
        <Alert
          className="v2-section"
          type="warning"
          showIcon
          message={t('maintenanceAutomaticFailed')}
          description={`${
            values.last_automatic_result.error_code ||
            'MAINTENANCE_PARTIAL_FAILURE'
          }; ${t('cleanupErrorCount')}: ${
            values.last_automatic_result.errors || 0
          }`}
        />
      )}
      {(values?.last_automatic_attempt_at || values?.last_automatic_at) && (
        <Typography.Paragraph type="secondary">
          {t('maintenanceLastAutomatic')}:{' '}
          <Time
            value={values.last_automatic_attempt_at || values.last_automatic_at}
          />
        </Typography.Paragraph>
      )}

      {data?.disk && (
        <Alert
          className="v2-section"
          showIcon
          type={data.disk.free_bytes < 2 * 1024 ** 3 ? 'warning' : 'info'}
          message={t(
            data.disk.free_bytes < 2 * 1024 ** 3
              ? 'maintenanceLowSpace'
              : 'maintenanceDisk',
          )}
          description={`${t('maintenanceFree')}: ${formatStorageBytes(
            data.disk.free_bytes,
          )} / ${formatStorageBytes(data.disk.total_bytes)}`}
        />
      )}
      <Table
        rowKey="key"
        pagination={false}
        dataSource={Object.entries(labels).map(([key, label]) => ({
          key,
          name: t(label),
          files: data?.categories?.[key]?.files,
          bytes: data?.categories?.[key]?.bytes,
          skipped: data?.categories?.[key]?.skipped,
          truncated: data?.categories?.[key]?.truncated,
        }))}
        columns={[
          {
            title: t('type'),
            dataIndex: 'name',
            render: (name, row) => (
              <Space direction="vertical">
                <span>{name}</span>
                {(row.skipped > 0 || row.truncated) && (
                  <Typography.Text type="warning">
                    {t('maintenanceUsagePartial')}
                    {row.skipped > 0
                      ? ` (${t('cleanupSkipped')}: ${row.skipped})`
                      : ''}
                  </Typography.Text>
                )}
              </Space>
            ),
          },
          {
            title: t('fileCount'),
            dataIndex: 'files',
            render: (value) => value ?? '—',
          },
          {
            title: t('storageUsed'),
            dataIndex: 'bytes',
            render: (value) =>
              value === undefined ? '—' : formatStorageBytes(value),
          },
        ]}
      />
      {values && (
        <Space direction="vertical" className="v2-section">
          <Typography.Text>
            {t('maintenanceAuto')}:{' '}
            {t(values.auto_enabled ? 'enabled' : 'disabled')}
          </Typography.Text>
          <Typography.Text>
            {t('maintenanceTaskDays')}: {retention(values.task_days)}
          </Typography.Text>
          <Typography.Text>
            {t('maintenanceRuntimeDays')}: {retention(values.runtime_days)}
          </Typography.Text>
          <Typography.Text>
            {t('maintenanceCacheDays')}: {retention(values.cache_days)}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t('maintenanceDaily')}
          </Typography.Text>
        </Space>
      )}
      <HistoryCleanup kind="storage" onClean={reload} />
      {editing && (
        <FormDialog
          title={t('maintenanceEditPolicy')}
          initial={values}
          onClose={() => setEditing(false)}
          onSubmit={async (value) => {
            await call('/maintenance/settings', {
              method: 'PUT',
              body: {
                auto_enabled: value.auto_enabled,
                task_days: value.task_days,
                runtime_days: value.runtime_days,
                cache_days: value.cache_days,
              },
            });
            await reload();
          }}
        >
          <Form.Item
            name="auto_enabled"
            label={t('maintenanceAuto')}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          {(['task_days', 'runtime_days', 'cache_days'] as const).map(
            (name, i) => (
              <Form.Item
                key={name}
                name={name}
                label={t(
                  [
                    'maintenanceTaskDays',
                    'maintenanceRuntimeDays',
                    'maintenanceCacheDays',
                  ][i],
                )}
                rules={[
                  {
                    validator: (_, value) =>
                      value === null ||
                      (Number.isSafeInteger(value) &&
                        value > 0 &&
                        value <= 36500)
                        ? Promise.resolve()
                        : Promise.reject(new Error(t('required'))),
                  },
                ]}
              >
                <RetentionInput fallback={[90, 30, 30][i]} />
              </Form.Item>
            ),
          )}
        </FormDialog>
      )}
    </>
  );
}
