import React from 'react';
import { Alert, Table } from 'antd';
import { Details, Fingerprint, State, Time } from '../components';
import { useText } from '../i18n';
export function BackupManifest({ value }: { value: any }) {
  const t = useText();
  if (!value) return null;
  return (
    <>
      <Details
        values={[
          ['id', value.id],
          ['createdAt', <Time value={value.created_at} />],
          [
            'status',
            <State value={value.validation?.status || value.status} />,
          ],
          ['schemaVersion', value.schema?.identity],
          ['files', value.file_count],
          ['size', value.size],
          ['workspaces', value.counts?.workspaces],
          ['tasks', value.counts?.tasks],
          ['preservationHolds', t(value.held ? 'yes' : 'no')],
        ]}
      />
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
