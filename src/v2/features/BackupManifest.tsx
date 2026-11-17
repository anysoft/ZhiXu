import React from 'react';
import { Alert, Table } from 'antd';
import { Details, Fingerprint, State, Time } from '../components';
import { useText } from '../i18n';
import { formatStorageBytes } from './History';
export function backupMode(value: any): 'FULL' | 'LIGHTWEIGHT' {
  return value?.backup_mode === 'LIGHTWEIGHT' || value?.mode === 'LIGHTWEIGHT'
    ? 'LIGHTWEIGHT'
    : 'FULL';
}
export function backupRequiresRemote(value: any): boolean {
  return value?.restore_requires_remote ?? backupMode(value) === 'LIGHTWEIGHT';
}
export function BackupManifest({ value }: { value: any }) {
  const t = useText();
  if (!value) return null;
  const warnings: string[] = value.validation?.warnings || value.warnings || [];
  return (
    <>
      <Details
        values={[
          ['id', value.id],
          ['createdAt', <Time value={value.created_at} />],
          [
            'backupSource',
            t(
              value.source === 'SCHEDULED'
                ? 'backupSource.SCHEDULED'
                : 'backupSource.MANUAL',
            ),
          ],
          ['backupMode', t(`backupMode.${backupMode(value)}`)],
          [
            'backupRecoveryDependency',
            t(
              backupRequiresRemote(value)
                ? 'backupRecoveryRemote'
                : 'backupRecoveryLocal',
            ),
          ],
          [
            'status',
            <State value={value.validation?.status || value.status} />,
          ],
          ['schemaVersion', value.schema?.identity],
          ['files', value.file_count],
          ['size', formatStorageBytes(value.size)],
          ['workspaces', value.counts?.workspaces],
          ['tasks', value.counts?.tasks],
          ['preservationHolds', t(value.held ? 'yes' : 'no')],
        ]}
      />
      {backupRequiresRemote(value) &&
        !warnings.includes('LIGHTWEIGHT_REQUIRES_REMOTE_GIT_BASE') && (
          <Alert
            className="v2-section"
            type="warning"
            showIcon
            message={t('backupLightweightHelp')}
          />
        )}
      {warnings.map((warning: string, index: number) => (
        <Alert
          key={index}
          className="v2-section"
          type="warning"
          showIcon
          message={
            warning === 'LIGHTWEIGHT_REQUIRES_REMOTE_GIT_BASE'
              ? t('backupLightweightHelp')
              : warning === 'FULL_GIT_LFS_EXTERNAL_DATA_WARNING'
              ? t('backupFullLfsWarning')
              : warning === 'FULL_GIT_SUBMODULE_EXTERNAL_DATA_WARNING'
              ? t('backupFullSubmoduleWarning')
              : warning
          }
        />
      ))}
      {value.restart_required && (
        <Alert
          className="v2-section"
          type="warning"
          showIcon
          message={t('restartRequired')}
        />
      )}
      <Table
        className="v2-section"
        rowKey="workspace_id"
        pagination={false}
        dataSource={value.workspaces || []}
        columns={[
          { title: t('workspace'), dataIndex: 'workspace_id' },
          {
            title: t('type'),
            dataIndex: 'type',
            render: (v) => <State value={v} />,
          },
          {
            title: t('status'),
            dataIndex: 'lifecycle_state',
            render: (v) => <State value={v} />,
          },
          { title: t('sourceGeneration'), dataIndex: 'source_generation' },
          { title: t('contentRevision'), dataIndex: 'content_revision' },
          {
            title: t('inventoryHash'),
            dataIndex: 'content_inventory_hash',
            render: (v) => <Fingerprint value={v} />,
          },
          { title: t('files'), dataIndex: 'file_count' },
        ]}
      />
    </>
  );
}
