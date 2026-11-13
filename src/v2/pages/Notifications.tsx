import React, { useState } from 'react';
import {
  Button,
  Checkbox,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
} from 'antd';
import ProviderConfigForm from '../../features/notifications/ProviderConfigForm';
import { createChannelPayload } from '../../features/notifications/channelForm';
import {
  getProviderDefaults,
  providerSchemas,
  validateProviderConfig,
} from '../../features/notifications/providerSchemas';
import { t as tr } from '../../utils/i18n';
import { ApiError, call, list, useAction, useResource } from '../api';
import {
  ErrorPanel,
  FormDialog,
  Page,
  Reload,
  State,
  Time,
  required,
} from '../components';
import { useText } from '../i18n';
function ChannelFields({ editing }: { editing: any }) {
  const t = useText(),
    form = Form.useFormInstance(),
    type = Form.useWatch('type', form) || 'WEBHOOK',
    action = Form.useWatch('secret_action', form),
    providers = useResource('/notification-providers');
  return (
    <>
      <Form.Item name="name" label={t('name')} rules={[required()]}>
        <Input />
      </Form.Item>
      <Form.Item name="type" label={t('channelType')} rules={[required()]}>
        <Select
          onChange={(value) =>
            form.setFieldsValue({
              secret_action: 'REPLACE',
              providerConfig: getProviderDefaults(value),
              confirmClear: false,
            })
          }
          options={list(providers.data).map((value: any) => ({
            value,
            label: providerSchemas[value]
              ? tr(providerSchemas[value].labelKey)
              : value,
          }))}
        />
      </Form.Item>
      <Form.Item name="enabled" valuePropName="checked">
        <Checkbox>{t('enabled')}</Checkbox>
      </Form.Item>
      <Form.Item name="is_default" valuePropName="checked">
        <Checkbox>{t('default')}</Checkbox>
      </Form.Item>
      {editing.id && (
        <Form.Item name="secret_action" label={t('secret')}>
          <Select
            onChange={(value) =>
              form.setFieldsValue({
                providerConfig:
                  value === 'REPLACE' ? getProviderDefaults(type) : undefined,
                confirmClear: false,
              })
            }
            options={[
              { value: 'KEEP', label: t('keepSecret') },
              { value: 'REPLACE', label: t('replaceSecret') },
              { value: 'DELETE', label: t('delete') },
            ]}
          />
        </Form.Item>
      )}
      {action === 'REPLACE' && (
        <ProviderConfigForm provider={type} form={form} />
      )}
      {action === 'DELETE' && (
        <Form.Item
          name="confirmClear"
          valuePropName="checked"
          rules={[
            {
              validator: (_, value) =>
                value
                  ? Promise.resolve()
                  : Promise.reject(new Error(t('required'))),
            },
          ]}
        >
          <Checkbox>{t('confirmSecretDelete')}</Checkbox>
        </Form.Item>
      )}
    </>
  );
}
function Deliveries() {
  const t = useText(),
    data = useResource('/notification-deliveries', 3000),
    action = useAction(),
    [selected, setSelected] = useState<any>(),
    attempts = useResource(
      selected ? `/notification-deliveries/${selected.id}/attempts` : null,
    );
  return (
    <>
      <ErrorPanel error={data.error || action.error || attempts.error} />
      <Table
        rowKey="id"
        dataSource={list(data.data)}
        columns={[
          { title: t('id'), dataIndex: 'id' },
          { title: t('channel'), dataIndex: 'channel_id' },
          { title: t('type'), dataIndex: 'event_type' },
          {
            title: t('status'),
            dataIndex: 'status',
            render: (v) => <State value={v} />,
          },
          { title: t('diagnostics'), dataIndex: 'last_error_code' },
          {
            title: t('actions'),
            render: (_, r: any) => (
              <Space>
                <Button onClick={() => setSelected(r)}>{t('attempts')}</Button>
                {['DEAD', 'FAILED'].includes(r.status) && (
                  <Button
                    onClick={() =>
                      void action.run(async () => {
                        await call(`/notification-deliveries/${r.id}/retry`, {
                          method: 'POST',
                          body: {},
                        });
                        await data.reload();
                      })
                    }
                  >
                    {t('retry')}
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      {selected && (
        <Drawer
          open
          title={t('attempts')}
          width={800}
          onClose={() => setSelected(undefined)}
        >
          <Table
            rowKey="id"
            dataSource={list(attempts.data)}
            columns={[
              { title: t('id'), dataIndex: 'id' },
              {
                title: t('status'),
                dataIndex: 'status',
                render: (v) => <State value={v} />,
              },
              { title: t('diagnostics'), dataIndex: 'error_code' },
              {
                title: t('createdAt'),
                dataIndex: 'created_at',
                render: (v) => <Time value={v} />,
              },
            ]}
          />
        </Drawer>
      )}
    </>
  );
}
export function NotificationPolicy({ taskId }: { taskId: number }) {
  const t = useText(),
    data = useResource(`/tasks/${taskId}/notification-policy`),
    channels = useResource('/notification-channels'),
    [editing, setEditing] = useState(false);
  return (
    <>
      <ErrorPanel error={data.error} />
      <Button onClick={() => setEditing(true)} disabled={!data.data}>
        {t('edit')}
      </Button>
      {data.data && (
        <Space className="v2-section">
          <State value={data.data.enabled ? 'enabled' : 'disabled'} />
          <State value={data.data.channel_mode} />
        </Space>
      )}
      {editing && (
        <FormDialog
          title={t('notifications')}
          initial={data.data}
          onClose={() => setEditing(false)}
          onSubmit={async (v) => {
            const body: any = {
              expected_version: data.data.version,
              channel_mode: v.channel_mode,
              channels: v.channels || [],
              failure_threshold: Number(v.failure_threshold),
              repeat_every_failures: Number(v.repeat_every_failures),
            };
            for (const key of [
              'enabled',
              'notify_success',
              'notify_failure',
              'notify_timeout',
              'notify_interrupted',
              'notify_cancelled',
              'notify_recovery',
            ])
              body[key] = !!v[key];
            await call(`/tasks/${taskId}/notification-policy`, {
              method: 'PATCH',
              body,
            });
            await data.reload();
          }}
        >
          {[
            'enabled',
            'notify_success',
            'notify_failure',
            'notify_timeout',
            'notify_interrupted',
            'notify_cancelled',
            'notify_recovery',
          ].map((key) => (
            <Form.Item key={key} name={key} valuePropName="checked">
              <Checkbox>{t(key)}</Checkbox>
            </Form.Item>
          ))}
          <Form.Item name="channel_mode" label={t('channelMode')}>
            <Select
              options={['DEFAULT', 'EXPLICIT', 'NONE'].map((value) => ({
                value,
                label: t('status.' + value),
              }))}
            />
          </Form.Item>
          <Form.Item name="channels" label={t('notificationChannels')}>
            <Select
              mode="multiple"
              options={list(channels.data)
                .filter((c: any) => !c.archived)
                .map((c: any) => ({ value: c.id, label: c.name }))}
            />
          </Form.Item>
          <Form.Item
            name="failure_threshold"
            label={t('failureThreshold')}
            rules={[required()]}
          >
            <Input type="number" min={1} />
          </Form.Item>
          <Form.Item
            name="repeat_every_failures"
            label={t('repeatEveryFailures')}
            rules={[required()]}
          >
            <Input type="number" min={0} />
          </Form.Item>
        </FormDialog>
      )}
    </>
  );
}
export default function NotificationsPage() {
  const t = useText(),
    data = useResource('/notification-channels'),
    action = useAction(),
    [editing, setEditing] = useState<any>();
  return (
    <Page title={t('notifications')}>
      <Tabs
        destroyInactiveTabPane
        items={[
          {
            key: 'channels',
            label: t('notificationChannels'),
            children: (
              <>
                <div className="v2-toolbar">
                  <Button
                    type="primary"
                    onClick={() =>
                      setEditing({
                        name: '',
                        type: 'WEBHOOK',
                        enabled: true,
                        is_default: true,
                        secret_action: 'REPLACE',
                        providerConfig: getProviderDefaults('WEBHOOK'),
                      })
                    }
                  >
                    {t('newChannel')}
                  </Button>
                  <Reload onClick={() => void data.reload()} />
                </div>
                <ErrorPanel error={data.error || action.error} />
                <Table
                  rowKey="id"
                  dataSource={list(data.data)}
                  columns={[
                    { title: t('name'), dataIndex: 'name' },
                    {
                      title: t('channelType'),
                      dataIndex: 'type',
                      render: (v) =>
                        providerSchemas[v]
                          ? tr(providerSchemas[v].labelKey)
                          : v,
                    },
                    {
                      title: t('status'),
                      dataIndex: 'enabled',
                      render: (v) => (
                        <State value={v ? 'enabled' : 'disabled'} />
                      ),
                    },
                    {
                      title: t('default'),
                      dataIndex: 'is_default',
                      render: (v) => t(v ? 'yes' : 'no'),
                    },
                    {
                      title: t('secret'),
                      dataIndex: 'secret_configured',
                      render: (v) => t(v ? 'configured' : 'missing'),
                    },
                    {
                      title: t('actions'),
                      render: (_, r: any) =>
                        !r.archived && (
                          <Space>
                            <Button
                              onClick={() =>
                                setEditing({
                                  ...r,
                                  secret_action: 'KEEP',
                                  providerConfig: undefined,
                                })
                              }
                            >
                              {t('edit')}
                            </Button>
                            <Button
                              onClick={() =>
                                void action.run(async () => {
                                  await call(
                                    `/notification-channels/${r.id}/test`,
                                    { method: 'POST', body: {} },
                                  );
                                })
                              }
                            >
                              {t('test')}
                            </Button>
                            <Popconfirm
                              title={t('confirmDelete')}
                              onConfirm={() =>
                                action.run(async () => {
                                  await call(`/notification-channels/${r.id}`, {
                                    method: 'DELETE',
                                    body: { expected_version: r.version },
                                  });
                                  await data.reload();
                                })
                              }
                            >
                              <Button danger>{t('delete')}</Button>
                            </Popconfirm>
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
            label: t('deliveryHistory'),
            children: <Deliveries />,
          },
        ]}
      />
      {editing && (
        <FormDialog
          title={t(editing.id ? 'edit' : 'newChannel')}
          initial={editing}
          width={760}
          onClose={() => setEditing(undefined)}
          onSubmit={async (v) => {
            if (
              v.secret_action === 'REPLACE' &&
              validateProviderConfig(v.type, v.providerConfig || {}).length
            )
              throw new ApiError(400, 'CHANNEL_CONFIG_INVALID');
            await call(
              '/notification-channels' + (editing.id ? '/' + editing.id : ''),
              {
                method: editing.id ? 'PATCH' : 'POST',
                body: createChannelPayload(v, editing.id ? editing : undefined),
              },
            );
            await data.reload();
          }}
        >
          <ChannelFields editing={editing} />
        </FormDialog>
      )}
    </Page>
  );
}
