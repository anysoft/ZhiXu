import { translateEnum, translateError } from '@/utils/i18n';
import { formatDateTime, formatDuration, formatBytes } from '@/utils/format';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import React, { useEffect, useState } from 'react';
import { Button, Space, Table, Tag } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

export default function RepositoryEnvironment({ id }: { id: number }) {
  useI18nLocale();
  const [profiles, setProfiles] = useState<any[]>([]);
  useEffect(() => {
    request
      .get(`${config.apiPrefix}scoped-env/repositories/${id}/profiles`)
      .then((r) => {
        if (r.code === 200) setProfiles(r.data);
      })
      .catch(() => {});
  }, [id]);
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Button href={`${config.baseUrl}scoped-env?repository=${id}`}>
        {tr('ui.manageEnvironmentProfiles')}
      </Button>
      <Table
        rowKey="id"
        dataSource={profiles}
        columns={[
          { title: tr('ui.profile'), dataIndex: 'name' },
          {
            title: tr('ui.default'),
            render: (_: any, row: any) =>
              row.is_default && <Tag>{tr('ui.default')}</Tag>,
          },
          {
            title: tr('ui.status'),
            dataIndex: 'status',
            render: (value: unknown) =>
              translateEnum('repositoryAvailability', value),
          },
          { title: tr('ui.variables'), dataIndex: 'variables_count' },
          {
            title: tr('ui.usedBy'),
            render: (_: any, row: any) =>
              tr('ui.presentation.references', {
                a: row.used_by.subscriptions,
                b: row.used_by.tasks,
              }),
          },
        ]}
      />
    </Space>
  );
}
