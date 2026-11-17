import React, { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Typography,
} from 'antd';
import { saveAs } from 'file-saver';
import { call, list, query, useAction, useResource } from '../api';
import {
  ErrorPanel,
  FormDialog,
  Reload,
  State,
  Time,
  required,
} from '../components';
import { useText } from '../i18n';
import { formatStorageBytes } from './History';
import { ProxySelect } from './Proxy';

const ROOT = '/backups/remote';

/** Remote settings stay alongside the existing local backup UI. Secrets are write-only. */
export function RemoteBackups({
  snapshots = [],
  busy = false,
}: {
  snapshots?: any[];
  busy?: boolean;
}) {
  const t = useText(),
    targets = useResource(`${ROOT}/targets`),
    settings = useResource(`${ROOT}/settings`),
    uploads = useResource(`${ROOT}/uploads`, 5000),
    action = useAction(),
    [targetId, setTargetId] = useState<string>(),
    [snapshotId, setSnapshotId] = useState<string>(),
    [dialog, setDialog] = useState<any>(),
    [testedId, setTestedId] = useState<string>();
  const targetRows = list(targets.data),
    selectedTarget = targetId || targetRows[0]?.id,
    objects = useResource(
      selectedTarget
        ? `${ROOT}/targets/${encodeURIComponent(selectedTarget)}/objects`
        : null,
    ),
    enabledTargets = targetRows.filter((row: any) => row.enabled),
    reload = () =>
      Promise.all([
        targets.reload(),
        settings.reload(),
        uploads.reload(),
        objects.reload(),
      ]);
  const targetOptions = enabledTargets.map((row: any) => ({
    value: row.id,
    label: `${row.name} · ${row.type}`,
  }));
  const run = (operation: () => Promise<unknown>) => void action.run(operation);
  return (
    <>
      <Card className="v2-section" title={t('remoteTargets')}>
        <Space wrap className="v2-section">
          <Button
            onClick={() =>
              setDialog({
                kind: 'target',
                value: {
                  type: 'S3',
                  enabled: true,
                  region: 'us-east-1',
                  path_style: false,
                  proxy: { mode: 'INHERIT' },
                },
              })
            }
          >
            {t('remoteNewTarget')}
          </Button>
          <Reload onClick={() => void reload()} loading={targets.loading} />
        </Space>
        <ErrorPanel
          error={
            targets.error ||
            settings.error ||
            uploads.error ||
            objects.error ||
            action.error
          }
        />
        {testedId && (
          <Alert
            className="v2-section"
            type="success"
            showIcon
            message={t('remoteTestPassed')}
          />
        )}
        <Typography.Paragraph type="secondary">
          {t('remoteTargetHelp')}
        </Typography.Paragraph>
        <Table
          rowKey="id"
          dataSource={targetRows}
          loading={targets.loading && !targets.data}
          pagination={false}
          scroll={{ x: 800 }}
          columns={[
            { title: t('name'), dataIndex: 'name' },
            { title: t('type'), dataIndex: 'type' },
            { title: t('remoteEndpoint'), dataIndex: 'endpoint' },
            {
              title: t('status'),
              render: (_, row: any) => t(row.enabled ? 'enabled' : 'disabled'),
            },
            {
              title: t('actions'),
              render: (_, row: any) => (
                <Space wrap>
                  <Button
                    size="small"
                    onClick={() => setDialog({ kind: 'target', value: row })}
                  >
                    {t('edit')}
                  </Button>
                  <Button
                    size="small"
                    loading={action.busy}
                    onClick={() =>
                      run(async () => {
                        setTestedId(undefined);
                        await call(`${ROOT}/targets/${row.id}/test`, {
                          method: 'POST',
                          body: {},
                        });
                        setTestedId(row.id);
                      })
                    }
                  >
                    {t('remoteTest')}
                  </Button>
                  <Popconfirm
                    title={t('remoteDeleteTargetConfirm')}
                    onConfirm={() =>
                      action.run(async () => {
                        await call(`${ROOT}/targets/${row.id}`, {
                          method: 'DELETE',
                        });
                        if (targetId === row.id) setTargetId(undefined);
                        setTestedId(undefined);
                        await reload();
                      })
                    }
                  >
                    <Button size="small" danger disabled={action.busy}>
                      {t('delete')}
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <Card className="v2-section" title={t('remoteAutomatic')}>
        <Typography.Paragraph type="secondary">
          {t('remoteAutomaticHelp')}
        </Typography.Paragraph>
        <Alert
          className="v2-section"
          type="warning"
          showIcon
          message={t('remoteRecoveryKeyHelp')}
        />
        <Space wrap className="v2-section">
          <State value={settings.data?.enabled ? 'enabled' : 'disabled'} />
          <Typography.Text>
            {targetRows.find((row: any) => row.id === settings.data?.target_id)
              ?.name || '—'}
          </Typography.Text>
          <Typography.Text>
            {t('remoteRetainCount')}: {settings.data?.retain_count ?? 14}
          </Typography.Text>
          <Typography.Text>
            {t(
              settings.data?.has_passphrase
                ? 'remoteKeyConfigured'
                : 'remoteKeyMissing',
            )}
          </Typography.Text>
          <Button
            disabled={!settings.data}
            onClick={() => setDialog({ kind: 'settings' })}
          >
            {t('remoteEditSettings')}
          </Button>
        </Space>
        <Typography.Paragraph type="secondary">
          {t('remoteRetentionHelp')}
        </Typography.Paragraph>
      </Card>
      <Card className="v2-section" title={t('remoteBackups')}>
        <Typography.Paragraph type="secondary">
          {t('remoteUploadHelp')}
        </Typography.Paragraph>
        <Space wrap className="v2-section">
          <Select
            aria-label={t('remoteTarget')}
            value={selectedTarget}
            placeholder={t('remoteTarget')}
            style={{ minWidth: 220 }}
            onChange={setTargetId}
            options={targetRows.map((row: any) => ({
              value: row.id,
              label: `${row.name} · ${row.type}${
                row.enabled ? '' : ` · ${t('disabled')}`
              }`,
            }))}
          />
          <Select
            aria-label={t('remoteLocalSnapshot')}
            value={snapshotId}
            placeholder={t('remoteLocalSnapshot')}
            style={{ minWidth: 320 }}
            onChange={setSnapshotId}
            options={snapshots.map((row: any) => ({
              value: row.id,
              label: `${row.created_at || row.id} · ${
                row.backup_mode || 'FULL'
              }`,
            }))}
          />
          <Button
            disabled={
              busy ||
              !snapshotId ||
              !selectedTarget ||
              !enabledTargets.some((row: any) => row.id === selectedTarget) ||
              !settings.data?.has_passphrase
            }
            loading={action.busy}
            onClick={() =>
              run(async () => {
                await call(`${ROOT}/uploads`, {
                  method: 'POST',
                  body: { snapshot_id: snapshotId, target_id: selectedTarget },
                });
                await uploads.reload();
              })
            }
          >
            {t('remoteUpload')}
          </Button>
          <Reload
            onClick={() =>
              void Promise.all([uploads.reload(), objects.reload()])
            }
            loading={uploads.loading || objects.loading}
          />
        </Space>
        <Table
          rowKey="id"
          dataSource={list(uploads.data)}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          scroll={{ x: 1100 }}
          columns={[
            {
              title: t('created'),
              render: (_, row: any) => <Time value={row.created_at} />,
            },
            { title: t('remoteTarget'), dataIndex: 'target_name' },
            {
              title: t('backupMode'),
              render: (_, row: any) => t(`backupMode.${row.mode}`),
            },
            {
              title: t('backupSource'),
              render: (_, row: any) => t(`backupSource.${row.source}`),
            },
            {
              title: t('status'),
              render: (_, row: any) => (
                <Space direction="vertical">
                  <Typography.Text>
                    {t(`remoteStatus.${row.status}`)}
                  </Typography.Text>
                  {row.status === 'UPLOADING' &&
                    (row.size > 0 ? (
                      <Progress
                        size="small"
                        style={{ minWidth: 100 }}
                        percent={Math.min(
                          100,
                          Math.floor(
                            ((row.processed_bytes || 0) * 100) / row.size,
                          ),
                        )}
                      />
                    ) : (
                      <Typography.Text type="secondary">
                        {formatStorageBytes(row.processed_bytes || 0)}
                      </Typography.Text>
                    ))}
                </Space>
              ),
            },
            {
              title: t('size'),
              render: (_, row: any) =>
                row.size == null ? '—' : formatStorageBytes(row.size),
            },
            {
              title: t('remoteUploadedAt'),
              render: (_, row: any) => <Time value={row.uploaded_at} />,
            },
            {
              title: t('diagnostics'),
              render: (_, row: any) => (
                <Space direction="vertical">
                  {row.error_code && (
                    <Typography.Text code>{row.error_code}</Typography.Text>
                  )}
                  {row.retry_at && (
                    <Typography.Text>
                      {t('scheduledRetryAt')}: <Time value={row.retry_at} />
                    </Typography.Text>
                  )}
                  {!row.error_code && !row.retry_at && '—'}
                </Space>
              ),
            },
            {
              title: t('actions'),
              render: (_, row: any) =>
                row.status === 'FAILED' && (
                  <Button
                    size="small"
                    disabled={action.busy}
                    onClick={() =>
                      run(async () => {
                        await call(`${ROOT}/uploads/${row.id}/retry`, {
                          method: 'POST',
                          body: {},
                        });
                        await uploads.reload();
                      })
                    }
                  >
                    {t('remoteRetry')}
                  </Button>
                ),
            },
          ]}
        />
        <Typography.Title level={5}>
          {t('remoteStoredObjects')}
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          {t('remoteConfirmationHelp')}
        </Typography.Paragraph>
        <Table
          rowKey="key"
          dataSource={list(objects.data)}
          loading={objects.loading && !objects.data}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          scroll={{ x: 900 }}
          columns={[
            {
              title: t('created'),
              render: (_, row: any) => <Time value={row.created_at} />,
            },
            {
              title: t('backupMode'),
              render: (_, row: any) => t(`backupMode.${row.mode}`),
            },
            {
              title: t('backupSource'),
              render: (_, row: any) => t(`backupSource.${row.source}`),
            },
            {
              title: t('size'),
              render: (_, row: any) => formatStorageBytes(row.size),
            },
            { title: t('id'), dataIndex: 'backup_id' },
            {
              title: t('actions'),
              render: (_, row: any) => (
                <Space>
                  <Button
                    size="small"
                    disabled={action.busy}
                    onClick={() =>
                      run(async () => {
                        saveAs(
                          await call(
                            query(
                              `${ROOT}/targets/${selectedTarget}/download`,
                              { key: row.key },
                            ),
                            { blob: true },
                          ),
                          row.key.split('/').pop() ||
                            `${row.backup_id}.encrypted`,
                        );
                      })
                    }
                  >
                    {t('download')}
                  </Button>
                  <Popconfirm
                    title={t('remoteDeleteObjectConfirm')}
                    onConfirm={() =>
                      action.run(async () => {
                        await call(
                          `${ROOT}/targets/${selectedTarget}/objects`,
                          { method: 'DELETE', body: { key: row.key } },
                        );
                        await Promise.all([objects.reload(), uploads.reload()]);
                      })
                    }
                  >
                    <Button size="small" danger disabled={action.busy}>
                      {t('delete')}
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      {dialog?.kind === 'target' && (
        <FormDialog
          title={t(dialog.value.id ? 'remoteEditTarget' : 'remoteNewTarget')}
          initial={dialog.value}
          onClose={() => setDialog(undefined)}
          onSubmit={async (values) => {
            const keys = [
              'name',
              'type',
              'enabled',
              'endpoint',
              'proxy',
              ...(values.type === 'S3'
                ? [
                    'region',
                    'bucket',
                    'prefix',
                    'access_key_id',
                    'secret_access_key',
                    'session_token',
                    'path_style',
                  ]
                : ['directory', 'username', 'password']),
            ];
            const body = Object.fromEntries(
              keys
                .filter(
                  (key) =>
                    values[key] !== undefined &&
                    (![
                      'secret_access_key',
                      'session_token',
                      'password',
                    ].includes(key) ||
                      values[key] !== ''),
                )
                .map((key) => [key, values[key]]),
            );
            if (values.type === 'S3' && values.clear_session_token)
              body.session_token = '';
            if (values.type === 'WEBDAV' && values.clear_password)
              body.password = '';
            await call(
              `${ROOT}/targets${dialog.value.id ? `/${dialog.value.id}` : ''}`,
              { method: dialog.value.id ? 'PUT' : 'POST', body },
            );
            setTestedId(undefined);
            await reload();
          }}
        >
          <Form.Item name="name" label={t('name')} rules={[required()]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="type" label={t('type')} rules={[required()]}>
            <Select
              options={[
                { value: 'S3', label: 'S3' },
                { value: 'WEBDAV', label: 'WebDAV' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="enabled"
            label={t('enabled')}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="endpoint"
            label={t('remoteEndpoint')}
            rules={[required()]}
          >
            <Input placeholder="https://…" />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(before, after) => before.type !== after.type}
          >
            {({ getFieldValue }) =>
              getFieldValue('type') === 'S3' ? (
                <>
                  <Form.Item
                    name="region"
                    label={t('remoteRegion')}
                    rules={[required()]}
                  >
                    <Input placeholder="us-east-1" />
                  </Form.Item>
                  <Form.Item
                    name="bucket"
                    label={t('remoteBucket')}
                    rules={[required()]}
                  >
                    <Input />
                  </Form.Item>
                  <Form.Item name="prefix" label={t('remotePrefix')}>
                    <Input placeholder="backups" />
                  </Form.Item>
                  <Form.Item
                    name="access_key_id"
                    label={t('remoteAccessKey')}
                    rules={[required()]}
                  >
                    <Input autoComplete="off" />
                  </Form.Item>
                  <Form.Item
                    name="secret_access_key"
                    label={t('remoteSecretKey')}
                    rules={
                      dialog.value.has_secret_access_key ? [] : [required()]
                    }
                    extra={
                      dialog.value.has_secret_access_key
                        ? t('remoteKeepSecret')
                        : undefined
                    }
                  >
                    <Input.Password autoComplete="new-password" />
                  </Form.Item>
                  <Form.Item
                    name="session_token"
                    label={t('remoteSessionToken')}
                    extra={
                      dialog.value.has_session_token
                        ? t('remoteKeepSecret')
                        : undefined
                    }
                  >
                    <Input.Password autoComplete="new-password" />
                  </Form.Item>
                  {dialog.value.has_session_token && (
                    <Form.Item
                      name="clear_session_token"
                      valuePropName="checked"
                    >
                      <Checkbox>{t('remoteClearSessionToken')}</Checkbox>
                    </Form.Item>
                  )}
                  <Form.Item
                    name="path_style"
                    label={t('remotePathStyle')}
                    valuePropName="checked"
                  >
                    <Switch />
                  </Form.Item>
                </>
              ) : (
                <>
                  <Form.Item name="directory" label={t('remoteDirectory')}>
                    <Input placeholder="backups" />
                  </Form.Item>
                  <Form.Item name="username" label={t('remoteUsername')}>
                    <Input autoComplete="off" />
                  </Form.Item>
                  <Form.Item
                    name="password"
                    label={t('remotePassword')}
                    extra={
                      dialog.value.has_password
                        ? t('remoteKeepSecret')
                        : undefined
                    }
                  >
                    <Input.Password autoComplete="new-password" />
                  </Form.Item>
                  {dialog.value.has_password && (
                    <Form.Item name="clear_password" valuePropName="checked">
                      <Checkbox>{t('remoteClearPassword')}</Checkbox>
                    </Form.Item>
                  )}
                </>
              )
            }
          </Form.Item>
          <Form.Item name="proxy" label={t('networkProxy')}>
            <ProxySelect />
          </Form.Item>
          <Typography.Paragraph type="secondary">
            {t('remoteProxyHelp')}
          </Typography.Paragraph>
        </FormDialog>
      )}
      {dialog?.kind === 'settings' && (
        <FormDialog
          title={t('remoteEditSettings')}
          initial={settings.data}
          onClose={() => setDialog(undefined)}
          onSubmit={async (values) => {
            await call(`${ROOT}/settings`, {
              method: 'PUT',
              body: {
                enabled: !!values.enabled,
                target_id: values.target_id || null,
                retain_count: values.retain_count,
                ...(values.passphrase ? { passphrase: values.passphrase } : {}),
              },
            });
            await settings.reload();
          }}
        >
          <Form.Item
            name="enabled"
            label={t('remoteEnabled')}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item name="target_id" label={t('remoteTarget')}>
            <Select allowClear options={targetOptions} />
          </Form.Item>
          <Form.Item
            name="retain_count"
            label={t('remoteRetainCount')}
            rules={[required()]}
          >
            <InputNumber min={1} max={1000} precision={0} />
          </Form.Item>
          <Form.Item
            name="passphrase"
            label={t('remoteRecoveryKey')}
            extra={t(
              settings.data?.has_passphrase
                ? 'remoteKeepSecret'
                : 'remoteKeyRequired',
            )}
          >
            <Input.Password autoComplete="new-password" maxLength={4096} />
          </Form.Item>
          <Alert type="warning" showIcon message={t('remoteRecoveryKeyHelp')} />
        </FormDialog>
      )}
    </>
  );
}
