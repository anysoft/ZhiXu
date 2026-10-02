import { formatDateTime } from '@/utils/format';
import { t as tr } from '@/utils/i18n';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import intl from 'react-intl-universal';
import React, { useEffect, useState } from 'react';
import { Table, Tag, Button, Popconfirm, message } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import dayjs from 'dayjs';

enum LoginStatus {
  '成功',
  '失败',
}

enum LoginStatusColor {
  'success',
  'error',
}

const LoginLog = ({ data, height }: { data: Array<any>; height: number }) => {
  useI18nLocale();
  const [blockedIps, setBlockedIps] = useState<string[]>([]);

  const getIpBlacklist = () => {
    request
      .get(`${config.apiPrefix}user/ip-blacklist`)
      .then(({ code, data }) => {
        if (code === 200) {
          setBlockedIps(data || []);
        }
      });
  };

  useEffect(() => {
    getIpBlacklist();
  }, []);

  const updateIpBlacklist = async (ip: string, blocked: boolean) => {
    const response = blocked
      ? await request.delete(`${config.apiPrefix}user/ip-blacklist`, {
          data: { ip },
        })
      : await request.put(`${config.apiPrefix}user/ip-blacklist`, { ip });
    if (response.code === 200) {
      setBlockedIps(response.data || []);
      message.success(intl.get('更新成功'));
    }
  };

  const columns = [
    {
      title: intl.get('序号'),
      width: 50,
      render: (text: string, record: any, index: number) => index + 1,
    },
    {
      title: intl.get('登录时间'),
      dataIndex: 'timestamp',
      key: 'timestamp',
      width: 120,
      render: (text: string, record: any) => formatDateTime(record.timestamp),
    },
    {
      title: intl.get('登录地址'),
      dataIndex: 'address',
      width: 120,
      key: 'address',
    },
    {
      title: intl.get('登录IP'),
      dataIndex: 'ip',
      width: 100,
      key: 'ip',
    },
    {
      title: intl.get('登录设备'),
      dataIndex: 'platform',
      key: 'platform',
      width: 80,
    },
    {
      title: intl.get('登录状态'),
      dataIndex: 'status',
      key: 'status',
      width: 80,
      render: (text: string, record: any) => (
        <Tag color={LoginStatusColor[record.status]} style={{ marginRight: 0 }}>
          {intl.get(LoginStatus[record.status])}
        </Tag>
      ),
    },
    {
      title: intl.get('操作'),
      key: 'action',
      width: 100,
      render: (text: string, record: any) => {
        if (!record.ip || record.status !== 1) {
          return null;
        }
        const blocked = blockedIps.includes(record.ip);
        const label = blocked
          ? tr('ui.extra.removeFromBlocklist')
          : tr('ui.extra.addToBlocklist');
        return (
          <Popconfirm
            title={
              blocked
                ? tr('ui.extra.confirmRemovalFromIPBlocklist')
                : tr('ui.extra.confirmAddingToIPBlocklist')
            }
            onConfirm={() => updateIpBlacklist(record.ip, blocked)}
          >
            <Button type="link" danger={!blocked} size="small">
              {label}
            </Button>
          </Popconfirm>
        );
      },
    },
  ];

  return (
    <>
      <Table
        columns={columns}
        pagination={false}
        dataSource={data}
        rowKey={(record) => `${record.ip}-${record.timestamp}`}
        size="middle"
        scroll={{ x: 1000, y: height }}
      />
    </>
  );
};

export default LoginLog;
