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
  message,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

export default function RepositoryPage() {
  useI18nLocale();
  const [repositories, setRepositories] = useState<any[]>([]);
  const [credentials, setCredentials] = useState<any[]>([]);
  const [editor, setEditor] = useState<{
    kind: 'repositories' | 'git-credentials';
    row: any;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<any>();
  const [testTarget, setTestTarget] = useState<any>();
  const [testUrl, setTestUrl] = useState('');
  const [form] = Form.useForm();
  const auth = Form.useWatch('auth_type', form);
  const replace = Form.useWatch('replace_secret', form);
  const load = async () => {
    const [r, c] = await Promise.all([
      request.get(`${config.apiPrefix}repositories`),
      request.get(`${config.apiPrefix}git-credentials`),
    ]);
    if (r.code === 200) setRepositories(r.data);
    if (c.code === 200) setCredentials(c.data);
  };
  useEffect(() => {
    load().catch(() => {});
  }, []);
  const open = (kind: 'repositories' | 'git-credentials', row: any = {}) => {
    setEditor({ kind, row });
    setParsed(undefined);
    form.resetFields();
    // API metadata only. Secret fields are never populated from existing records.
    form.setFieldsValue(
      kind === 'repositories'
        ? {
            name: row.name,
            remote_url: row.remote_url,
            default_credential_id: row.default_credential_id ?? null,
          }
        : {
            name: row.name,
            provider: row.provider || 'generic',
            auth_type: row.auth_type || 'anonymous',
            username: row.username,
            known_hosts: row.known_hosts,
            capability: row.capability || 'READ',
            status: row.status || 'enabled',
            replace_secret: !row.id,
          },
    );
  };
  const save = async () => {
    try {
      const values = await form.validateFields();
      if (!editor) return;
      setBusy(true);
      if (editor.kind === 'git-credentials') {
        if (values.auth_type === 'anonymous' || !values.replace_secret) {
          delete values.token;
          delete values.private_key;
          delete values.passphrase;
        } else if (values.auth_type === 'https_token') {
          delete values.private_key;
          delete values.passphrase;
        } else delete values.token;
      }
      const result = await request[editor.row.id ? 'put' : 'post'](
        `${config.apiPrefix}${editor.kind}`,
        { ...values, ...(editor.row.id ? { id: editor.row.id } : {}) },
      );
      if (result.code === 200) {
        setEditor(null);
        form.resetFields();
        await load();
        message.success(tr('ui.saved'));
      }
    } catch {
    } finally {
      setBusy(false);
    }
  };
  const remove = async (kind: string, id: number) => {
    try {
      await request.delete(`${config.apiPrefix}${kind}/${id}`);
      await load();
    } catch {}
  };
  const test = async (kind: string, id: number, remote_url?: string) => {
    setBusy(true);
    try {
      const r = await request.post(
        `${config.apiPrefix}${kind}/${id}/test`,
        remote_url ? { remote_url } : {},
      );
      if (r.code === 200) {
        (r.data.status === 'available' ? message.success : message.warning)(
          r.data.message,
        );
        setTestTarget(null);
        await load();
      }
    } catch {
    } finally {
      setBusy(false);
    }
  };
  const credentialOptions = [
    { value: null, label: tr('ui.anonymous') },
    ...credentials.map((c) => ({
      value: c.id,
      label: `${c.name} (${c.auth_type}, ${translateEnum(
        'credentialState',
        c.status,
      )})`,
    })),
  ];
  const actions = (kind: 'repositories' | 'git-credentials', row: any) => (
    <Space wrap>
      {kind === 'repositories' && (
        <Button
          size="small"
          href={`${config.baseUrl}repository-workspace?id=${row.id}`}
        >
          {tr('ui.workspace')}
        </Button>
      )}
      <Button size="small" onClick={() => open(kind, row)}>
        {tr('ui.edit')}
      </Button>
      <Button
        size="small"
        loading={busy}
        onClick={() =>
          kind === 'repositories'
            ? test(kind, row.id)
            : (setTestTarget(row), setTestUrl(''))
        }
      >
        {tr('ui.testAccess')}
      </Button>
      <Popconfirm
        title={tr('ui.deleteThisResourceReferencedResourcesCannotBeDeleted')}
        onConfirm={() => remove(kind, row.id)}
      >
        <Button
          size="small"
          danger
          disabled={
            kind === 'repositories'
              ? row.subscriptions_count > 0
              : row.used_by?.total > 0
          }
        >
          {tr('ui.delete')}
        </Button>
      </Popconfirm>
    </Space>
  );
  return (
    <div style={{ padding: 24 }}>
      <h2>{tr('ui.repositoriesVariant425')}</h2>
      <Button href={`${config.baseUrl}scoped-env`}>
        {tr('ui.environmentProfiles')}
      </Button>
      <Tabs
        items={[
          {
            key: 'repositories',
            label: tr('ui.repositories'),
            children: (
              <>
                <Button type="primary" onClick={() => open('repositories')}>
                  {tr('ui.createRepository')}
                </Button>
                <Table
                  rowKey="id"
                  dataSource={repositories}
                  scroll={{ x: 1000 }}
                  columns={[
                    { title: tr('ui.name'), dataIndex: 'name' },
                    { title: tr('ui.provider'), dataIndex: 'provider' },
                    { title: tr('ui.remote'), dataIndex: 'remote_url' },
                    {
                      title: tr('ui.defaultCredential'),
                      render: (_, r) =>
                        credentials.find(
                          (c) => c.id === r.default_credential_id,
                        )?.name || tr('ui.extra.anonymous'),
                    },
                    {
                      title: tr('ui.subscriptions'),
                      dataIndex: 'subscriptions_count',
                    },
                    {
                      title: tr('ui.status'),
                      dataIndex: 'status',
                      render: (value: unknown) =>
                        translateEnum('repositoryAvailability', value),
                    },
                    {
                      title: tr('ui.action'),
                      render: (_, r) => actions('repositories', r),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'credentials',
            label: tr('ui.credentials'),
            children: (
              <>
                <Button type="primary" onClick={() => open('git-credentials')}>
                  {tr('ui.createCredential')}
                </Button>
                <Table
                  rowKey="id"
                  dataSource={credentials}
                  scroll={{ x: 1200 }}
                  columns={[
                    { title: tr('ui.name'), dataIndex: 'name' },
                    { title: tr('ui.provider'), dataIndex: 'provider' },
                    {
                      title: tr('ui.authenticationType'),
                      dataIndex: 'auth_type',
                    },
                    { title: tr('ui.username'), dataIndex: 'username' },
                    {
                      title: tr('ui.capability'),
                      dataIndex: 'capability',
                      render: (v) => (
                        <Tag>{translateEnum('credentialCapability', v)}</Tag>
                      ),
                    },
                    {
                      title: tr('ui.secret'),
                      render: (_, r) => (r.has_secret ? '••••••••' : '—'),
                    },
                    {
                      title: tr('ui.references'),
                      render: (_, r) =>
                        tr('ui.presentation.repositoryCount', {
                          count: r.used_by.repositories,
                        }),
                    },
                    {
                      title: tr('ui.status'),
                      dataIndex: 'status',
                      render: (value: unknown) =>
                        translateEnum('repositoryAvailability', value),
                    },
                    {
                      title: tr('ui.lastTest'),
                      render: (_, r) =>
                        r.last_test_at
                          ? `${
                              r.last_test_result
                                ? translateEnum(
                                    'repositoryAvailability',
                                    r.last_test_result,
                                  )
                                : '—'
                            } · ${formatDateTime(r.last_test_at)}`
                          : tr('ui.extra.notTested'),
                    },
                    {
                      title: tr('ui.action'),
                      render: (_, r) => actions('git-credentials', r),
                    },
                  ]}
                />
              </>
            ),
          },
        ]}
      />
      <Modal
        open={!!editor}
        title={
          editor?.kind === 'repositories'
            ? tr('ui.extra.repositoryDetails')
            : tr('ui.extra.gitCredentials')
        }
        onCancel={() => {
          setEditor(null);
          form.resetFields();
        }}
        onOk={save}
        confirmLoading={busy}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label={tr('ui.name')}
            rules={[{ required: true }]}
          >
            <Input maxLength={255} />
          </Form.Item>
          {editor?.kind === 'repositories' ? (
            <>
              <Form.Item
                name="remote_url"
                label={tr('ui.remoteURL')}
                rules={[{ required: true }]}
                extra={tr(
                  'ui.supportsHTTPSSSHAndGenericGitURLsMustNotIncludeTokensOrPasswordsTheRemoteIdentityIsFixedAfterSaving',
                )}
              >
                <Input
                  disabled={!!editor.row.id}
                  onBlur={async (e) => {
                    try {
                      const r = await request.post(
                        `${config.apiPrefix}repositories/normalize`,
                        { remote_url: e.target.value },
                      );
                      if (r.code === 200) setParsed(r.data);
                    } catch {
                      setParsed(undefined);
                    }
                  }}
                />
              </Form.Item>
              {parsed && (
                <Alert
                  type="info"
                  message={`${parsed.provider} · ${parsed.host}`}
                  description={tr(
                    'ui.template.ownerValueRepositoryValuePathValue',
                    {
                      p0: parsed.owner || '—',
                      p1: parsed.repository_name,
                      p2: parsed.path,
                    },
                  )}
                  style={{ marginBottom: 16 }}
                />
              )}
              <Form.Item
                name="default_credential_id"
                label={tr('ui.defaultCredential')}
              >
                <Select options={credentialOptions} />
              </Form.Item>
              {editor.row.id && (
                <Button
                  loading={busy}
                  onClick={() => test('repositories', editor.row.id)}
                >
                  {tr('ui.testSavedRepository')}
                </Button>
              )}
              {!editor.row.id && <p>{tr('ui.saveBeforeTestingAccess')}</p>}
            </>
          ) : (
            <>
              <Form.Item
                name="provider"
                label={tr('ui.provider')}
                rules={[{ required: true }]}
              >
                <Select
                  options={['github', 'gitlab', 'gitee', 'generic'].map(
                    (value) => ({ value, label: value }),
                  )}
                />
              </Form.Item>
              <Form.Item name="auth_type" label={tr('ui.authenticationMethod')}>
                <Select
                  disabled={!!editor?.row.id}
                  options={['anonymous', 'https_token', 'ssh_key'].map(
                    (value) => ({ value, label: value }),
                  )}
                />
              </Form.Item>
              <Form.Item name="username" label={tr('ui.username')}>
                <Input autoComplete="off" />
              </Form.Item>
              <Form.Item name="capability" label={tr('ui.capability')}>
                <Select
                  options={[
                    {
                      value: 'READ',
                      label: translateEnum('credentialCapability', 'READ'),
                    },
                    {
                      value: 'WRITE',
                      label: translateEnum('credentialCapability', 'WRITE'),
                    },
                  ]}
                />
              </Form.Item>
              <Form.Item name="status" label={tr('ui.status')}>
                <Select
                  options={[
                    { value: 'enabled', label: tr('ui.enable') },
                    { value: 'disabled', label: tr('ui.disable') },
                  ]}
                />
              </Form.Item>
              {auth !== 'anonymous' && (
                <Form.Item
                  name="replace_secret"
                  label={tr('ui.secret')}
                  initialValue={!editor?.row.id}
                >
                  <Radio.Group>
                    <Radio value={false} disabled={!editor?.row.id}>
                      {tr('ui.keepExistingSecret')}
                    </Radio>
                    <Radio value={true}>{tr('ui.replaceSecret')}</Radio>
                  </Radio.Group>
                </Form.Item>
              )}
              {replace && auth === 'https_token' && (
                <Form.Item
                  name="token"
                  label={tr('ui.token')}
                  rules={[{ required: true }]}
                >
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
              )}
              {replace && auth === 'ssh_key' && (
                <>
                  <Form.Item
                    name="private_key"
                    label={tr('ui.sshPrivateKey')}
                    rules={[{ required: true }]}
                  >
                    <Input.TextArea rows={5} autoComplete="off" />
                  </Form.Item>
                  <Form.Item
                    name="passphrase"
                    label={tr('ui.passphraseOptional')}
                  >
                    <Input.Password autoComplete="new-password" />
                  </Form.Item>
                </>
              )}
              {(auth === 'ssh_key' || auth === 'anonymous') && (
                <Form.Item
                  name="known_hosts"
                  label={tr('ui.verifiedKnownHosts')}
                  rules={[{ required: auth === 'ssh_key' }]}
                  extra={tr(
                    'ui.verifyTheHostPublicKeyThroughATrustedChannelSSHConnectionsEnforceHostIdentityVerification',
                  )}
                >
                  <Input.TextArea rows={3} />
                </Form.Item>
              )}
              {editor?.row.public_key && (
                <Form.Item label={tr('ui.publicKey')}>
                  <Input.TextArea readOnly value={editor.row.public_key} />
                </Form.Item>
              )}
            </>
          )}
        </Form>
      </Modal>
      <Modal
        open={!!testTarget}
        title={tr('ui.template.testCredentialValue', {
          p0: testTarget?.name || '',
        })}
        confirmLoading={busy}
        onCancel={() => setTestTarget(null)}
        onOk={() => test('git-credentials', testTarget.id, testUrl)}
      >
        <p>
          {tr(
            'ui.enterARepositoryURLToTestWithThisCredentialTheTestOnlyReadsRemoteReferences',
          )}
        </p>
        <Input
          value={testUrl}
          onChange={(e) => setTestUrl(e.target.value)}
          placeholder="https://host/team/repo.git"
        />
      </Modal>
    </div>
  );
}
