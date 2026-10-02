import { translateEnum, translateError } from '@/utils/i18n';
import { formatDateTime, formatDuration, formatBytes } from '@/utils/format';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
const api = `${config.apiPrefix}scoped-env/`;

export function ScopedVariables({
  resource,
  id,
}: {
  resource: 'global' | 'profiles' | 'tasks';
  id: number;
}) {
  useI18nLocale();
  const endpoint = `${api}${
    resource === 'global' ? 'global' : `${resource}/${id}`
  }/variables`;
  const [rows, setRows] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>();
  const [form] = Form.useForm();
  const secret = Form.useWatch('is_secret', form),
    operation = Form.useWatch('operation', form),
    replace = Form.useWatch('replace_secret', form);
  const load = async () => {
    const r = await request.get(endpoint);
    if (r.code === 200) setRows(r.data);
  };
  useEffect(() => {
    load().catch(() => {});
  }, [resource, id]);
  const open = (row: any = {}) => {
    setEditing(row);
    form.resetFields();
    form.setFieldsValue({
      name: row.name,
      value: row.is_secret ? undefined : row.value,
      is_secret: !!row.is_secret,
      operation: row.operation || 'SET',
      status: row.status || 'enabled',
      replace_secret: false,
    });
  };
  const save = async () => {
    try {
      const values = await form.validateFields();
      if (
        values.operation === 'UNSET' ||
        (editing?.is_secret && !values.replace_secret)
      )
        delete values.value;
      const r = await request.put(endpoint, [values]);
      if (r.code === 200) {
        setEditing(undefined);
        form.resetFields();
        await load();
        message.success(tr('ui.environmentVariablesSaved'));
      }
    } catch {}
  };
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Button onClick={() => open()}>{tr('ui.addVariable')}</Button>
      <Table
        rowKey="name"
        size="small"
        dataSource={rows}
        pagination={false}
        columns={[
          { title: tr('ui.variableName'), dataIndex: 'name' },
          {
            title: tr('ui.value'),
            render: (_: any, r: any) =>
              r.operation === 'UNSET' ? (
                <Tag>{translateEnum('envOperation', r.operation)}</Tag>
              ) : r.is_secret ? (
                '••••••••'
              ) : (
                <span style={{ whiteSpace: 'pre-wrap' }}>{r.value}</span>
              ),
          },
          {
            title: tr('ui.status'),
            dataIndex: 'status',
            render: (value: unknown) => translateEnum('credentialState', value),
          },
          {
            title: tr('ui.secret'),
            render: (_: any, r: any) =>
              r.is_secret ? tr('ui.secret') : tr('ui.presentation.Plain'),
          },
          {
            title: tr('ui.action'),
            render: (_: any, r: any) => (
              <Space>
                <Button type="link" onClick={() => open(r)}>
                  {tr('ui.editVariable')}
                </Button>
                <Popconfirm
                  title={tr('ui.deleteThisVariable')}
                  onConfirm={async () => {
                    await request.put(endpoint, [
                      { name: r.name, clear: true },
                    ]);
                    await load();
                  }}
                >
                  <Button type="link" danger>
                    {tr('ui.deleteVariable')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={tr('ui.editEnvironmentVariables')}
        open={editing !== undefined}
        onCancel={() => {
          setEditing(undefined);
          form.resetFields();
        }}
        onOk={save}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label={tr('ui.variableName')}
            rules={[{ required: true, pattern: /^[A-Za-z_][A-Za-z0-9_]*$/ }]}
          >
            <Input disabled={!!editing?.name} />
          </Form.Item>
          <Form.Item name="operation" label={tr('ui.action')}>
            <Select
              options={[
                { value: 'SET', label: tr('ui.setValue') },
                { value: 'UNSET', label: tr('ui.removeFromEnvironment') },
              ]}
            />
          </Form.Item>
          <Form.Item name="status" label={tr('ui.status')}>
            <Select
              options={[
                { value: 'enabled', label: tr('ui.enabled') },
                {
                  value: 'disabled',
                  label: tr('ui.disabledExcludedFromOverrides'),
                },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="is_secret"
            label={tr('ui.secret')}
            valuePropName="checked"
          >
            <Switch disabled={!!editing?.is_secret} />
          </Form.Item>
          {editing?.is_secret && operation === 'SET' && (
            <Form.Item name="replace_secret" label={tr('ui.secretUpdate')}>
              <Select
                options={[
                  { value: false, label: tr('ui.keepExistingValue') },
                  { value: true, label: tr('ui.replaceValue') },
                ]}
              />
            </Form.Item>
          )}
          {operation === 'SET' && (!editing?.is_secret || replace) && (
            <Form.Item
              name="value"
              label={
                secret
                  ? tr('ui.extra.newSecretValue')
                  : tr('ui.extra.valueEmptyStringAllowed')
              }
              initialValue=""
            >
              <Input.TextArea rows={4} autoComplete="off" />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Space>
  );
}

export function TaskEnvironment({
  id,
  subscription = false,
}: {
  id: number;
  subscription?: boolean;
}) {
  useI18nLocale();
  const [context, setContext] = useState<any>();
  const [preview, setPreview] = useState<any>();
  const resource = subscription ? 'subscriptions' : 'tasks';
  const load = async () => {
    const r = await request.get(`${api}${resource}/${id}/context`);
    if (r.code === 200) setContext(r.data);
  };
  useEffect(() => {
    load().catch(() => {});
    setPreview(undefined);
  }, [id, subscription]);
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <strong>{tr('ui.environment')}</strong>
      {context && (
        <>
          <span>{tr('ui.repositoryProfile')}</span>
          <Select
            aria-label={tr('ui.repositoryProfile')}
            style={{ width: '100%' }}
            disabled={!context.repository_id}
            value={context.env_profile_id ?? null}
            options={[
              {
                value: null,
                label: context.repository_id
                  ? tr('ui.inheritSubscriptionRepositoryDefault')
                  : tr('ui.extra.unavailableNoRepositoryContext'),
              },
              ...context.profiles.map((p: any) => ({
                value: p.id,
                label: `${p.name}${
                  p.is_default ? tr('common.defaultSuffix') : ''
                }${p.status === 'disabled' ? tr('common.disabledSuffix') : ''}`,
              })),
            ]}
            onChange={async (value) => {
              const r = await request.put(`${api}${resource}/${id}/profile`, {
                env_profile_id: value,
              });
              if (r.code === 200) {
                await load();
                setPreview(undefined);
                message.success(tr('ui.profileBindingSaved'));
              }
            }}
          />
        </>
      )}
      {!subscription && (
        <>
          <ScopedVariables resource="tasks" id={id} />
          <Button
            onClick={async () => {
              const r = await request.get(`${api}tasks/${id}/preview`);
              if (r.code === 200) setPreview(r.data);
            }}
          >
            {tr('ui.previewEffectiveEnvironment')}
          </Button>
        </>
      )}
      {preview && (
        <>
          <Alert
            type="info"
            message={tr('ui.template.profileValueSelectionSourceValue', {
              p0: preview.profile?.name || tr('common.none'),
              p1: translateEnum(
                'selectionSource',
                preview.metadata.selected_by,
              ),
            })}
          />
          <Table
            rowKey="name"
            size="small"
            dataSource={preview.variables}
            columns={[
              { title: tr('ui.variables'), dataIndex: 'name' },
              {
                title: tr('ui.source'),
                dataIndex: 'origin',
                render: (value: unknown) => translateEnum('taskOrigin', value),
              },
              {
                title: tr('ui.action'),
                dataIndex: 'operation',
                render: (v: unknown) => translateEnum('envOperation', v),
              },
              { title: tr('ui.effectiveValue'), dataIndex: 'display' },
            ]}
          />
        </>
      )}
    </Space>
  );
}
