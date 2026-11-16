import React, { useState } from 'react';
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
import { ApiError, call, list, useAction, useResource } from '../api';
import {
  Details,
  ErrorPanel,
  FormDialog,
  Page,
  Reload,
  State,
  Time,
  enumOptions,
  lines,
  required,
} from '../components';
import { useText } from '../i18n';
import { RuntimeRevision } from '../features/RuntimeRevision';
function RuntimeOperation({ id }: { id: number }) {
  const t = useText(),
    data = useResource(`/runtime/python/operations/${id}`, 1500),
    log = useResource(`/runtime/python/operations/${id}/log`, 1500),
    action = useAction();
  return (
    <>
      <ErrorPanel error={data.error || log.error || action.error} />
      <Details
        values={[
          ['operationId', id],
          ['type', data.data?.operation_type],
          ['status', <State value={data.data?.status} />],
          ['phase', data.data?.stage],
          ['diagnostics', data.data?.error_code],
        ]}
      />
      {['QUEUED', 'RUNNING'].includes(data.data?.status) && (
        <Button
          className="v2-section"
          loading={action.busy}
          onClick={() =>
            void action.run(async () => {
              await call(`/runtime/python/operations/${id}/cancel`, {
                method: 'POST',
                body: {},
              });
              await data.reload();
            })
          }
        >
          {t('cancel')}
        </Button>
      )}
      <pre className="v2-log">
        {typeof log.data === 'string' ? log.data : log.data?.text || ''}
      </pre>
    </>
  );
}
function ManagedEnvironment({
  kind,
  row,
  onOperation,
  onChanged,
}: {
  kind: string;
  row: any;
  onOperation: (op: any) => void;
  onChanged: () => void;
}) {
  const t = useText(),
    base = `/runtime/${kind}/environments/${row.id}`,
    data = useResource(base, 3000),
    revisions = useResource(base + '/revisions'),
    builds = useResource(base + '/builds', 3000),
    action = useAction(),
    [editing, setEditing] = useState(false);
  const current = data.data || row;
  const operation = async (path: string) => {
    onOperation(
      await call(path, {
        method: 'POST',
        body: { expected_version: current.version },
      }),
    );
    await data.reload();
    await builds.reload();
    onChanged();
  };
  return (
    <>
      <ErrorPanel
        error={data.error || revisions.error || builds.error || action.error}
      />
      <Details
        values={[
          ['name', current.name],
          ['status', <State value={current.state} />],
          ['version', current.version],
          ['currentRevision', current.current_revision_id],
          ['currentBuild', current.current_build_id],
        ]}
      />
      <Space className="v2-section">
        <Button disabled={!revisions.data} onClick={() => setEditing(true)}>
          {t('createRevision')}
        </Button>
        {['build', 'rebuild'].map((kind) => (
          <Button
            key={kind}
            loading={action.busy}
            onClick={() => void action.run(() => operation(base + '/' + kind))}
          >
            {t(kind)}
          </Button>
        ))}
      </Space>
      <Tabs
        items={[
          {
            key: 'builds',
            label: t('builds'),
            children: (
              <Table
                rowKey="id"
                dataSource={list(builds.data)}
                columns={[
                  { title: t('id'), dataIndex: 'id' },
                  { title: t('assetRevision'), dataIndex: 'revision_id' },
                  {
                    title: t('status'),
                    dataIndex: 'state',
                    render: (v) => <State value={v} />,
                  },
                  {
                    title: t('health'),
                    dataIndex: 'health',
                    render: (v) => <State value={v} />,
                  },
                  {
                    title: t('actions'),
                    render: (_, r: any) => (
                      <Space>
                        <Button
                          onClick={() =>
                            void action.run(() =>
                              operation(base + `/builds/${r.id}/verify`),
                            )
                          }
                        >
                          {t('verify')}
                        </Button>
                        <Button
                          disabled={current.current_build_id === r.id}
                          onClick={() =>
                            void action.run(() =>
                              operation(base + `/builds/${r.id}/promote`),
                            )
                          }
                        >
                          {t('promote')}
                        </Button>
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'revisions',
            label: t('revisions'),
            children: (
              <Table
                rowKey="id"
                dataSource={list(revisions.data)}
                expandable={{
                  expandedRowRender: (r: any) => (
                    <pre className="v2-log">
                      {JSON.stringify(
                        r.dependencies || r.requirements || [],
                        null,
                        2,
                      )}
                    </pre>
                  ),
                }}
                columns={[
                  { title: t('id'), dataIndex: 'id' },
                  { title: t('version'), dataIndex: 'revision_number' },
                  { title: t('runtime'), dataIndex: 'runtime_id' },
                  {
                    title: t('createdAt'),
                    dataIndex: 'createdAt',
                    render: (v) => <Time value={v} />,
                  },
                ]}
              />
            ),
          },
        ]}
      />
      {editing && (
        <RuntimeRevision
          kind={kind}
          current={current}
          revision={list(revisions.data).find(
            (r: any) => r.id === current.current_revision_id,
          )}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            await data.reload();
            await revisions.reload();
            onChanged();
          }}
        />
      )}
    </>
  );
}
function LanguageRuntime({
  kind,
  onOperation,
}: {
  kind: 'python' | 'node';
  onOperation: (op: any) => void;
}) {
  const t = useText(),
    base = `/runtime/${kind}`,
    runtimes = useResource(base + '/installations', 4000),
    environments = useResource(base + '/environments', 4000),
    catalog = useResource(base + '/catalog', 4000),
    provider = useResource(kind === 'python' ? base + '/provider' : null, 4000),
    tools = useResource(kind === 'node' ? base + '/toolchains' : null),
    action = useAction(),
    [dialog, setDialog] = useState<string>(),
    [selected, setSelected] = useState<any>();
  const reload = async () => {
    await Promise.all([
      runtimes.reload(),
      environments.reload(),
      catalog.reload(),
      tools.reload(),
      provider.reload(),
    ]);
  };
  const launch = async (path: string, body: any = {}) => {
    onOperation(await call(path, { method: 'POST', body }));
    await reload();
  };
  const versions = list(catalog.data?.versions)
    .map((v: any) => (typeof v === 'string' ? v : v.version))
    .filter(Boolean);
  return (
    <>
      <ErrorPanel
        error={
          runtimes.error ||
          environments.error ||
          catalog.error ||
          provider.error ||
          tools.error ||
          action.error
        }
      />
      <Space wrap className="v2-section">
        {kind === 'python' && (
          <>
            <State value={provider.data?.state || provider.data?.status} />
            <Button
              loading={action.busy}
              disabled={
                provider.loading ||
                !provider.data ||
                ['READY', 'INSTALLING', 'UPDATING'].includes(
                  provider.data.state,
                )
              }
              onClick={() =>
                void action.run(() => launch(base + '/provider/setup'))
              }
            >
              {provider.data?.state === 'READY'
                ? t('providerInstalled', {
                    version: provider.data.provider_version || '',
                  })
                : t('providerSetup')}
            </Button>
            <Button
              loading={action.busy}
              onClick={() =>
                void action.run(() => launch(base + '/provider/verify'))
              }
            >
              {t('verify')}
            </Button>
          </>
        )}
        <Button
          loading={action.busy}
          onClick={() =>
            void action.run(() =>
              launch(
                base + (kind === 'python' ? '/provider/catalog' : '/catalog'),
              ),
            )
          }
        >
          {t('refreshCatalog')}
        </Button>
        <Reload onClick={() => void reload()} />
      </Space>
      <Tabs
        destroyInactiveTabPane
        items={[
          {
            key: 'installations',
            label: t('installations'),
            children: (
              <>
                <Button
                  className="v2-section"
                  type="primary"
                  onClick={() => setDialog('install')}
                >
                  {t('install')}
                </Button>
                <Table
                  rowKey="id"
                  dataSource={list(runtimes.data)}
                  columns={[
                    { title: t('id'), dataIndex: 'id' },
                    { title: t('runtimeVersion'), dataIndex: 'version' },
                    {
                      title: t('status'),
                      dataIndex: 'state',
                      render: (v) => <State value={v} />,
                    },
                    {
                      title: t('health'),
                      dataIndex: 'health',
                      render: (v) => <State value={v} />,
                    },
                    {
                      title: t('actions'),
                      render: (_, r: any) => (
                        <Space>
                          {['verify', 'repair'].map((op) => (
                            <Button
                              key={op}
                              loading={action.busy}
                              onClick={() =>
                                void action.run(() =>
                                  launch(base + `/installations/${r.id}/${op}`),
                                )
                              }
                            >
                              {t(op)}
                            </Button>
                          ))}
                        </Space>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'environments',
            label: t('environments'),
            children: (
              <>
                <Button
                  className="v2-section"
                  type="primary"
                  onClick={() => setDialog('environment')}
                >
                  {t('newEnvironment')}
                </Button>
                <Button
                  className="v2-section"
                  onClick={() => setDialog('install')}
                >
                  {t('installLanguage', {
                    language: kind === 'python' ? 'Python' : 'Node.js',
                  })}
                </Button>
                <Table
                  rowKey="id"
                  dataSource={list(environments.data)}
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
                    {
                      title: t('status'),
                      dataIndex: 'state',
                      render: (v) => <State value={v} />,
                    },
                    {
                      title: t('health'),
                      dataIndex: 'health',
                      render: (v) => <State value={v} />,
                    },
                    { title: t('runtime'), dataIndex: 'runtime_id' },
                    {
                      title: t('currentRevision'),
                      dataIndex: 'current_revision_id',
                    },
                    { title: t('currentBuild'), dataIndex: 'current_build_id' },
                    {
                      title: t('actions'),
                      render: (_, r: any) => (
                        <Space>
                          <Button onClick={() => setSelected(r)}>
                            {t('open')}
                          </Button>
                          <Button
                            loading={action.busy}
                            onClick={() =>
                              void action.run(() =>
                                launch(base + `/environments/${r.id}/build`, {
                                  expected_version: r.version,
                                }),
                              )
                            }
                          >
                            {t('build')}
                          </Button>
                        </Space>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          ...(kind === 'node'
            ? [
                {
                  key: 'toolchains',
                  label: t('toolchain'),
                  children: (
                    <>
                      <Button
                        className="v2-section"
                        onClick={() => setDialog('toolchain')}
                      >
                        {t('install')}
                      </Button>
                      <Table
                        rowKey="id"
                        dataSource={list(tools.data)}
                        columns={[
                          { title: t('id'), dataIndex: 'id' },
                          { title: t('type'), dataIndex: 'manager_type' },
                          { title: t('runtimeVersion'), dataIndex: 'version' },
                          { title: t('runtime'), dataIndex: 'runtime_id' },
                          {
                            title: t('status'),
                            dataIndex: 'state',
                            render: (v) => <State value={v} />,
                          },
                        ]}
                      />
                    </>
                  ),
                },
              ]
            : []),
        ]}
      />
      {selected && (
        <Drawer
          open
          title={selected.name}
          width={920}
          onClose={() => setSelected(undefined)}
        >
          <ManagedEnvironment
            key={selected.id}
            kind={kind}
            row={selected}
            onOperation={onOperation}
            onChanged={() => void reload()}
          />
        </Drawer>
      )}
      {dialog && (
        <FormDialog
          key={dialog}
          submitText={dialog !== 'environment' ? t('install') : undefined}
          title={
            dialog === 'install'
              ? t('installLanguage', {
                  language: kind === 'python' ? 'Python' : 'Node.js',
                })
              : t(dialog === 'environment' ? 'newEnvironment' : 'install')
          }
          initial={{
            name: '',
            description: '',
            requirements: '',
            dependencies: '',
            manager_type: 'PNPM',
            install_scripts_policy: 'IGNORE',
            production_only: false,
          }}
          onClose={() => setDialog(undefined)}
          onSubmit={async (v) => {
            if (dialog === 'install')
              await launch(base + '/installations', { version: v.version });
            else if (dialog === 'toolchain')
              await launch(base + '/toolchains', {
                runtime_id: v.runtime_id,
                manager_type: v.manager_type,
                ...(v.version ? { version: v.version } : {}),
              });
            else {
              const body: any = {
                name: v.name,
                description: v.description || '',
                runtime_id: v.runtime_id,
              };
              if (kind === 'python') body.requirements = lines(v.requirements);
              else {
                body.toolchain_id = v.toolchain_id;
                body.install_scripts_policy = v.install_scripts_policy;
                body.production_only = !!v.production_only;
                body.dependencies = lines(v.dependencies).map((value) => {
                  const split = value.lastIndexOf('@');
                  if (split <= 0)
                    throw new ApiError(400, 'NODE_DEPENDENCY_INVALID');
                  return {
                    name: value.slice(0, split),
                    specifier: value.slice(split + 1),
                    type: 'DEPENDENCY',
                  };
                });
              }
              await call(base + '/environments', { method: 'POST', body });
              await reload();
            }
          }}
        >
          {dialog === 'install' ? (
            <>
              {!catalog.loading && !versions.length && (
                <Alert
                  type="info"
                  showIcon
                  message={t('runtimeCatalogEmpty')}
                  action={
                    <Button
                      onClick={() =>
                        void action.run(() =>
                          launch(
                            base +
                              (kind === 'python'
                                ? '/provider/catalog'
                                : '/catalog'),
                          ),
                        )
                      }
                    >
                      {t('refreshCatalog')}
                    </Button>
                  }
                />
              )}
              <Form.Item
                name="version"
                label={t('runtimeVersion')}
                rules={[required()]}
              >
                <Select
                  showSearch
                  loading={catalog.loading}
                  options={versions.map((value: string) => ({
                    value,
                    label: value,
                  }))}
                />
              </Form.Item>
            </>
          ) : (
            <>
              {!runtimes.loading &&
                !list(runtimes.data).some((r: any) => r.state === 'READY') && (
                  <Alert
                    type="info"
                    showIcon
                    message={t('runtimeInstallationRequired')}
                    action={
                      <Button onClick={() => setDialog('install')}>
                        {t('installLanguage', {
                          language: kind === 'python' ? 'Python' : 'Node.js',
                        })}
                      </Button>
                    }
                  />
                )}
              <Form.Item
                name="runtime_id"
                label={t('runtime')}
                rules={[required()]}
              >
                <Select
                  options={list(runtimes.data)
                    .filter((r: any) => r.state === 'READY')
                    .map((r: any) => ({
                      value: r.id,
                      label: `${r.version} · #${r.id}`,
                    }))}
                />
              </Form.Item>
              {dialog === 'toolchain' ? (
                <>
                  <Form.Item name="manager_type" label={t('toolchain')}>
                    <Select options={enumOptions(['PNPM', 'NPM'])} />
                  </Form.Item>
                  <Form.Item name="version" label={t('runtimeVersion')}>
                    <Input />
                  </Form.Item>
                </>
              ) : (
                <>
                  <Form.Item name="name" label={t('name')} rules={[required()]}>
                    <Input />
                  </Form.Item>
                  <Form.Item name="description" label={t('description')}>
                    <Input />
                  </Form.Item>
                  {kind === 'python' ? (
                    <Form.Item name="requirements" label={t('requirements')}>
                      <Input.TextArea rows={7} />
                    </Form.Item>
                  ) : (
                    <>
                      <Form.Item
                        name="toolchain_id"
                        label={t('toolchain')}
                        rules={[required()]}
                      >
                        <Select
                          options={list(tools.data)
                            .filter((r: any) => r.state === 'READY')
                            .map((r: any) => ({
                              value: r.id,
                              label: `${r.manager_type} ${r.version} · #${r.id}`,
                            }))}
                        />
                      </Form.Item>
                      <Form.Item name="dependencies" label={t('dependencies')}>
                        <Input.TextArea rows={7} />
                      </Form.Item>
                      <Form.Item
                        name="install_scripts_policy"
                        label={t('installScripts')}
                      >
                        <Select options={enumOptions(['IGNORE', 'ALLOW'])} />
                      </Form.Item>
                      <Form.Item name="production_only" valuePropName="checked">
                        <Checkbox>{t('productionOnly')}</Checkbox>
                      </Form.Item>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </FormDialog>
      )}
    </>
  );
}
export default function RuntimePage() {
  const t = useText(),
    operations = useResource('/runtime/python/operations', 2500),
    [selected, setSelected] = useState<number>();
  const onOperation = (op: any) => {
    setSelected(op.id);
    void operations.reload();
  };
  return (
    <Page title={t('runtime')} subtitle={t('managedOnly')}>
      <Tabs
        destroyInactiveTabPane
        items={[
          {
            key: 'python',
            label: 'Python',
            children: (
              <LanguageRuntime kind="python" onOperation={onOperation} />
            ),
          },
          {
            key: 'node',
            label: 'Node.js',
            children: <LanguageRuntime kind="node" onOperation={onOperation} />,
          },
          {
            key: 'operations',
            label: t('operations'),
            children: (
              <>
                <ErrorPanel error={operations.error} />
                <Table
                  rowKey="id"
                  dataSource={list(operations.data)}
                  columns={[
                    {
                      title: t('id'),
                      dataIndex: 'id',
                      render: (v) => (
                        <Button type="link" onClick={() => setSelected(v)}>
                          #{v}
                        </Button>
                      ),
                    },
                    { title: t('type'), dataIndex: 'operation_type' },
                    {
                      title: t('status'),
                      dataIndex: 'status',
                      render: (v) => <State value={v} />,
                    },
                    { title: t('phase'), dataIndex: 'stage' },
                    { title: t('diagnostics'), dataIndex: 'error_code' },
                  ]}
                />
              </>
            ),
          },
        ]}
      />
      {selected && (
        <Drawer
          open
          title={t('operationId') + ' #' + selected}
          width={860}
          onClose={() => setSelected(undefined)}
        >
          <RuntimeOperation key={selected} id={selected} />
        </Drawer>
      )}
    </Page>
  );
}
