import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Typography,
} from 'antd';
import { saveAs } from 'file-saver';
import { ApiError, call, list, useAction, useResource } from '../api';
import {
  Details,
  ErrorPanel,
  FormDialog,
  Page,
  Reload,
  State,
  Time,
  required,
} from '../components';
import { getLanguagePreference, setLanguagePreference, useText } from '../i18n';
import { StorageStatus } from '../features/StorageStatus';
import { StorageMaintenance } from '../features/StorageMaintenance';
import { SecuritySettings } from '../features/SecuritySettings';
import { ProxyManagement } from '../features/Proxy';
import { BackupManifest } from '../features/BackupManifest';
function BackupRestore() {
  const t = useText(),
    data = useResource('/backups'),
    restore = useResource('/restore/status', 3000),
    action = useAction(),
    [operationId, setOperationId] = useState<string>(),
    operation = useResource(
      operationId ? '/backups/operations/' + operationId : null,
      1500,
    ),
    [dialog, setDialog] = useState<any>(),
    [file, setFile] = useState<File>(),
    [importId, setImportId] = useState(''),
    [detail, setDetail] = useState<any>(),
    [validated, setValidated] = useState<string>(),
    [validatedSnapshot, setValidatedSnapshot] = useState<string>();
  const current = operation.data,
    active =
      action.busy ||
      (!!operationId && !current) ||
      ['QUEUED', 'RUNNING'].includes(current?.status);
  const importedPreview = useResource(
    importId && validated === importId
      ? `/restores/${importId}/preview?source=imports`
      : null,
  );
  useEffect(() => {
    if (current?.status === 'SUCCESS') {
      void data.reload();
      void restore.reload();
      if (current.kind === 'IMPORT')
        setImportId(
          typeof current.result === 'string'
            ? current.result
            : current.result?.id || '',
        );
      if (current.kind === 'VALIDATE_IMPORT') setValidated(importId);
    }
  }, [current?.id, current?.status]);
  const start = async (path: string, body: any = {}) => {
    const op = await call(path, { method: 'POST', body });
    setOperationId(op.id);
  };
  return (
    <>
      <Alert type="info" showIcon message={t('restoreHelp')} />
      <div className="v2-toolbar v2-section">
        <Space wrap>
          <Button
            type="primary"
            disabled={active || restore.data?.stage === 'PENDING'}
            onClick={() => void action.run(() => start('/backups'))}
          >
            {t('newBackup')}
          </Button>
          <Button
            disabled={active}
            onClick={() => setDialog({ kind: 'import' })}
          >
            {t('importBackup')}
          </Button>
          <Reload
            onClick={() => {
              void data.reload();
              void restore.reload();
            }}
          />
        </Space>
      </div>
      <ErrorPanel
        error={data.error || restore.error || operation.error || action.error}
      />
      {current && (
        <Card className="v2-section" title={t('operations')}>
          <Details
            values={[
              ['operationId', current.id],
              ['type', current.kind],
              ['status', <State value={current.status} />],
              ['phase', current.phase],
              ['files', current.processed_files],
              ['size', current.processed_bytes],
              ['diagnostics', current.error_code],
            ]}
          />
          {current.status === 'SUCCESS' && current.kind === 'EXPORT' && (
            <Button
              className="v2-section"
              onClick={() =>
                void action.run(async () => {
                  const id =
                    typeof current.result === 'string'
                      ? current.result
                      : current.result?.id;
                  if (!id) throw new ApiError(409, 'BACKUP_EXPORT_INVALID');
                  saveAs(
                    await call(`/backups/exports/${id}/download`, {
                      blob: true,
                    }),
                    `${id}.platform-backup`,
                  );
                })
              }
            >
              {t('download')}
            </Button>
          )}
        </Card>
      )}
      {restore.data && (
        <Card className="v2-section" title={t('restoreStatus')}>
          <Details
            values={[
              ['id', restore.data.id],
              ['phase', <State value={restore.data.stage} />],
              [
                'diagnostics',
                restore.data.error_code || restore.data.recovery_reason,
              ],
            ]}
          />
          {restore.data.stage === 'PENDING' && (
            <Alert
              className="v2-section"
              type="warning"
              message={t('restartRequired')}
              action={
                <Button
                  onClick={() =>
                    void action.run(async () => {
                      await call(`/restores/${restore.data.id}/stage`, {
                        method: 'DELETE',
                      });
                      await restore.reload();
                    })
                  }
                >
                  {t('cancel')}
                </Button>
              }
            />
          )}
          <Button
            className="v2-section"
            disabled={active}
            onClick={() => void action.run(() => start('/restore/rebuild'))}
          >
            {t('rebuild')}
          </Button>
        </Card>
      )}
      {importId && (
        <Card className="v2-section" title={t('importBackup')}>
          <Typography.Text code>{importId}</Typography.Text>
          <Space className="v2-section">
            <Button
              disabled={active}
              onClick={() =>
                void action.run(() => start(`/restores/${importId}/validate`))
              }
            >
              {t('restorePreview')}
            </Button>
            <Button
              disabled={
                active || validated !== importId || !importedPreview.data
              }
              onClick={() =>
                setDialog({ kind: 'stage', id: importId, source: 'imports' })
              }
            >
              {t('stageRestore')}
            </Button>
          </Space>
          <ErrorPanel error={importedPreview.error} />
          <BackupManifest value={importedPreview.data} />
        </Card>
      )}
      <Table
        className="v2-section"
        rowKey="id"
        dataSource={list(data.data)}
        columns={[
          { title: t('id'), dataIndex: 'id' },
          {
            title: t('createdAt'),
            render: (_, r: any) => <Time value={r.created_at || r.createdAt} />,
          },
          {
            title: t('status'),
            render: (_, r: any) => <State value={r.status || r.state} />,
          },
          {
            title: t('size'),
            render: (_, r: any) =>
              r.bytes ?? r.size ?? r.total_bytes ?? r.size_bytes,
          },
          {
            title: t('actions'),
            render: (_, r: any) => (
              <Space wrap>
                <Button
                  disabled={active}
                  onClick={() =>
                    void action.run(async () => {
                      setDetail(await call(`/backups/${r.id}`));
                      setValidatedSnapshot(r.id);
                    })
                  }
                >
                  {t('validate')}
                </Button>
                <Button
                  disabled={active}
                  onClick={() =>
                    void action.run(() => start(`/backups/${r.id}/validate`))
                  }
                >
                  {t('verifyBackup')}
                </Button>
                <Button
                  disabled={active}
                  onClick={() => setDialog({ kind: 'export', id: r.id })}
                >
                  {t('exportEncrypted')}
                </Button>
                <Button
                  disabled={active || validatedSnapshot !== r.id}
                  onClick={() =>
                    setDialog({ kind: 'stage', id: r.id, source: 'snapshots' })
                  }
                >
                  {t('stageRestore')}
                </Button>
                <Popconfirm
                  title={t('confirmDelete')}
                  onConfirm={() =>
                    action.run(async () => {
                      await call(`/backups/${r.id}`, { method: 'DELETE' });
                      await data.reload();
                    })
                  }
                >
                  <Button danger disabled={active}>
                    {t('delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      {detail && (
        <Card title={t('verifyBackup')}>
          <BackupManifest value={detail} />
        </Card>
      )}
      {dialog && (
        <FormDialog
          title={t(
            dialog.kind === 'import'
              ? 'importBackup'
              : dialog.kind === 'export'
              ? 'exportEncrypted'
              : 'stageRestore',
          )}
          initial={{ passphrase: '', confirmation: '' }}
          onClose={() => {
            setDialog(undefined);
            setFile(undefined);
          }}
          onSubmit={async (v) => {
            if (dialog.kind === 'import') {
              if (!file) throw new ApiError(400, 'BACKUP_UPLOAD_REQUIRED');
              const form = new FormData();
              form.append('file', file);
              form.append('passphrase', v.passphrase);
              await start('/restores/import', form);
            } else if (dialog.kind === 'export')
              await start(`/backups/${dialog.id}/export`, {
                passphrase: v.passphrase,
              });
            else
              await start(`/restores/${dialog.id}/stage`, {
                confirmation: v.confirmation,
                source: dialog.source,
              });
          }}
        >
          {dialog.kind === 'import' && (
            <Form.Item label={t('backupFile')} required>
              <input
                aria-label={t('backupFile')}
                type="file"
                accept=".platform-backup,application/octet-stream"
                onChange={(e) => setFile(e.target.files?.[0])}
              />
            </Form.Item>
          )}
          {dialog.kind === 'stage' ? (
            <>
              <Alert
                className="v2-section"
                type="warning"
                message={t('restartRequired')}
              />
              <Form.Item
                name="confirmation"
                label={t('restoreConfirm')}
                rules={[
                  {
                    validator: (_, v) =>
                      v === 'RESTORE'
                        ? Promise.resolve()
                        : Promise.reject(new Error(t('restoreConfirm'))),
                  },
                ]}
              >
                <Input autoComplete="off" />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item
                name="passphrase"
                label={t('passphrase')}
                rules={[required()]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              {dialog.kind === 'export' && (
                <Form.Item
                  name="confirm"
                  label={t('passwordConfirm')}
                  dependencies={['passphrase']}
                  rules={[
                    required(),
                    ({ getFieldValue }) => ({
                      validator: (_, v) =>
                        v === getFieldValue('passphrase')
                          ? Promise.resolve()
                          : Promise.reject(new Error(t('passwordMismatch'))),
                    }),
                  ]}
                >
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
              )}
            </>
          )}
        </FormDialog>
      )}
    </>
  );
}
export default function SettingsPage() {
  const t = useText(),
    system = useResource('/system', 5000),
    user = useResource('/user');
  return (
    <Page title={t('settings')}>
      <Tabs
        destroyInactiveTabPane
        items={[
          {
            key: 'general',
            label: t('general'),
            children: (
              <Card>
                <Form layout="vertical">
                  <Form.Item label={t('languagePreference')}>
                    <Select
                      value={getLanguagePreference()}
                      onChange={setLanguagePreference}
                      options={[
                        { value: 'system', label: t('systemLanguage') },
                        { value: 'en-US', label: 'English' },
                        { value: 'zh-CN', label: '简体中文' },
                      ]}
                    />
                  </Form.Item>
                </Form>
                <ErrorPanel error={system.error} />
                <Details
                  values={[
                    ['instance', 'v2'],
                    [
                      'systemVersion',
                      system.data?.version || system.data?.build?.version,
                    ],
                    [
                      'schemaVersion',
                      system.data?.schema_version ||
                        system.data?.schema_identity,
                    ],
                    [
                      'status',
                      system.data?.ready === undefined
                        ? '—'
                        : t(system.data.ready ? 'ready' : 'notReady'),
                    ],
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'proxies',
            label: t('proxyManagement'),
            children: <ProxyManagement />,
          },
          {
            key: 'storage',
            label: t('storage'),
            children: <StorageStatus system={system.data} />,
          },
          {
            key: 'maintenance',
            label: t('storageMaintenance'),
            children: <StorageMaintenance />,
          },
          {
            key: 'security',
            label: t('security'),
            children: <SecuritySettings />,
          },
          {
            key: 'backup',
            label: t('backupRestore'),
            children: <BackupRestore />,
          },
        ]}
      />
    </Page>
  );
}
