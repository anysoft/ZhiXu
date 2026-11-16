import React, { useState } from 'react';
import { Link } from '@umijs/max';
import {
  Alert,
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
  Typography,
} from 'antd';
import { call, list, useAction, useResource } from '../api';
import {
  Details,
  ErrorPanel,
  Fingerprint,
  FormDialog,
  Page,
  Reload,
  State,
  Time,
  enumOptions,
  required,
} from '../components';
import { useText } from '../i18n';
function RepositoryDetail({
  row,
  onChanged,
}: {
  row: any;
  onChanged: () => void;
}) {
  const t = useText(),
    status = useResource(`/repositories/${row.id}/status`, 3000),
    refs = useResource(`/repositories/${row.id}/refs`),
    action = useAction();
  return (
    <>
      <ErrorPanel error={status.error || refs.error || action.error} />
      <Details
        values={[
          ['repositoryUrl', row.remote_url],
          [
            'storage',
            <State value={status.data?.storage_state || row.storage_state} />,
          ],
          ['lastFetch', <Time value={row.last_fetch_at} />],
          ['workspaces', row.used_by?.workspaces],
          ['diagnostics', row.last_error],
        ]}
      />
      <Space className="v2-section" wrap>
        {['initialize', 'fetch', 'repair'].map((kind) => (
          <Button
            key={kind}
            loading={action.busy}
            onClick={() =>
              void action.run(async () => {
                await call(`/repositories/${row.id}/${kind}`, {
                  method: 'POST',
                  body: {},
                });
                await status.reload();
                await refs.reload();
                onChanged();
              })
            }
          >
            {t(kind)}
          </Button>
        ))}
        <Link to={`/workspaces?repository_id=${row.id}`}>
          <Button>{t('newWorkspace')}</Button>
        </Link>
      </Space>
      <Table
        className="v2-section"
        rowKey={(r: any) => r.name || r.ref}
        dataSource={list(refs.data)}
        columns={[
          { title: t('refName'), render: (_, r: any) => r.name || r.ref },
          {
            title: t('type'),
            dataIndex: 'type',
            render: (v) => <State value={v} />,
          },
          {
            title: t('commit'),
            render: (_, r: any) => (
              <Fingerprint value={r.commit || r.sha || r.object_id} />
            ),
          },
        ]}
      />
    </>
  );
}
function Credentials() {
  const t = useText(),
    data = useResource('/git-credentials'),
    action = useAction(),
    [editing, setEditing] = useState<any>(),
    [test, setTest] = useState<any>(),
    [testResult, setTestResult] = useState<any>();
  return (
    <>
      <div className="v2-toolbar">
        <Button
          type="primary"
          onClick={() =>
            setEditing({
              name: '',
              provider: 'generic',
              auth_type: 'https_token',
              capability: 'READ',
              status: 'enabled',
              replace_secret: true,
            })
          }
        >
          {t('newCredential')}
        </Button>
        <Reload onClick={() => void data.reload()} />
      </div>
      <ErrorPanel error={data.error || action.error} />
      {testResult && (
        <Alert
          type="info"
          showIcon
          message={
            <State
              value={testResult.status || testResult.result || 'SUCCESS'}
            />
          }
        />
      )}
      <Table
        rowKey="id"
        dataSource={list(data.data)}
        columns={[
          { title: t('name'), dataIndex: 'name' },
          { title: t('provider'), dataIndex: 'provider' },
          { title: t('type'), dataIndex: 'auth_type' },
          {
            title: t('status'),
            dataIndex: 'status',
            render: (v) => <State value={v} />,
          },
          {
            title: t('secret'),
            dataIndex: 'has_secret',
            render: (v) => t(v ? 'configured' : 'missing'),
          },
          {
            title: t('fingerprint'),
            dataIndex: 'fingerprint',
            render: (v) => <Fingerprint value={v} />,
          },
          { title: t('usage'), render: (_, r: any) => r.used_by?.total },
          {
            title: t('actions'),
            render: (_, r: any) => (
              <Space>
                <Button
                  onClick={() => setEditing({ ...r, replace_secret: false })}
                >
                  {t('edit')}
                </Button>
                <Button onClick={() => setTest(r)}>{t('test')}</Button>
                <Popconfirm
                  title={t('confirmDelete')}
                  onConfirm={() =>
                    action.run(async () => {
                      await call(`/git-credentials/${r.id}`, {
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
      {test && (
        <FormDialog
          title={t('test')}
          submitText={t('test')}
          initial={{ remote_url: '' }}
          onClose={() => setTest(undefined)}
          onSubmit={async (v) =>
            setTestResult(
              await call(`/git-credentials/${test.id}/test`, {
                method: 'POST',
                body: v,
              }),
            )
          }
        >
          <Form.Item
            name="remote_url"
            label={t('repositoryUrl')}
            rules={[required()]}
          >
            <Input />
          </Form.Item>
        </FormDialog>
      )}
      {editing && (
        <FormDialog
          title={t(editing.id ? 'edit' : 'newCredential')}
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSubmit={async (v) => {
            const body: any = {
              name: v.name,
              provider: v.provider,
              auth_type: v.auth_type,
              username: v.username || '',
              capability: v.capability,
              status: v.status,
              ...(editing.id ? { id: editing.id } : {}),
              replace_secret: !!v.replace_secret,
            };
            if (v.replace_secret && v.auth_type === 'https_token')
              body.token = v.token || '';
            if (v.auth_type === 'ssh_key') {
              body.known_hosts = v.known_hosts || '';
              if (v.replace_secret) {
                body.private_key = v.private_key || '';
                body.passphrase = v.passphrase || '';
              }
            }
            await call('/git-credentials', {
              method: editing.id ? 'PUT' : 'POST',
              body,
            });
            await data.reload();
          }}
        >
          <Form.Item name="name" label={t('name')} rules={[required()]}>
            <Input />
          </Form.Item>
          <Form.Item name="provider" label={t('provider')}>
            <Select
              options={enumOptions(['github', 'gitlab', 'gitee', 'generic'])}
            />
          </Form.Item>
          <Form.Item name="auth_type" label={t('type')}>
            <Select
              options={enumOptions(['anonymous', 'https_token', 'ssh_key'])}
            />
          </Form.Item>
          <Form.Item name="username" label={t('username')}>
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item name="capability" label={t('capability')}>
            <Select options={enumOptions(['READ', 'WRITE'])} />
          </Form.Item>
          <Form.Item name="status" label={t('status')}>
            <Select options={enumOptions(['enabled', 'disabled'])} />
          </Form.Item>
          <Form.Item
            name="replace_secret"
            valuePropName="checked"
            hidden={!editing.id}
          >
            <Checkbox>{t('replaceSecret')}</Checkbox>
          </Form.Item>
          <Form.Item noStyle shouldUpdate>
            {({ getFieldValue }) => (
              <>
                {getFieldValue('replace_secret') &&
                  getFieldValue('auth_type') === 'https_token' && (
                    <Form.Item
                      name="token"
                      label={t('token')}
                      rules={[required()]}
                    >
                      <Input.Password autoComplete="new-password" />
                    </Form.Item>
                  )}
                {getFieldValue('auth_type') === 'ssh_key' && (
                  <>
                    <Form.Item
                      name="known_hosts"
                      label={t('knownHosts')}
                      rules={[required()]}
                    >
                      <Input.TextArea rows={3} />
                    </Form.Item>
                    {getFieldValue('replace_secret') && (
                      <>
                        <Form.Item
                          name="private_key"
                          label={t('privateKey')}
                          rules={[required()]}
                        >
                          <Input.TextArea rows={5} autoComplete="off" />
                        </Form.Item>
                        <Form.Item name="passphrase" label={t('keyPassphrase')}>
                          <Input.Password autoComplete="new-password" />
                        </Form.Item>
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </Form.Item>
        </FormDialog>
      )}
    </>
  );
}
export default function RepositoriesPage() {
  const t = useText(),
    data = useResource('/repositories', 4000),
    credentials = useResource('/git-credentials'),
    action = useAction(),
    [editing, setEditing] = useState<any>(),
    [selected, setSelected] = useState<any>();
  return (
    <Page title={t('repositories')} subtitle={t('repositoryHelp')}>
      <Tabs
        destroyInactiveTabPane
        items={[
          {
            key: 'repositories',
            label: t('repositories'),
            children: (
              <>
                <div className="v2-toolbar">
                  <Button
                    type="primary"
                    onClick={() =>
                      setEditing({
                        name: '',
                        remote_url: '',
                        default_credential_id: null,
                      })
                    }
                  >
                    {t('newRepository')}
                  </Button>
                  <Reload onClick={() => void data.reload()} />
                </div>
                <ErrorPanel error={data.error || action.error} />
                <Table
                  rowKey="id"
                  dataSource={list(data.data)}
                  columns={[
                    {
                      title: t('name'),
                      dataIndex: 'name',
                      render: (v, r: any) => (
                        <Button type="link" onClick={() => setSelected(r)}>
                          {v}
                        </Button>
                      ),
                    },
                    { title: t('repositoryUrl'), dataIndex: 'remote_url' },
                    {
                      title: t('status'),
                      dataIndex: 'storage_state',
                      render: (v) => <State value={v} />,
                    },
                    {
                      title: t('lastFetch'),
                      dataIndex: 'last_fetch_at',
                      render: (v) => <Time value={v} />,
                    },
                    {
                      title: t('workspaces'),
                      render: (_, r: any) => r.used_by?.workspaces,
                    },
                    {
                      title: t('actions'),
                      render: (_, r: any) => (
                        <Space>
                          <Button onClick={() => setSelected(r)}>
                            {t('open')}
                          </Button>
                          <Button onClick={() => setEditing(r)}>
                            {t('edit')}
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
            key: 'credentials',
            label: t('credentials'),
            children: <Credentials />,
          },
        ]}
      />
      {selected && (
        <Drawer
          open
          width={880}
          title={selected.name}
          onClose={() => setSelected(undefined)}
        >
          <RepositoryDetail
            row={selected}
            onChanged={() => void data.reload()}
          />
        </Drawer>
      )}
      {editing && (
        <FormDialog
          title={t(editing.id ? 'edit' : 'newRepository')}
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSubmit={async (v) => {
            await call('/repositories', {
              method: editing.id ? 'PUT' : 'POST',
              body: {
                name: v.name,
                remote_url: v.remote_url,
                default_credential_id: v.default_credential_id || null,
                ...(editing.id ? { id: editing.id } : {}),
              },
            });
            await data.reload();
          }}
        >
          <Form.Item name="name" label={t('name')} rules={[required()]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="remote_url"
            label={t('repositoryUrl')}
            rules={[required()]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="default_credential_id" label={t('credential')}>
            <Select
              allowClear
              placeholder={t('anonymous')}
              options={list(credentials.data).map((r: any) => ({
                value: r.id,
                label: r.name,
              }))}
            />
          </Form.Item>
        </FormDialog>
      )}
    </Page>
  );
}
