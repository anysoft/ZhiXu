import { translateError } from '@/utils/i18n';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Divider,
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
import ProviderConfigForm from '@/features/notifications/ProviderConfigForm';
import {
  getProviderDefaults,
  providerSchemas,
  validateProviderConfig,
} from '@/features/notifications/providerSchemas';
import {
  createChannelPayload,
  ChannelFormValues,
} from '@/features/notifications/channelForm';
export default function NotificationChannelsPage() {
  const locale = useI18nLocale();
  const [rows, setRows] = useState<any[]>([]),
    [providers, setProviders] = useState<string[]>([]),
    [editing, setEditing] = useState<any>();
  const [form] = Form.useForm();
  const action = Form.useWatch('secret_action', form);
  const provider = Form.useWatch('type', form);
  const [saving, setSaving] = useState(false);
  const saveInProgress = useRef(false);
  const [validationAttempt, setValidationAttempt] = useState(0);
  const load = () => obsGet('notification-channels').then(setRows);
  useEffect(() => {
    void load();
    void obsGet('notification-providers').then(setProviders);
  }, []);
  useEffect(() => {
    if (!editing) return;
    const names = form
      .getFieldsError()
      .filter((field) => field.errors.length)
      .map((field) => field.name);
    if (!names.length) return;
    void form
      .validateFields(names)
      .catch(() => {})
      .finally(() => {
        if (form.getFieldValue('secret_action') !== 'REPLACE') return;
        const issues = validateProviderConfig(
          form.getFieldValue('type'),
          form.getFieldValue('providerConfig') || {},
        );
        form.setFields(
          issues
            .filter((issue) =>
              names.some(
                (name) => name.join('.') === 'providerConfig.' + issue.field,
              ),
            )
            .map((issue) => ({
              name: ['providerConfig', issue.field],
              errors: [tr(issue.messageKey)],
            })),
        );
      });
  }, [locale]);
  const closeEditor = () => {
    form.resetFields();
    form.setFieldValue('providerConfig', undefined);
    setEditing(undefined);
  };
  const edit = (r?: any) => {
    setValidationAttempt(0);
    form.resetFields();
    setEditing(r ?? {});
    form.setFieldsValue({
      name: r?.name || '',
      type: r?.type || 'WEBHOOK',
      enabled: r ? !!r.enabled : true,
      is_default: r ? !!r.is_default : true,
      secret_action: r ? 'KEEP' : 'REPLACE',
      confirmClear: false,
      providerConfig: r ? undefined : getProviderDefaults('WEBHOOK'),
    });
  };
  const changeProvider = (value: string) => {
    setValidationAttempt(0);
    form.setFieldsValue({ secret_action: 'REPLACE', confirmClear: false });
    form.setFieldValue('providerConfig', getProviderDefaults(value));
  };
  const changeAction = (value: string) => {
    form.setFieldValue('confirmClear', false);
    form.setFieldValue(
      'providerConfig',
      value === 'REPLACE' ? getProviderDefaults(provider) : undefined,
    );
  };
  const save = async () => {
    if (saveInProgress.current) return;
    saveInProgress.current = true;
    setSaving(true);
    try {
      const v = (await form.validateFields()) as ChannelFormValues;
      if (v.secret_action === 'REPLACE') {
        const issues = validateProviderConfig(v.type, v.providerConfig || {});
        if (issues.length) {
          setValidationAttempt((attempt) => attempt + 1);
          form.setFields(
            issues.map((issue) => ({
              name: ['providerConfig', issue.field],
              errors: [tr(issue.messageKey)],
            })),
          );
          message.error(tr('notifications.form.checkFields'));
          return;
        }
      }
      const body = createChannelPayload(v, editing?.id ? editing : undefined);
      setSaving(true);
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
        closeEditor();
        await load();
      } else message.error(translateError(r.error_code));
    } catch (error: any) {
      if (error?.errorFields) return;
      if (!error?.isAxiosError)
        message.error(tr('notifications.form.checkFields'));
    } finally {
      saveInProgress.current = false;
      setSaving(false);
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
                    {
                      title: tr('ui.provider'),
                      dataIndex: 'type',
                      render: (value: string) =>
                        providerSchemas[value]
                          ? tr(providerSchemas[value].labelKey)
                          : value,
                    },
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
        title={
          editing?.id
            ? tr('notifications.form.edit')
            : tr('notifications.form.add')
        }
        onCancel={closeEditor}
        onOk={save}
        confirmLoading={saving}
        closable={!saving}
        maskClosable={!saving}
        keyboard={!saving}
        cancelButtonProps={{ disabled: saving }}
        width="min(760px, calc(100vw - 24px))"
        bodyStyle={{ maxHeight: '68vh', overflowY: 'auto' }}
        okText={tr('notifications.form.save')}
        cancelText={tr('notifications.form.cancel')}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          disabled={saving}
          onValuesChange={(changed) => {
            const values = changed.providerConfig;
            if (!values) return;
            if (values.emailMode === 'smtp') {
              const defaults = getProviderDefaults('email');
              form.setFieldValue(
                ['providerConfig', 'emailPort'],
                defaults.emailPort,
              );
              form.setFieldValue(
                ['providerConfig', 'emailSecure'],
                defaults.emailSecure,
              );
            }
            if (values.emailMode) {
              for (const field of values.emailMode === 'smtp'
                ? ['emailService']
                : ['emailHost', 'emailPort', 'emailSecure'])
                form.setFieldValue(['providerConfig', field], undefined);
            }
            if (values.ntfyAuthMode) {
              const keep =
                values.ntfyAuthMode === 'token'
                  ? ['ntfyToken']
                  : values.ntfyAuthMode === 'basic'
                  ? ['ntfyUsername', 'ntfyPassword']
                  : [];
              for (const field of ['ntfyToken', 'ntfyUsername', 'ntfyPassword'])
                if (!keep.includes(field))
                  form.setFieldValue(['providerConfig', field], undefined);
            }
          }}
        >
          <Divider orientation="left">{tr('notifications.form.basic')}</Divider>
          <Form.Item
            name="name"
            label={tr('ui.name')}
            rules={[
              {
                required: true,
                whitespace: true,
                max: 200,
                message: tr('notifications.form.fieldRequired'),
              },
            ]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="type"
            label={tr('ui.provider')}
            rules={[{ required: true }]}
          >
            <Select
              data-testid="provider-select"
              showSearch
              optionFilterProp="label"
              onChange={changeProvider}
              options={providers
                .filter((value) => providerSchemas[value])
                .map((value) => ({
                  value,
                  label: tr(providerSchemas[value].labelKey),
                }))}
            />
          </Form.Item>
          <Space size="large" wrap>
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
          </Space>
          <Divider orientation="left">
            {tr('notifications.form.connection')}
          </Divider>
          {editing?.id && (
            <Alert
              type={editing.secret_configured ? 'success' : 'warning'}
              showIcon
              message={
                editing.secret_configured
                  ? tr('notifications.form.configured')
                  : tr('notifications.form.missing')
              }
              style={{ marginBottom: 16 }}
            />
          )}
          <Form.Item
            name="secret_action"
            label={tr('notifications.form.action')}
            hidden={!editing?.id}
          >
            <Select
              data-testid="action-select"
              onChange={changeAction}
              options={[
                ...(editing?.type === provider
                  ? [{ value: 'KEEP', label: tr('notifications.form.keep') }]
                  : []),
                { value: 'REPLACE', label: tr('notifications.form.replace') },
                ...(editing?.type === provider
                  ? [
                      {
                        value: 'DELETE',
                        label: tr('notifications.form.delete'),
                      },
                    ]
                  : []),
              ]}
            />
          </Form.Item>
          {action === 'KEEP' && (
            <Alert type="info" message={tr('notifications.form.keepHint')} />
          )}
          {action === 'REPLACE' && (
            <>
              {editing?.id && (
                <Alert
                  type="info"
                  message={tr('notifications.form.replaceHint')}
                  style={{ marginBottom: 16 }}
                />
              )}
              <ProviderConfigForm
                validationAttempt={validationAttempt}
                key={provider}
                provider={provider}
                form={form}
              />
            </>
          )}
          {action === 'DELETE' && (
            <>
              <Alert
                type="error"
                showIcon
                message={tr('notifications.form.deleteHint')}
              />
              <Form.Item
                name="confirmClear"
                valuePropName="checked"
                rules={[
                  {
                    validator: (_, value) =>
                      value === true
                        ? Promise.resolve()
                        : Promise.reject(
                            new Error(tr('notifications.form.confirmDelete')),
                          ),
                  },
                ]}
              >
                <Checkbox data-testid="confirm-clear">
                  {tr('notifications.form.confirmDelete')}
                </Checkbox>
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </Card>
  );
}
