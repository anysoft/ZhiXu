import { fieldLabel, fieldValue } from '@/utils/presentation';
import { translateEnum, translateError } from '@/utils/i18n';
import { formatDateTime, formatDuration, formatBytes } from '@/utils/format';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { saveAs } from 'file-saver';
import { request } from '@/utils/http';
import config from '@/utils/config';
const base = config.apiPrefix;
export default function BackupSettings() {
  useI18nLocale();
  const [rows, setRows] = useState<any[]>([]),
    [restore, setRestore] = useState<any>(),
    [operation, setOperation] = useState<any>();
  const [dialog, setDialog] = useState<{ kind: string; id?: string } | null>(
      null,
    ),
    [detail, setDetail] = useState<any>(),
    [importId, setImportId] = useState('');
  const [form] = Form.useForm(),
    [file, setFile] = useState<File>(),
    [busy, setBusy] = useState(false);
  const refresh = async () => {
    const [backups, status] = await Promise.all([
      request.get(base + 'backups'),
      request.get(base + 'restore/status'),
    ]);
    setRows(backups.data);
    setRestore(status.data);
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!operation || !['QUEUED', 'RUNNING'].includes(operation.status)) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const response = await request.get(
          base + 'backups/operations/' + operation.id,
        );
        if (stopped) return;
        const value = response.data;
        setOperation(value);
        if (value.status === 'SUCCESS') {
          if (value.kind === 'IMPORT') setImportId(value.result);
          await refresh();
        }
      } catch {
        clearInterval(timer);
      }
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [operation?.id, operation?.status]);
  const active =
    busy || (!!operation && ['QUEUED', 'RUNNING'].includes(operation.status));
  const start = async (url: string, data?: any) => {
    setBusy(true);
    try {
      const response = await request.post(base + url, data);
      setOperation(response.data);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setDialog(null);
    form.resetFields();
    setFile(undefined);
  };
  const submit = async () => {
    const values = await form.validateFields();
    if (!dialog) return;
    if (dialog.kind === 'import') {
      if (!file) {
        message.error(tr('ui.selectAnEncryptedBackupFile'));
        return;
      }
      const data = new FormData();
      data.append('passphrase', values.passphrase);
      data.append('file', file);
      await start('restores/import', data);
    } else if (dialog.kind === 'export')
      await start(`backups/${dialog.id}/export`, {
        passphrase: values.passphrase,
      });
    else
      await start(`restores/${dialog.id}/stage`, {
        confirmation: values.confirmation,
        source: 'imports',
      });
    close();
  };
  return (
    <Space
      direction="vertical"
      size="middle"
      style={{
        width: '100%',
        padding: 16,
        overflow: 'auto',
        maxHeight: 'calc(100vh - 200px)',
      }}
    >
      <Typography.Title level={4}>{tr('ui.backupAmpRestore')}</Typography.Title>
      <Typography.Paragraph>
        {tr(
          'ui.backupsIncludeGitLocalWorktreesConfigurationAndRunHistoryPortableBackupsArePassphraseEncryptedManage',
        )}
      </Typography.Paragraph>
      {restore?.stage === 'PENDING' && (
        <Alert
          type="warning"
          showIcon
          message={tr('ui.restorePendingRestartToRestore')}
          description={tr(
            'ui.newWritesArePausedRestartTheBackendToApplyTheRestoreOfflineOrCancelThePendingRestore',
          )}
          action={
            <Button
              onClick={async () => {
                await request.delete(base + `restores/${restore.id}/stage`);
                setImportId('');
                await refresh();
              }}
            >
              {tr('ui.cancelPendingRestore')}
            </Button>
          }
        />
      )}
      {restore && (
        <Alert
          type={restore.stage === 'COMPLETE' ? 'success' : 'info'}
          message={tr('ui.restoreStatus', {
            status: translateEnum('restoreStage', restore.stage),
          })}
        />
      )}
      <Space wrap>
        <Button
          type="primary"
          disabled={active || restore?.stage === 'PENDING'}
          onClick={() => start('backups')}
        >
          {tr('ui.createBackup')}
        </Button>
        <Button disabled={active} onClick={() => setDialog({ kind: 'import' })}>
          {tr('ui.importEncryptedBackup')}
        </Button>
        <Button onClick={refresh}>{tr('ui.refresh')}</Button>
      </Space>
      {operation && (
        <Alert
          type={
            operation.status === 'FAILED'
              ? 'error'
              : operation.status === 'SUCCESS'
              ? 'success'
              : 'info'
          }
          message={tr('ui.operationStatus', {
            kind: operation.kind
              ? translateEnum('backupKind', operation.kind)
              : tr('ui.operation'),
            status: translateEnum('backupOperation', operation.status),
          })}
          description={
            <Space direction="vertical">
              <span>
                {operation.error_code
                  ? translateError(operation.error_code)
                  : translateEnum('runtimeStage', operation.phase)}{' '}
                · {operation.processed_files || 0} {tr('ui.files')}{' '}
                {operation.processed_bytes || 0} {tr('ui.bytesVariant404')}
              </span>
              {operation.kind === 'EXPORT' &&
                operation.status === 'SUCCESS' && (
                  <Button
                    onClick={async () => {
                      const blob = await request.get<Blob>(
                        base + `backups/exports/${operation.result}/download`,
                        { responseType: 'blob' },
                      );
                      saveAs(blob, operation.result + '.platform-backup');
                    }}
                  >
                    {tr('ui.downloadEncryptedBackup')}
                  </Button>
                )}
            </Space>
          }
        />
      )}
      <Table
        rowKey="id"
        dataSource={rows}
        pagination={{ pageSize: 10 }}
        scroll={{ x: 950 }}
        columns={[
          {
            title: tr('ui.created'),
            dataIndex: 'created_at',
            render: (value: any) => formatDateTime(value),
          },
          {
            title: tr('ui.status'),
            dataIndex: 'status',
            render: (value) => (
              <Tag color="green">{translateEnum('backupOperation', value)}</Tag>
            ),
          },
          { title: tr('ui.schema'), dataIndex: 'schema' },
          {
            title: tr('ui.bytes'),
            dataIndex: 'size',
            render: (value: number) => formatBytes(value),
          },
          {
            title: tr('ui.action'),
            render: (_, row) => (
              <Space wrap>
                <Button
                  size="small"
                  onClick={async () =>
                    setDetail(
                      (await request.get(base + 'backups/' + row.id)).data,
                    )
                  }
                >
                  {tr('ui.details')}
                </Button>
                <Button
                  size="small"
                  disabled={active}
                  onClick={() => start(`backups/${row.id}/validate`)}
                >
                  {tr('ui.verify')}
                </Button>
                <Button
                  size="small"
                  disabled={active}
                  onClick={() => setDialog({ kind: 'export', id: row.id })}
                >
                  {tr('ui.exportEncryptedBackup')}
                </Button>
                <Popconfirm
                  title={tr('ui.deleteThisLocalBackup')}
                  onConfirm={async () => {
                    await request.delete(base + 'backups/' + row.id);
                    await refresh();
                  }}
                >
                  <Button size="small" danger disabled={active}>
                    {tr('ui.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      {importId && (
        <Alert
          type="success"
          message={tr('ui.importedFileVerified')}
          description={
            <Space>
              <Typography.Text code>{importId}</Typography.Text>
              <Button
                disabled={active}
                onClick={() => start(`restores/${importId}/validate`)}
              >
                {tr('ui.verifyImport')}
              </Button>
              <Button
                danger
                disabled={active || restore?.stage === 'PENDING'}
                onClick={() => setDialog({ kind: 'stage', id: importId })}
              >
                {tr('ui.stageRestore')}
              </Button>
            </Space>
          }
        />
      )}
      {restore?.rebuild_plan && (
        <>
          <Typography.Title level={5}>
            {tr('ui.missingManagedResources')}
          </Typography.Title>
          <Descriptions bordered size="small" column={1}>
            {Object.entries(restore.rebuild_plan).map(([key, items]) => (
              <Descriptions.Item key={key} label={fieldLabel(key)}>
                {(items as any[])
                  .map(
                    (item) =>
                      `${item.id}${
                        item.version ? ' (' + item.version + ')' : ''
                      }`,
                  )
                  .join(', ') || '—'}
              </Descriptions.Item>
            ))}
          </Descriptions>
          <Button
            disabled={active || restore.stage !== 'COMPLETE'}
            onClick={() => start('restore/rebuild')}
          >
            {tr('ui.rebuildMissingManagedResources')}
          </Button>
        </>
      )}
      <Modal
        title={
          dialog?.kind === 'import'
            ? tr('ui.importEncryptedBackup')
            : dialog?.kind === 'export'
            ? tr('ui.exportEncryptedBackup')
            : tr('ui.extra.confirmRestore')
        }
        open={!!dialog}
        onCancel={close}
        onOk={submit}
        confirmLoading={busy}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          {dialog?.kind === 'import' && (
            <Form.Item label={tr('ui.backupFile')}>
              <input
                aria-label={tr('ui.backupFile')}
                type="file"
                accept=".platform-backup"
                onChange={(e) => setFile(e.target.files?.[0])}
              />
            </Form.Item>
          )}
          {dialog?.kind === 'stage' ? (
            <>
              <Alert
                type="warning"
                message={tr(
                  'ui.restartingSwitchesTheDataDirectoryExistingDataIsRetainedInAnIsolatedDirectory',
                )}
              />
              <Form.Item
                name="confirmation"
                label={tr('ui.enterRESTORE')}
                rules={[
                  {
                    validator: (_, value) =>
                      value === 'RESTORE'
                        ? Promise.resolve()
                        : Promise.reject(new Error(tr('validation.restore'))),
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
                label={tr('ui.encryptionPassphrase')}
                rules={[{ required: true, min: 12 }]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              {dialog?.kind === 'export' && (
                <Form.Item
                  name="confirm"
                  label={tr('ui.confirmPassphrase')}
                  dependencies={['passphrase']}
                  rules={[
                    { required: true },
                    {
                      validator: (_, value) =>
                        value === form.getFieldValue('passphrase')
                          ? Promise.resolve()
                          : Promise.reject(
                              new Error(tr('validation.passphraseMatch')),
                            ),
                    },
                  ]}
                >
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
              )}
            </>
          )}
        </Form>
      </Modal>
      <Modal
        title={tr('ui.backupDetails')}
        open={!!detail}
        onCancel={() => setDetail(null)}
        footer={null}
      >
        <Descriptions column={1}>
          {detail &&
            Object.entries(detail).map(([key, value]) => (
              <Descriptions.Item key={key} label={fieldLabel(key)}>
                {typeof value === 'object'
                  ? JSON.stringify(value)
                  : fieldValue(key, value, 'backupOperation')}
              </Descriptions.Item>
            ))}
        </Descriptions>
      </Modal>
    </Space>
  );
}
