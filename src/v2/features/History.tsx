import React, { useState } from 'react';
import {
  Alert,
  Button,
  DatePicker,
  Modal,
  Select,
  Space,
  Typography,
} from 'antd';
import moment, { Moment } from 'moment';
import { call, useAction } from '../api';
import { ErrorPanel, enumOptions } from '../components';
import { useText } from '../i18n';

export interface HistoryWindow {
  preset: '24h' | '7d' | '30d' | 'custom';
  from: string;
  to?: string;
}
export function recentHistory(
  preset: HistoryWindow['preset'] = '7d',
): HistoryWindow {
  const days = preset === '24h' ? 1 : preset === '30d' ? 30 : 7;
  return { preset, from: new Date(Date.now() - days * 86400000).toISOString() };
}
export function HistoryFilters({
  value,
  onChange,
  status,
  onStatus,
  statuses,
  children,
}: {
  value: HistoryWindow;
  onChange: (value: HistoryWindow) => void;
  status?: string;
  onStatus: (value?: string) => void;
  statuses: string[];
  children?: React.ReactNode;
}) {
  const t = useText();
  return (
    <Space wrap className="v2-section">
      <Select
        aria-label={t('historyTimeRange')}
        value={value.preset}
        style={{ width: 185 }}
        options={['24h', '7d', '30d', 'custom'].map((key) => ({
          value: key,
          label: t(`historyRange.${key}`),
        }))}
        onChange={(preset) =>
          onChange(
            preset === 'custom'
              ? { ...value, preset, to: new Date().toISOString() }
              : recentHistory(preset),
          )
        }
      />
      {value.preset === 'custom' && (
        <DatePicker.RangePicker
          showTime
          allowClear={false}
          aria-label={t('historyCustomRange')}
          format="YYYY-MM-DD HH:mm:ss"
          value={[moment(value.from), moment(value.to)]}
          onChange={(range) => {
            const [from, to] = (range || []) as [Moment?, Moment?];
            if (from && to && to.isAfter(from))
              onChange({
                preset: 'custom',
                from: from.toISOString(),
                to: to.toISOString(),
              });
          }}
        />
      )}
      <Select
        aria-label={t('status')}
        allowClear
        value={status}
        onChange={onStatus}
        placeholder={t('status')}
        style={{ width: 185 }}
        options={enumOptions(statuses)}
      />
      {children}
      {value.preset === 'custom' && (
        <Typography.Text type="secondary">
          {t('historyBoundaryHelp')}
        </Typography.Text>
      )}
    </Space>
  );
}
export function historyPagination(
  page: number,
  size: number,
  total: number,
  onChange: (page: number, size: number) => void,
) {
  return {
    current: page,
    pageSize: size,
    total,
    showSizeChanger: true,
    pageSizeOptions: ['20', '50', '100'],
    onChange,
  };
}
export function historyTerminal(kind: 'task' | 'runtime', status?: string) {
  return (
    kind === 'task'
      ? ['SUCCESS', 'FAILED', 'TIMEOUT', 'CANCELLED', 'INTERRUPTED', 'SKIPPED']
      : ['SUCCESS', 'FAILED', 'CANCELLED', 'INTERRUPTED']
  ).includes(status || '');
}
export function formatStorageBytes(value = 0) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'],
    index = Math.min(
      Math.floor(Math.log(value) / Math.log(1024)),
      units.length - 1,
    );
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

/** Scan first, then confirm the server's frozen preview. Never delete on opening a dialog. */
export function HistoryCleanup({
  kind,
  filters = {},
  selected = [],
  onClean,
}: {
  kind: 'task' | 'runtime' | 'storage';
  filters?: Record<string, any>;
  selected?: React.Key[];
  onClean: () => void | Promise<unknown>;
}) {
  const t = useText(),
    action = useAction(),
    [mode, setMode] = useState('records'),
    [preview, setPreview] = useState<any>(),
    [result, setResult] = useState<any>();
  const scan = (ids?: React.Key[]) =>
    action.run(async () => {
      setResult(undefined);
      setPreview(
        await call('/maintenance/preview', {
          method: 'POST',
          body: {
            kind,
            mode,
            ...(ids ? { ids } : filters),
          },
        }),
      );
    });
  return (
    <>
      <Space wrap className="v2-section">
        {kind === 'runtime' && (
          <Select
            aria-label={t('cleanupMode')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'records', label: t('cleanupRecordsAndLogs') },
              { value: 'logs', label: t('cleanupLogsOnly') },
            ]}
            style={{ minWidth: 220 }}
          />
        )}
        <Button loading={action.busy} onClick={() => void scan()}>
          {t(kind === 'storage' ? 'maintenanceScan' : 'cleanupRange')}
        </Button>
        {kind !== 'storage' && (
          <Button
            disabled={!selected.length}
            loading={action.busy}
            onClick={() => void scan(selected)}
          >
            {t('cleanupSelected')} ({selected.length})
          </Button>
        )}
      </Space>
      <ErrorPanel error={action.error} />
      {result && (
        <Alert
          className="v2-section"
          showIcon
          type={result.errors?.length ? 'warning' : 'success'}
          message={t('cleanupResult')}
          description={
            <Space direction="vertical">
              <span>
                {t('cleanupDeleted')}: {result.deleted || 0};{' '}
                {t('cleanupLogsDeleted')}: {result.logs_deleted || 0};{' '}
                {t('cleanupFilesDeleted')}: {result.files_deleted || 0}
              </span>
              <span>
                {t('cleanupFreed')}: {formatStorageBytes(result.freed_bytes)};{' '}
                {t('cleanupSkipped')}: {result.skipped || 0}
              </span>
              {result.has_more && <span>{t('cleanupHasMore')}</span>}
              {result.errors?.map((error: any, i: number) => (
                <code key={i}>
                  {error.kind}
                  {error.id === undefined ? '' : ` #${error.id}`}: {error.code}
                </code>
              ))}
            </Space>
          }
        />
      )}
      {preview && (
        <Modal
          open
          title={t('cleanupPreview')}
          maskClosable={false}
          onCancel={() => !action.busy && setPreview(undefined)}
          footer={
            <Space>
              <Button
                disabled={action.busy}
                onClick={() => setPreview(undefined)}
              >
                {t('cancel')}
              </Button>
              <Button
                danger
                type="primary"
                loading={action.busy}
                disabled={!preview.count}
                onClick={() =>
                  void action.run(async () => {
                    const value = await call('/maintenance/clean', {
                      method: 'POST',
                      body: { preview_id: preview.preview_id },
                    });
                    setResult(value);
                    setPreview(undefined);
                    await onClean();
                  })
                }
              >
                {t('cleanupConfirm')}
              </Button>
            </Space>
          }
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert type="warning" showIcon message={t('cleanupConfirmHelp')} />
            <Typography.Text>
              {t('cleanupEstimated')}: {preview.count || 0}
            </Typography.Text>
            <Typography.Text>
              {t('cleanupEstimatedBytes')}: {formatStorageBytes(preview.bytes)}
            </Typography.Text>
            <Typography.Text>
              {t('cleanupSkipped')}: {preview.skipped || 0}
            </Typography.Text>
            {kind === 'runtime' && (
              <Typography.Text>
                {t(
                  mode === 'logs' ? 'cleanupLogsOnly' : 'cleanupRecordsAndLogs',
                )}
              </Typography.Text>
            )}
            {preview.has_more && (
              <Alert type="info" message={t('cleanupHasMore')} />
            )}
            <ErrorPanel error={action.error} />
          </Space>
        </Modal>
      )}
    </>
  );
}
