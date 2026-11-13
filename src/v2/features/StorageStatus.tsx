import React from 'react';
import { Card, Typography } from 'antd';
import { useResource } from '../api';
import { Details, ErrorPanel } from '../components';
import { useText } from '../i18n';
export function StorageStatus({ system }: { system: any }) {
  const t = useText(),
    usage = useResource('/backups/usage', 10000);
  return (
    <Card title={t('storageStatus')}>
      <ErrorPanel error={usage.error} />
      <Details
        values={[
          [
            'status',
            system?.local_write_admission === true
              ? t('ready')
              : system?.local_write_admission?.status || t('notReady'),
          ],
          ['liveStorage', usage.data?.live_storage_bytes],
          ['preservationStorage', usage.data?.preservation_storage_bytes],
          ['preservationHolds', usage.data?.active_holds],
          ['backup', usage.data?.snapshots],
          ['retainedStorage', usage.data?.retained_bytes],
          ['freeStorage', usage.data?.free_bytes],
          ['snapshotQuota', usage.data?.limits?.snapshot_bytes],
          ['retainedQuota', usage.data?.limits?.retained_bytes],
          ['temporaryQuota', usage.data?.limits?.temporary_bytes],
          ['minimumFree', usage.data?.limits?.minimum_free_bytes],
        ]}
      />
      <Typography.Paragraph className="v2-section">
        {t('storageHelp')}
      </Typography.Paragraph>
    </Card>
  );
}
