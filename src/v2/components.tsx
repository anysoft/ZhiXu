import React, { useRef, useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Empty,
  Form,
  Modal,
  Space,
  Spin,
  Tag,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useText, text, label, diagnostic } from './i18n';
import { requestKey } from './api';

export function ErrorPanel({
  error,
  reload,
}: {
  error?: any;
  reload?: () => void;
}) {
  const t = useText();
  if (!error) return null;
  const code = /^[A-Z][A-Z0-9_]{1,100}$/.test(error.code || '')
    ? error.code
    : 'REQUEST_FAILED';
  return (
    <Alert
      className="v2-error"
      showIcon
      type="error"
      message={diagnostic(code, error.status)}
      description={
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap>
            <Tag>{code}</Tag>
            {error.details?.current_version ? (
              <span>
                {t('version')}: {error.details.current_version}
              </span>
            ) : null}
          </Space>
          {Array.isArray(error.details?.diagnostics) && (
            <Table
              size="small"
              pagination={false}
              rowKey={(_, i) => String(i)}
              dataSource={error.details.diagnostics.filter((row: any) =>
                /^[A-Z][A-Z0-9_]+$/.test(row.code || ''),
              )}
              columns={[
                { title: t('diagnostics'), dataIndex: 'code' },
                {
                  title: t('path'),
                  dataIndex: 'path',
                  render: (value) =>
                    typeof value === 'string' &&
                    !value.startsWith('/') &&
                    !value.includes('..')
                      ? value
                      : '—',
                },
              ]}
            />
          )}
        </Space>
      }
      action={
        reload ? (
          <Button size="small" onClick={reload}>
            {t('refresh')}
          </Button>
        ) : undefined
      }
    />
  );
}
export function State({ value }: { value?: any }) {
  const color = [
    'SUCCESS',
    'SUCCEEDED',
    'READY',
    'ACTIVE',
    'DISPATCHED',
    'PRESENT',
  ].includes(value)
    ? 'green'
    : ['FAILED', 'ERROR', 'RECOVERY_REQUIRED', 'DEAD', 'TIMEOUT'].includes(
        value,
      )
    ? 'red'
    : ['RUNNING', 'RESOLVING', 'BUILDING', 'FETCHING', 'PROCESSING'].includes(
        value,
      )
    ? 'blue'
    : ['BLOCKED', 'SKIPPED', 'ARCHIVED'].includes(value)
    ? 'orange'
    : undefined;
  return (
    <Tooltip title={value || ''}>
      <Tag color={color}>{label(value)}</Tag>
    </Tooltip>
  );
}
export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="v2-page">
      <header className="v2-page-heading">
        <div>
          <Typography.Title level={2}>{title}</Typography.Title>
          {subtitle && (
            <Typography.Paragraph type="secondary">
              {subtitle}
            </Typography.Paragraph>
          )}
        </div>
        <Space wrap>{actions}</Space>
      </header>
      {children}
    </section>
  );
}
export function Reload({
  onClick,
  loading,
}: {
  onClick: () => void;
  loading?: boolean;
}) {
  const t = useText();
  return (
    <Button icon={<ReloadOutlined />} loading={loading} onClick={onClick}>
      {t('refresh')}
    </Button>
  );
}
export function Loading({
  loading,
  children,
}: {
  loading?: boolean;
  children?: React.ReactNode;
}) {
  return <Spin spinning={!!loading}>{children}</Spin>;
}
export function NoData() {
  const t = useText();
  return <Empty description={t('empty')} />;
}
export function Details({ values }: { values: Array<[string, any]> }) {
  const t = useText();
  return (
    <Descriptions column={{ xs: 1, sm: 2, md: 2 }} size="small" bordered>
      {values.map(([key, value]) => (
        <Descriptions.Item key={key} label={t(key)}>
          {value === undefined || value === null || value === '' ? '—' : value}
        </Descriptions.Item>
      ))}
    </Descriptions>
  );
}
export function Fingerprint({ value }: { value?: string | null }) {
  return value ? (
    <Typography.Text code copyable>
      {value}
    </Typography.Text>
  ) : (
    <>—</>
  );
}
export function Time({ value }: { value?: string | null }) {
  return <>{value ? new Date(value).toLocaleString() : '—'}</>;
}
export function FormDialog({
  title,
  initial,
  children,
  onSubmit,
  onClose,
  width = 600,
  submitText,
}: {
  title: React.ReactNode;
  initial?: any;
  children: React.ReactNode;
  onSubmit: (values: any, key: string) => Promise<any>;
  onClose: () => void;
  width?: number;
  submitText?: string;
}) {
  const t = useText(),
    [form] = Form.useForm(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<any>();
  const intent = useRef({ payload: '', key: requestKey() }),
    executing = useRef(false);
  const submit = async () => {
    if (executing.current) return;
    executing.current = true;
    try {
      const values = await form.validateFields(),
        payload = JSON.stringify(values),
        key =
          payload === intent.current.payload
            ? intent.current.key
            : requestKey();
      intent.current = { payload, key };
      setBusy(true);
      setError(undefined);
      await onSubmit(values, key);
      onClose();
    } catch (failure: any) {
      if (!failure?.errorFields) setError(failure);
    } finally {
      executing.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={title}
      onCancel={() => !busy && onClose()}
      onOk={() => void submit()}
      okText={submitText || t('save')}
      cancelText={t('cancel')}
      confirmLoading={busy}
      width={width}
      destroyOnClose
      maskClosable={false}
    >
      <ErrorPanel error={error} />
      <Form
        form={form}
        layout="vertical"
        initialValues={initial}
        preserve={false}
      >
        {children}
      </Form>
    </Modal>
  );
}
export const required = () => ({ required: true, message: text('required') });
export const lines = (value: string = '') =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
export const enumOptions = (values: string[]) =>
  values.map((value) => ({ value, label: label(value) }));
