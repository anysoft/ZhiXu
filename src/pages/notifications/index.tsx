import { translateError } from '@/utils/i18n';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  message,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import { obsGet, DeliveryTable } from '@/components/observability';
export default function NotificationChannelsPage() {
  useI18nLocale();
  const [rows, setRows] = useState<any[]>([]),
    [providers, setProviders] = useState<string[]>([]),
    [editing, setEditing] = useState<any>();
  const [form] = Form.useForm();
  const action = Form.useWatch('secret_action', form);
  const load = () => obsGet('notification-channels').then(setRows);
  useEffect(() => {
    void load();
    void obsGet('notification-providers').then(setProviders);
  }, []);
  const edit = (r?: any) => {
    setEditing(r ?? {});
    form.resetFields();
    form.setFieldsValue(
      r
        ? {
            ...r,
            enabled: !!r.enabled,
            is_default: !!r.is_default,
            secret_action: 'KEEP',
          }
        : {
            type: 'WEBHOOK',
            enabled: true,
            is_default: true,
            secret_action: 'REPLACE',
          },
    );
  };
  const save = async () => {
    try {
      const v = await form.validateFields();
      const body = {
        ...v,
        ...(v.secret_action === 'REPLACE'
          ? { secret: JSON.parse(v.secret) }
          : { secret: undefined }),
        expected_version: editing.version,
      };
      const r = editing.id
        ? await request.patch<any, any>(
            config.apiPrefix + `notification-channels/${editing.id}`,
            body,
          )
        : await request.post<any>(
            config.apiPrefix + 'notification-channels',
            body,
          );
      if (r.code === 200) {
        setEditing(undefined);
        form.resetFields();
        await load();
      } else message.error(translateError(r.error_code));
    } catch {
      message.error(tr('ui.checkTheChannelFieldsAndSecretJSON'));
    }
  };
  return (
    <Card title={tr('ui.notifications')}>
      <Tabs
        items={[
          {
            key: 'channels',
            label: tr('ui.channels'),
            children: (
              <>
                <Button type="primary" onClick={() => edit()}>
                  {tr('ui.addChannel')}
                </Button>
                <Table
                  rowKey="id"
                  dataSource={rows}
                  columns={[
                    { title: tr('ui.name'), dataIndex: 'name' },
                    { title: tr('ui.provider'), dataIndex: 'type' },
                    {
                      title: tr('ui.enabled'),
                      dataIndex: 'enabled',
                      render: (v) =>
                        v ? tr('ui.extra.yes') : tr('ui.extra.no'),
                    },
                    {
                      title: tr('ui.default'),
                      dataIndex: 'is_default',
                      render: (v) =>
                        v ? tr('ui.extra.yes') : tr('ui.extra.no'),
                    },
                    {
                      title: tr('ui.secret'),
                      dataIndex: 'secret_configured',
                      render: (v) =>
                        v
                          ? tr('ui.presentation.Configured')
                          : tr('ui.presentation.Missing'),
                    },
                    {
                      title: tr('ui.actions'),
                      render: (_, r) => (
                        <Space>
                          <Button
                            disabled={!!r.archived}
                            onClick={() => edit(r)}
                          >
                            {tr('ui.edit')}
                          </Button>
                          <Button
                            disabled={!r.enabled}
                            onClick={async () => {
                              await request.post(
                                config.apiPrefix +
                                  `notification-channels/${r.id}/test`,
                              );
                              message.info(
                                tr('ui.testNotificationQueuedSeeDeliveries'),
                              );
                            }}
                          >
                            {tr('ui.test')}
                          </Button>
                          <Button
                            disabled={!!r.archived}
                            danger
                            onClick={() =>
                              Modal.confirm({
                                title: tr('ui.archiveChannel'),
                                content: tr(
                                  'ui.extra.deliveryHistoryIsRetainedPendingDeliveriesWillFailWithCHANNELDISABLED',
                                ),
                                onOk: async () => {
                                  await request.delete(
                                    config.apiPrefix +
                                      `notification-channels/${r.id}`,
                                    { data: { expected_version: r.version } },
                                  );
                                  await load();
                                },
                              })
                            }
                          >
                            {tr('ui.archive')}
                          </Button>
                        </Space>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'deliveries',
            label: tr('ui.deliveries'),
            children: <DeliveryTable />,
          },
        ]}
      />
      <Modal
        open={!!editing}
        title={tr('ui.notificationChannel')}
        onCancel={() => {
          setEditing(undefined);
          form.resetFields();
        }}
        onOk={save}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label={tr('ui.name')}
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="type"
            label={tr('ui.provider')}
            rules={[{ required: true }]}
          >
            <Select
              options={providers.map((value) => ({ value, label: value }))}
            />
          </Form.Item>
          <Form.Item
            name="enabled"
            label={tr('ui.enabled')}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="is_default"
            label={tr('ui.defaultChannel')}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item name="secret_action" label={tr('ui.secretAction')}>
            <Select
              options={['KEEP', 'REPLACE', 'DELETE'].map((value) => ({
                value,
                label: value,
              }))}
            />
          </Form.Item>
          <Alert
            message={tr(
              'ui.webhookUrlHttpsAuthorizationBearerOtherProvidersUseTheirExistingNamedFieldsAllConnectionFieldsArePro',
            )}
          />
          {action === 'REPLACE' && (
            <Form.Item
              name="secret"
              label={tr('ui.secretConfigurationJSON')}
              rules={[{ required: true }]}
            >
              <Input.TextArea autoComplete="off" rows={5} />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Card>
  );
}
