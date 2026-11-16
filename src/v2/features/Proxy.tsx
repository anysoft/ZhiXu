import React, { useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import { call, list, useAction, useResource } from '../api';
import {
  Details,
  ErrorPanel,
  FormDialog,
  Reload,
  State,
  enumOptions,
  required,
} from '../components';
import { useText } from '../i18n';

export interface ProxySelection {
  mode: 'INHERIT' | 'DIRECT' | 'PROFILE';
  profile_id?: string | null;
}
export const inheritedProxy: ProxySelection = { mode: 'INHERIT' };

/** Controlled composite value: one form field registers both mode and profile. */
export function ProxySelect({
  value = inheritedProxy,
  onChange,
  platform = false,
  disabled = false,
}: {
  value?: ProxySelection;
  onChange?: (value: ProxySelection) => void;
  platform?: boolean;
  disabled?: boolean;
}) {
  const t = useText(),
    profiles = useResource('/proxy-profiles');
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <ErrorPanel
        error={profiles.error}
        reload={() => void profiles.reload()}
      />
      <Select
        aria-label={t('proxyMode')}
        value={value?.mode || (platform ? 'DIRECT' : 'INHERIT')}
        disabled={disabled}
        style={{ width: '100%' }}
        onChange={(mode) => onChange?.({ mode })}
        options={[
          ...(!platform
            ? [{ value: 'INHERIT', label: t('proxyInherit') }]
            : []),
          { value: 'DIRECT', label: t('proxyDirect') },
          { value: 'PROFILE', label: t('proxyProfile') },
        ]}
      />
      {value?.mode === 'PROFILE' && (
        <Select
          aria-label={t('proxyProfile')}
          loading={profiles.loading}
          disabled={disabled}
          style={{ width: '100%' }}
          value={value.profile_id || undefined}
          placeholder={t('proxyChoose')}
          onChange={(profile_id) => onChange?.({ mode: 'PROFILE', profile_id })}
          options={list(profiles.data).map((p: any) => ({
            value: p.id,
            label: `${p.name} · ${p.protocol} · ${p.host}:${p.port}${
              p.status === 'disabled' ? ` · ${t('status.disabled')}` : ''
            }`,
            disabled: p.status !== 'enabled',
          }))}
        />
      )}
      {value?.mode === 'PROFILE' &&
        list(profiles.data).some(
          (p: any) => p.id === value.profile_id && p.protocol === 'SOCKS5',
        ) && (
          <Typography.Text type="secondary">
            {t('proxySocksHelp')}
          </Typography.Text>
        )}
    </Space>
  );
}

export function ProxyScopeEditor({
  scope,
  id,
  editable = true,
}: {
  scope: 'platform' | 'workspace' | 'repository' | 'task';
  id: number;
  editable?: boolean;
}) {
  const t = useText(),
    path = `/proxy-selections/${scope}/${id}`,
    data = useResource(path),
    profiles = useResource('/proxy-profiles'),
    [editing, setEditing] = useState(false);
  const selection = data.data?.selection || {
      mode: scope === 'platform' ? 'DIRECT' : 'INHERIT',
    },
    effectiveId = data.data?.effective?.profile_id,
    effective = list(profiles.data).find((p: any) => p.id === effectiveId);
  return (
    <>
      <ErrorPanel error={data.error} reload={() => void data.reload()} />
      <Typography.Paragraph>
        {t(scope === 'platform' ? 'proxyPlatformHelp' : 'proxyScopeHelp')}
      </Typography.Paragraph>
      {data.data?.effective?.error_code && (
        <Alert
          type="warning"
          showIcon
          message={t('proxyUnavailable')}
          description={data.data.effective.error_code}
        />
      )}
      <Details
        values={[
          [
            'networkProxy',
            selection.mode === 'PROFILE'
              ? list(profiles.data).find(
                  (p: any) => p.id === selection.profile_id,
                )?.name || selection.profile_id
              : t(selection.mode === 'DIRECT' ? 'proxyDirect' : 'proxyInherit'),
          ],
          [
            'proxyEffective',
            effectiveId ? effective?.name || effectiveId : t('proxyDirect'),
          ],
        ]}
      />
      <Button
        disabled={!editable || data.loading || !data.data}
        onClick={() => setEditing(true)}
      >
        {t('edit')}
      </Button>
      {editing && (
        <FormDialog
          title={t('networkProxy')}
          initial={{ proxy: selection }}
          onClose={() => setEditing(false)}
          onSubmit={async (v) => {
            await call(path, { method: 'PUT', body: v.proxy });
            await Promise.all([data.reload(), profiles.reload()]);
          }}
        >
          <Form.Item
            name="proxy"
            label={t('networkProxy')}
            rules={[
              {
                validator: (_, v) =>
                  v?.mode !== 'PROFILE' || v.profile_id
                    ? Promise.resolve()
                    : Promise.reject(new Error(t('required'))),
              },
            ]}
          >
            <ProxySelect platform={scope === 'platform'} />
          </Form.Item>
        </FormDialog>
      )}
    </>
  );
}

export function ProxyManagement() {
  const t = useText(),
    data = useResource('/proxy-profiles'),
    action = useAction(),
    [editing, setEditing] = useState<any>(),
    [references, setReferences] = useState<any>(),
    [testResult, setTestResult] = useState<any>();
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="large">
      <ProxyScopeEditor scope="platform" id={0} />
      <Typography.Title level={4}>{t('proxyProfiles')}</Typography.Title>
      <Space>
        <Button
          type="primary"
          onClick={() =>
            setEditing({
              name: '',
              protocol: 'HTTP',
              host: '',
              port: 8080,
              username: '',
              status: 'enabled',
              replace_password: true,
            })
          }
        >
          {t('proxyNew')}
        </Button>
        <Reload onClick={() => void data.reload()} />
      </Space>
      <ErrorPanel error={data.error || action.error} />
      {testResult && (
        <Alert
          showIcon
          type={testResult.status === 'SUCCESS' ? 'success' : 'warning'}
          message={`${t('test')}: ${testResult.name} · ${
            testResult.status === 'SUCCESS'
              ? t('proxyTestSuccess')
              : t('proxyTestFailed')
          }`}
          description={testResult.diagnostic}
        />
      )}
      <Table
        rowKey="id"
        dataSource={list(data.data)}
        columns={[
          { title: t('name'), dataIndex: 'name' },
          { title: t('type'), dataIndex: 'protocol' },
          { title: t('proxyHost'), dataIndex: 'host' },
          { title: t('proxyPort'), dataIndex: 'port' },
          { title: t('username'), dataIndex: 'username' },
          {
            title: t('status'),
            dataIndex: 'status',
            render: (v) => <State value={v} />,
          },
          {
            title: t('secret'),
            render: (_, row: any) =>
              t(row.has_password ? 'configured' : 'missing'),
          },
          {
            title: t('actions'),
            render: (_, row: any) => (
              <Space wrap>
                <Button
                  onClick={() =>
                    setEditing({ ...row, replace_password: false })
                  }
                >
                  {t('edit')}
                </Button>
                <Button
                  loading={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await call(`/proxy-profiles/${row.id}`, {
                        method: 'PUT',
                        body: {
                          status:
                            row.status === 'enabled' ? 'disabled' : 'enabled',
                        },
                      });
                      await data.reload();
                    })
                  }
                >
                  {t(row.status === 'enabled' ? 'proxyDisable' : 'proxyEnable')}
                </Button>
                <Button
                  loading={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      setTestResult({
                        ...(await call(`/proxy-profiles/${row.id}/test`, {
                          method: 'POST',
                          body: {},
                        })),
                        name: row.name,
                      });
                    })
                  }
                >
                  {t('test')}
                </Button>
                <Button onClick={() => setReferences(row)}>
                  {t('proxyReferences')} ({row.used_by?.length || 0})
                </Button>
                <Popconfirm
                  title={t(
                    row.used_by?.length
                      ? 'proxyDeleteReferenced'
                      : 'confirmDelete',
                  )}
                  okButtonProps={{ disabled: !!row.used_by?.length }}
                  onConfirm={() =>
                    action.run(async () => {
                      await call(`/proxy-profiles/${row.id}`, {
                        method: 'DELETE',
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
      <Typography.Paragraph type="secondary">
        {t('proxySshHelp')}
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary">
        {t('proxySocksHelp')}
      </Typography.Paragraph>
      {references && (
        <Drawer
          open
          title={`${t('proxyReferences')} · ${references.name}`}
          onClose={() => setReferences(undefined)}
        >
          <Table
            rowKey={(row: any) => `${row.scope}:${row.id}`}
            dataSource={references.used_by || []}
            pagination={false}
            columns={[
              { title: t('type'), dataIndex: 'scope' },
              { title: t('id'), dataIndex: 'id' },
            ]}
          />
        </Drawer>
      )}
      {editing && (
        <FormDialog
          title={t(editing.id ? 'edit' : 'proxyNew')}
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSubmit={async (v) => {
            const body: any = {
              name: v.name,
              protocol: v.protocol,
              host: v.host,
              port: v.port,
              username: v.username || '',
              status: v.status,
            };
            if (v.replace_password) {
              body.replace_password = true;
              body.password = v.password || '';
            }
            await call(
              editing.id ? `/proxy-profiles/${editing.id}` : '/proxy-profiles',
              { method: editing.id ? 'PUT' : 'POST', body },
            );
            await data.reload();
          }}
        >
          <Form.Item name="name" label={t('name')} rules={[required()]}>
            <Input maxLength={255} />
          </Form.Item>
          <Form.Item name="protocol" label={t('type')} rules={[required()]}>
            <Select options={enumOptions(['HTTP', 'HTTPS', 'SOCKS5'])} />
          </Form.Item>
          <Form.Item name="host" label={t('proxyHost')} rules={[required()]}>
            <Input autoComplete="off" maxLength={253} />
          </Form.Item>
          <Form.Item name="port" label={t('proxyPort')} rules={[required()]}>
            <InputNumber min={1} max={65535} precision={0} />
          </Form.Item>
          <Form.Item name="username" label={t('username')}>
            <Input autoComplete="off" maxLength={255} />
          </Form.Item>
          <Typography.Paragraph type="secondary">
            {t('proxyPasswordHelp')}
          </Typography.Paragraph>
          <Form.Item
            name="replace_password"
            valuePropName="checked"
            hidden={!editing.id}
          >
            <Checkbox>{t('replaceSecret')}</Checkbox>
          </Form.Item>
          <Form.Item noStyle shouldUpdate>
            {({ getFieldValue }) =>
              getFieldValue('replace_password') && (
                <Form.Item name="password" label={t('password')}>
                  <Input.Password
                    autoComplete="new-password"
                    maxLength={4096}
                  />
                </Form.Item>
              )
            }
          </Form.Item>
          <Form.Item name="status" label={t('status')}>
            <Select options={enumOptions(['enabled', 'disabled'])} />
          </Form.Item>
        </FormDialog>
      )}
    </Space>
  );
}
