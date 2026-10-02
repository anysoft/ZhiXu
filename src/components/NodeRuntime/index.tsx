import { translateEnum, translateError } from '@/utils/i18n';
import { formatDateTime, formatDuration, formatBytes } from '@/utils/format';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  message,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import { TaskResourceReferences } from '@/components/task-resource-references';
const base = `${config.apiPrefix}runtime/node`;
export default function NodeRuntime({
  onOperation,
}: {
  onOperation: (id: number) => void;
}) {
  useI18nLocale();
  const [runtimes, setRuntimes] = useState<any[]>([]),
    [tools, setTools] = useState<any[]>([]),
    [catalog, setCatalog] = useState<any[]>([]),
    [envs, setEnvs] = useState<any[]>([]),
    [operations, setOperations] = useState<any[]>([]);
  const [taskReferencesBlocked, setTaskReferencesBlocked] = useState(true);
  const [tab, setTab] = useState('versions'),
    [modal, setModal] = useState(''),
    [selected, setSelected] = useState<any>(),
    [revisions, setRevisions] = useState<any[]>([]),
    [builds, setBuilds] = useState<any[]>([]),
    [detailTab, setDetailTab] = useState('overview'),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [lts, setLts] = useState(true),
    [filter, setFilter] = useState('NODE'),
    [diff, setDiff] = useState<any[] | undefined>(),
    [from, setFrom] = useState<number>(),
    [to, setTo] = useState<number>(),
    [exported, setExported] = useState<any>(),
    [error, setError] = useState('');
  const [form] = Form.useForm(),
    runtimeId = Form.useWatch('runtime_id', form);
  async function load() {
    const results = await Promise.all(
      ['installations', 'toolchains', 'catalog', 'environments'].map((x) =>
        request.get(base + '/' + x),
      ),
    );
    if (results.some((x) => x.code !== 200)) throw Error('NODE_READ_FAILED');
    setRuntimes(results[0].data);
    setTools(results[1].data);
    setCatalog(results[2].data.versions);
    setEnvs(results[3].data);
    const ops = await request.get(`${config.apiPrefix}runtime/operations`);
    setOperations(ops.data ?? []);
    setError('');
    if (selected) {
      const [e, r, b] = await Promise.all(
        ['', '/revisions', '/builds'].map((x) =>
          request.get(`${base}/environments/${selected.id}${x}`),
        ),
      );
      if (e.code === 200) {
        setSelected(e.data);
        setRevisions(r.data);
        setBuilds(b.data);
      }
    }
  }
  useEffect(() => {
    void load().catch(() => setError('NODE_READ_FAILED'));
    const timer = setInterval(() => void load().catch(() => {}), 2000);
    return () => clearInterval(timer);
  }, [selected?.id]);
  async function perform(url: string, data: any = {}, remove = false) {
    setBusy(true);
    try {
      const result = remove
        ? await request.delete(base + '/' + url, { data })
        : await request.post(base + '/' + url, data);
      if (result.code !== 200) return false;
      if (result.data?.operation_type) onOperation(result.data.id);
      await load();
      return result.data;
    } catch {
      message.error(tr('ui.requestFailedCheckTheErrorAndResourceStatus'));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function openEnvironment(env: any) {
    setSelected(env);
    setDetailTab('overview');
    setDiff(undefined);
    const [r, b] = await Promise.all(
      ['revisions', 'builds'].map((x) =>
        request.get(`${base}/environments/${env.id}/${x}`),
      ),
    );
    setRevisions(r.data);
    setBuilds(b.data);
  }
  function begin(mode: string) {
    form.resetFields();
    setModal(mode);
    if (mode === 'environment') {
      setEditing(false);
      form.setFieldsValue({
        install_scripts_policy: 'ALLOW',
        production_only: false,
        dependencies: [],
      });
    }
    if (mode === 'toolchain')
      form.setFieldsValue({ manager_type: 'PNPM', version: '10.17.1' });
  }
  async function edit() {
    const rev = revisions.find((x) => x.id === selected.current_revision_id);
    form.resetFields();
    form.setFieldsValue({
      ...selected,
      ...rev,
      name: selected.name,
      description: selected.description,
    });
    setEditing(true);
    setModal('environment');
  }
  const envAction = async (action: string, build?: number, remove = false) =>
    perform(
      `environments/${selected.id}${build ? '/builds/' + build : ''}${
        action ? '/' + action : ''
      }`,
      { expected_version: selected.version },
      remove,
    );
  const columns = [
    { title: tr('ui.package'), dataIndex: 'name' },
    { title: tr('ui.specifier'), dataIndex: 'specifier' },
    { title: tr('ui.type'), dataIndex: 'type' },
  ];
  const current = builds.find((x) => x.id === selected?.current_build_id),
    desired = revisions.find((x) => x.id === selected?.current_revision_id);
  const download = (name: string, text: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' })),
      a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div
      style={{
        maxHeight: 'calc(100vh - 200px)',
        overflowY: 'auto',
        paddingBottom: 24,
      }}
    >
      {error && <Alert type="error" message={translateError(error)} />}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'versions',
            label: tr('ui.versions'),
            children: (
              <>
                <Space wrap style={{ marginBottom: 16 }}>
                  <Button onClick={() => perform('catalog')}>
                    {tr('ui.refreshNodeCatalog')}
                  </Button>
                  <Button type="primary" onClick={() => begin('runtime')}>
                    {tr('ui.installNodeJs')}
                  </Button>
                  <Button onClick={() => begin('toolchain')}>
                    {tr('ui.installPackageManager')}
                  </Button>
                </Space>
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={runtimes}
                  pagination={{ pageSize: 8 }}
                  scroll={{ x: 1050 }}
                  columns={[
                    { title: tr('ui.nodeVersion'), dataIndex: 'version' },
                    {
                      title: 'LTS',
                      render: (_, r) =>
                        catalog.find((x) => x.version === r.version)?.lts ||
                        '—',
                    },
                    {
                      title: tr('ui.status'),
                      dataIndex: 'state',
                      render: (value: unknown) =>
                        translateEnum('runtimeInstallation', value),
                    },
                    {
                      title: tr('ui.health'),
                      dataIndex: 'health',
                      render: (value: unknown) =>
                        translateEnum('health', value),
                    },
                    {
                      title: tr('ui.platform'),
                      render: (_, r) =>
                        `${r.metadata.platform ?? '—'} / ${
                          r.metadata.architecture ?? '—'
                        }`,
                    },
                    {
                      title: tr('ui.installed'),
                      dataIndex: 'installed_at',
                      render: (value: any) => formatDateTime(value),
                    },
                    {
                      title: tr('ui.action'),
                      render: (_, r) => (
                        <Space>
                          <Button
                            onClick={() =>
                              perform(`installations/${r.id}/verify`)
                            }
                          >
                            {tr('ui.verify')}
                          </Button>
                          <Button
                            onClick={async () => {
                              const x = await request.get(
                                `${base}/installations/${r.id}/references`,
                              );
                              setExported({
                                title: tr('ui.runtimeReferences'),
                                text: JSON.stringify(x.data, null, 2),
                              });
                            }}
                          >
                            {tr('ui.references')}
                          </Button>
                          <Popconfirm
                            title={tr(
                              'ui.downloadTheExactVersionAgainAndIsolateTheOldDirectoryExistingReferencesPreventThisOperation',
                            )}
                            onConfirm={() =>
                              perform(`installations/${r.id}/repair`)
                            }
                          >
                            <Button>{tr('ui.repair')}</Button>
                          </Popconfirm>
                          <Popconfirm
                            title={tr('ui.deleteThisNodeRuntime')}
                            onConfirm={() =>
                              perform(`installations/${r.id}`, {}, true)
                            }
                          >
                            <Button danger>{tr('ui.delete')}</Button>
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]}
                />
                <Card
                  title={tr('ui.packageManagerToolchains')}
                  style={{ marginTop: 16 }}
                >
                  <Table
                    rowKey="id"
                    size="small"
                    dataSource={tools}
                    pagination={{ pageSize: 8 }}
                    columns={[
                      { title: 'ID', dataIndex: 'id' },
                      {
                        title: 'Node',
                        render: (_, r) =>
                          runtimes.find((x) => x.id === r.runtime_id)?.version,
                      },
                      { title: tr('ui.manager'), dataIndex: 'manager_type' },
                      { title: tr('ui.exactVersion'), dataIndex: 'version' },
                      {
                        title: tr('ui.state'),
                        dataIndex: 'state',
                        render: (value: unknown) =>
                          translateEnum('nodeToolchain', value),
                      },
                      {
                        title: tr('ui.action'),
                        render: (_, r) => (
                          <Space>
                            <Button
                              onClick={() =>
                                perform(`toolchains/${r.id}/verify`)
                              }
                            >
                              {tr('ui.verifyToolchain')}
                            </Button>
                            <Popconfirm
                              title={tr('ui.deleteThisUnreferencedToolchain')}
                              onConfirm={() =>
                                perform(`toolchains/${r.id}`, {}, true)
                              }
                            >
                              <Button danger>{tr('ui.deleteToolchain')}</Button>
                            </Popconfirm>
                          </Space>
                        ),
                      },
                    ]}
                  />
                </Card>
              </>
            ),
          },
          {
            key: 'environments',
            label: tr('ui.environments'),
            children: (
              <>
                <Button
                  type="primary"
                  onClick={() => begin('environment')}
                  style={{ marginBottom: 16 }}
                >
                  {tr('ui.createNodeEnvironment')}
                </Button>
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={envs}
                  scroll={{ x: 1000 }}
                  columns={[
                    {
                      title: tr('ui.name'),
                      dataIndex: 'name',
                      render: (text, r) => (
                        <Button type="link" onClick={() => openEnvironment(r)}>
                          {text}
                        </Button>
                      ),
                    },
                    {
                      title: 'Node',
                      render: (_, r) =>
                        runtimes.find((x) => x.id === r.runtime_id)?.version,
                    },
                    {
                      title: tr('ui.packageManager'),
                      render: (_, r) => {
                        const t = tools.find((x) => x.id === r.toolchain_id);
                        return `${t?.manager_type ?? '—'} ${t?.version ?? ''}`;
                      },
                    },
                    {
                      title: tr('ui.currentBuild'),
                      dataIndex: 'current_build_id',
                    },
                    {
                      title: tr('ui.status'),
                      dataIndex: 'state',
                      render: (value: unknown) =>
                        translateEnum('nodeToolchain', value),
                    },
                    {
                      title: tr('ui.health'),
                      dataIndex: 'health',
                      render: (value: unknown) =>
                        translateEnum('health', value),
                    },
                    {
                      title: tr('ui.action'),
                      render: (_, r) => (
                        <Button onClick={() => openEnvironment(r)}>
                          {tr('ui.viewEnvironment')}
                        </Button>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
        ]}
      />
      <Card
        title={tr('ui.runtimeOperations')}
        style={{ marginTop: 16 }}
        extra={
          <Select
            aria-label={tr('ui.operationLanguage')}
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'ALL', label: tr('ui.all') },
              { value: 'PYTHON', label: 'Python' },
              { value: 'NODE', label: 'Node.js' },
            ]}
          />
        }
      >
        <Table
          rowKey="id"
          size="small"
          pagination={{ pageSize: 6 }}
          dataSource={operations.filter(
            (x) => filter === 'ALL' || x.language === filter,
          )}
          columns={[
            { title: 'ID', dataIndex: 'id' },
            {
              title: tr('ui.operation'),
              dataIndex: 'operation_type',
              render: (value: unknown) =>
                translateEnum('runtimeOperationType', value),
            },
            {
              title: tr('ui.status'),
              dataIndex: 'status',
              render: (value: unknown) =>
                translateEnum('runtimeOperation', value),
            },
            {
              title: tr('ui.stage'),
              dataIndex: 'stage',
              render: (value: unknown) => translateEnum('runtimeStage', value),
            },
            {
              title: tr('ui.error'),
              dataIndex: 'error_code',
              render: (value: unknown) => (value ? translateError(value) : '—'),
            },
            {
              title: tr('ui.action'),
              render: (_, r) => (
                <Button onClick={() => onOperation(r.id)}>
                  {tr('ui.log')}
                </Button>
              ),
            },
          ]}
        />
      </Card>
      <Modal
        title={
          modal === 'runtime'
            ? tr('ui.installNodeJs')
            : modal === 'toolchain'
            ? tr('ui.installPackageManager')
            : editing
            ? tr('ui.extra.editNodeDependencies')
            : tr('ui.createNodeEnvironment')
        }
        open={!!modal}
        width={760}
        destroyOnClose
        confirmLoading={busy}
        onCancel={() => setModal('')}
        okText={
          modal === 'environment'
            ? tr('ui.extra.saveRevisionAndBuild')
            : tr('ui.extra.install')
        }
        onOk={async () => {
          try {
            const values = await form.validateFields();
            if (modal === 'runtime') {
              if (await perform('installations', values)) setModal('');
            } else if (modal === 'toolchain') {
              if (await perform('toolchains', values)) setModal('');
            } else {
              const env = await perform(
                editing
                  ? `environments/${selected.id}/revisions`
                  : 'environments',
                {
                  ...values,
                  ...(editing ? { expected_version: selected.version } : {}),
                },
              );
              if (env) {
                setModal('');
                setSelected(env);
                await perform(`environments/${env.id}/build`, {
                  expected_version: env.version,
                });
              }
            }
          } catch {}
        }}
      >
        <Form form={form} layout="vertical">
          {modal === 'runtime' ? (
            <>
              <Checkbox
                checked={lts}
                onChange={(e) => setLts(e.target.checked)}
              >
                {tr('ui.ltsOnly')}
              </Checkbox>
              <Form.Item
                name="version"
                label={tr('ui.exactNodeVersion')}
                rules={[{ required: true }]}
              >
                <Select
                  showSearch
                  options={catalog
                    .filter((x) => !lts || x.lts)
                    .map((x) => ({
                      value: x.version,
                      label: `${x.version}${x.lts ? ' · LTS ' + x.lts : ''}`,
                      disabled: runtimes.some((r) => r.version === x.version),
                    }))}
                />
              </Form.Item>
            </>
          ) : (
            <>
              {modal === 'environment' && (
                <>
                  <Form.Item
                    name="name"
                    label={tr('ui.name')}
                    rules={[{ required: true, max: 100 }]}
                  >
                    <Input />
                  </Form.Item>
                  <Form.Item name="description" label={tr('ui.description')}>
                    <Input />
                  </Form.Item>
                </>
              )}
              <Form.Item
                name="runtime_id"
                label={tr('ui.nodeJsRuntime')}
                rules={[{ required: true }]}
              >
                <Select
                  onChange={() => form.setFieldValue('toolchain_id', undefined)}
                  options={runtimes
                    .filter((x) => x.state === 'READY')
                    .map((x) => ({ value: x.id, label: x.version }))}
                />
              </Form.Item>
              {modal === 'toolchain' ? (
                <>
                  <Form.Item
                    name="manager_type"
                    label={tr('ui.packageManager')}
                    rules={[{ required: true }]}
                  >
                    <Select
                      options={[
                        { value: 'PNPM', label: 'pnpm' },
                        { value: 'NPM', label: tr('ui.bundledNpm') },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item
                    name="version"
                    label={tr('ui.exactPnpmVersion109')}
                    extra={tr(
                      'ui.bundledNpmUsesTheExactVersionIncludedWithTheSelectedRuntime',
                    )}
                  >
                    <Input placeholder="10.17.1" />
                  </Form.Item>
                </>
              ) : (
                <>
                  <Form.Item
                    name="toolchain_id"
                    label={tr('ui.packageManagerToolchain')}
                    rules={[{ required: true }]}
                  >
                    <Select
                      options={tools
                        .filter(
                          (x) =>
                            x.state === 'READY' && x.runtime_id === runtimeId,
                        )
                        .map((x) => ({
                          value: x.id,
                          label: `${x.manager_type} ${x.version}`,
                        }))}
                    />
                  </Form.Item>
                  <Form.Item
                    name="install_scripts_policy"
                    label={tr('ui.installScripts')}
                    rules={[{ required: true }]}
                  >
                    <Select
                      options={[
                        { value: 'ALLOW', label: tr('ui.allow') },
                        { value: 'IGNORE', label: tr('ui.ignore') },
                      ]}
                    />
                  </Form.Item>
                  <Alert
                    type="warning"
                    showIcon
                    message={tr(
                      'ui.installingNodeDependenciesMayRunThirdPartyLifecycleScriptsWithThePlatformProcessSOSPermissionsThisFe',
                    )}
                  />
                  <Form.Item name="production_only" valuePropName="checked">
                    <Checkbox>
                      {tr('ui.productionOnlyExcludeDevDependencies')}
                    </Checkbox>
                  </Form.Item>
                  <Form.List name="dependencies">
                    {(fields, { add, remove }) => (
                      <>
                        <p>
                          {tr(
                            'ui.desiredDependenciesExactVersionsRecommendedSemverRangesSupported',
                          )}
                        </p>
                        {fields.map((field) => (
                          <Space key={field.key} align="baseline">
                            <Form.Item
                              name={[field.name, 'name']}
                              rules={[{ required: true }]}
                            >
                              <Input
                                placeholder="@scope/package"
                                aria-label={tr('ui.packageName')}
                              />
                            </Form.Item>
                            <Form.Item
                              name={[field.name, 'specifier']}
                              rules={[{ required: true }]}
                            >
                              <Input
                                placeholder="1.0.0"
                                aria-label={tr('ui.packageSpecifier')}
                              />
                            </Form.Item>
                            <Form.Item
                              name={[field.name, 'type']}
                              rules={[{ required: true }]}
                            >
                              <Select
                                style={{ width: 160 }}
                                options={[
                                  { value: 'DEPENDENCY', label: 'dependency' },
                                  {
                                    value: 'DEV_DEPENDENCY',
                                    label: 'devDependency',
                                  },
                                ]}
                              />
                            </Form.Item>
                            <Button onClick={() => remove(field.name)}>
                              {tr('ui.remove')}
                            </Button>
                          </Space>
                        ))}
                        <Button
                          onClick={() =>
                            add({ name: '', specifier: '', type: 'DEPENDENCY' })
                          }
                        >
                          {tr('ui.addDependency')}
                        </Button>
                      </>
                    )}
                  </Form.List>
                </>
              )}
            </>
          )}
        </Form>
      </Modal>
      <Modal
        title={tr('ui.template.nodeEnvironmentValue', {
          p0: selected?.name ?? '',
        })}
        open={!!selected}
        width="92vw"
        footer={null}
        onCancel={() => setSelected(undefined)}
      >
        {selected && (
          <Tabs
            activeKey={detailTab}
            onChange={setDetailTab}
            items={[
              {
                key: 'overview',
                label: tr('ui.overview'),
                children: (
                  <>
                    <TaskResourceReferences
                      kind="node"
                      id={selected.id}
                      onBlocked={setTaskReferencesBlocked}
                    />
                    <Descriptions bordered size="small">
                      <Descriptions.Item label="ID">
                        {selected.id}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr('ui.state')}>
                        {translateEnum('nodeEnvironment', selected.state)}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr('ui.currentBuild')}>
                        {selected.current_build_id ?? '—'}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr('ui.desiredRevision')}>
                        {selected.current_revision_id}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr('ui.installScripts')}>
                        {selected.install_scripts_policy}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr('ui.lastError')}>
                        {selected.last_error
                          ? translateError(selected.last_error)
                          : '—'}
                      </Descriptions.Item>
                    </Descriptions>
                    <Space wrap style={{ marginTop: 16 }}>
                      <Button onClick={() => envAction('build')}>
                        {tr('ui.buildDesiredRevision')}
                      </Button>
                      <Button
                        onClick={() => envAction('rebuild')}
                        disabled={!current}
                      >
                        {tr('ui.frozenRebuild')}
                      </Button>
                      <Button onClick={() => envAction('resolve')}>
                        {tr('ui.resolveNewBuild')}
                      </Button>
                      <Button
                        onClick={() => {
                          form.resetFields();
                          form.setFieldsValue({
                            name: selected.name,
                            description: selected.description,
                          });
                          setExported({
                            mode: 'metadata',
                            title: tr('ui.editEnvironmentDetails'),
                          });
                        }}
                      >
                        {tr('ui.editDetails')}
                      </Button>
                      <Button
                        onClick={() => {
                          form.resetFields();
                          form.setFieldsValue({
                            name: selected.name + '-copy',
                          });
                          setExported({
                            mode: 'clone',
                            title: tr('ui.cloneEnvironment'),
                          });
                        }}
                      >
                        {tr('ui.clone')}
                      </Button>
                      <Popconfirm
                        title={tr(
                          'ui.deleteTheEnvironmentAndItsBuildsTheRuntimeToolchainAndCacheWillBeRetained',
                        )}
                        onConfirm={async () => {
                          if (await envAction('', undefined, true))
                            setSelected(undefined);
                        }}
                      >
                        <Button danger disabled={taskReferencesBlocked}>
                          {tr('ui.deleteEnvironment')}
                        </Button>
                      </Popconfirm>
                    </Space>
                  </>
                ),
              },
              {
                key: 'dependencies',
                label: tr('ui.dependencies'),
                children: (
                  <>
                    <Button onClick={edit}>{tr('ui.editDependencies')}</Button>
                    <h4>{tr('ui.desiredDependencies')}</h4>
                    <Table
                      rowKey="name"
                      size="small"
                      dataSource={desired?.dependencies ?? []}
                      columns={columns}
                    />
                    <h4>{tr('ui.resolvedPackagesCurrentBuild')}</h4>
                    <Table
                      rowKey={(r) => r.name + '@' + r.version}
                      size="small"
                      dataSource={current?.resolved ?? []}
                      columns={[
                        { title: tr('ui.package'), dataIndex: 'name' },
                        { title: tr('ui.version'), dataIndex: 'version' },
                        {
                          title: tr('ui.directTransitive'),
                          render: (_, r) =>
                            r.direct
                              ? tr('ui.presentation.Direct')
                              : tr('ui.presentation.Transitive'),
                        },
                        {
                          title: tr('ui.type'),
                          dataIndex: 'dependency_type',
                          render: (value: unknown) =>
                            translateEnum('dependencyType', value),
                        },
                      ]}
                    />
                  </>
                ),
              },
              {
                key: 'builds',
                label: tr('ui.builds'),
                children: (
                  <>
                    <Space wrap>
                      <Select
                        placeholder={tr('ui.beforeBuild')}
                        dropdownStyle={{ zIndex: 1400 }}
                        style={{ width: 180 }}
                        value={from}
                        onChange={setFrom}
                        options={builds
                          .filter((x) => x.state === 'READY')
                          .map((x) => ({
                            value: x.id,
                            label: tr('ui.template.buildValue', { p0: x.id }),
                          }))}
                      />
                      <Select
                        placeholder={tr('ui.afterBuild')}
                        dropdownStyle={{ zIndex: 1400 }}
                        style={{ width: 180 }}
                        value={to}
                        onChange={setTo}
                        options={builds
                          .filter((x) => x.state === 'READY')
                          .map((x) => ({
                            value: x.id,
                            label: tr('ui.template.buildValue', { p0: x.id }),
                          }))}
                      />
                      <Button
                        disabled={!from || !to}
                        onClick={async () => {
                          const r = await request.get(
                            `${base}/environments/${selected.id}/diff?from=${from}&to=${to}`,
                          );
                          setDiff(r.data);
                        }}
                      >
                        {tr('ui.buildDiff')}
                      </Button>
                    </Space>
                    {diff && (
                      <Table
                        rowKey="name"
                        size="small"
                        scroll={{ y: 160 }}
                        dataSource={diff}
                        columns={[
                          { title: tr('ui.package'), dataIndex: 'name' },
                          {
                            title: tr('ui.before'),
                            dataIndex: 'before',
                            render: (v) => v.join(', '),
                          },
                          {
                            title: tr('ui.after'),
                            dataIndex: 'after',
                            render: (v) => v.join(', '),
                          },
                          {
                            title: tr('ui.change'),
                            dataIndex: 'change',
                            render: (value: unknown) =>
                              translateEnum('dependencyChange', value),
                          },
                        ]}
                      />
                    )}
                    <Table
                      rowKey="id"
                      size="small"
                      dataSource={builds}
                      scroll={{ x: 1100, y: 330 }}
                      columns={[
                        { title: tr('ui.build'), dataIndex: 'id' },
                        { title: tr('ui.revision'), dataIndex: 'revision_id' },
                        {
                          title: tr('ui.nodeManager'),
                          render: (_, r) =>
                            `${r.metadata.node_version ?? ''} / ${
                              r.metadata.manager_type ?? ''
                            } ${r.metadata.manager_version ?? ''}`,
                        },
                        {
                          title: tr('ui.lockHash'),
                          dataIndex: 'lock_hash',
                          render: (v) => v?.slice(0, 12),
                        },
                        {
                          title: tr('ui.status'),
                          dataIndex: 'state',
                          render: (value: unknown) =>
                            translateEnum('nodeToolchain', value),
                        },
                        {
                          title: tr('ui.health'),
                          dataIndex: 'health',
                          render: (value: unknown) =>
                            translateEnum('health', value),
                        },
                        {
                          title: tr('ui.created'),
                          dataIndex: 'createdAt',
                          render: (value: any) => formatDateTime(value),
                        },
                        {
                          title: tr('ui.action'),
                          render: (_, r) => (
                            <Space>
                              <Button
                                disabled={r.state !== 'READY'}
                                onClick={() => envAction('verify', r.id)}
                              >
                                {tr('ui.verifyBuild')}
                              </Button>
                              <Button
                                disabled={
                                  r.state !== 'READY' ||
                                  r.id === selected.current_build_id
                                }
                                onClick={() => envAction('promote', r.id)}
                              >
                                {tr('ui.promote')}
                              </Button>
                              <Button
                                disabled={!r.lock_hash}
                                onClick={() =>
                                  setExported({
                                    title: tr(
                                      'ui.template.buildValueSnapshots',
                                      { p0: r.id },
                                    ),
                                    build: r,
                                  })
                                }
                              >
                                {tr('ui.export')}
                              </Button>
                              <Popconfirm
                                title={tr('ui.deleteThisUnreferencedBuild')}
                                onConfirm={() => envAction('', r.id, true)}
                              >
                                <Button
                                  danger
                                  disabled={r.id === selected.current_build_id}
                                >
                                  {tr('ui.deleteBuild')}
                                </Button>
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
                key: 'operations',
                label: tr('ui.operations'),
                children: (
                  <Table
                    rowKey="id"
                    size="small"
                    dataSource={operations.filter(
                      (x) =>
                        x.language === 'NODE' &&
                        x.environment_id === selected.id,
                    )}
                    columns={[
                      { title: 'ID', dataIndex: 'id' },
                      {
                        title: tr('ui.type'),
                        dataIndex: 'operation_type',
                        render: (value: unknown) =>
                          translateEnum('runtimeOperationType', value),
                      },
                      {
                        title: tr('ui.status'),
                        dataIndex: 'status',
                        render: (value: unknown) =>
                          translateEnum('runtimeOperation', value),
                      },
                      {
                        title: tr('ui.error'),
                        dataIndex: 'error_code',
                        render: (value: unknown) =>
                          value ? translateError(value) : '—',
                      },
                      {
                        title: tr('ui.action'),
                        render: (_, r) => (
                          <Button onClick={() => onOperation(r.id)}>
                            {tr('ui.log')}
                          </Button>
                        ),
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        )}
      </Modal>
      <Modal
        title={exported?.title}
        open={!!exported}
        width={800}
        onCancel={() => setExported(undefined)}
        footer={exported?.mode ? undefined : null}
        onOk={async () => {
          try {
            const values = await form.validateFields();
            if (exported.mode === 'clone') {
              const env = await perform(
                `environments/${selected.id}/clone`,
                values,
              );
              if (env)
                await perform(`environments/${env.id}/build`, {
                  expected_version: env.version,
                });
            } else {
              await request.patch(`${base}/environments/${selected.id}`, {
                ...values,
                expected_version: selected.version,
              });
              await load();
            }
            setExported(undefined);
          } catch {}
        }}
      >
        {exported?.mode ? (
          <Form form={form} layout="vertical">
            <Form.Item
              name="name"
              label={tr('ui.name')}
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
            {exported.mode === 'metadata' && (
              <Form.Item name="description" label={tr('ui.description')}>
                <Input />
              </Form.Item>
            )}
          </Form>
        ) : exported?.build ? (
          <>
            <Space>
              <Button
                onClick={() =>
                  download('package.json', exported.build.package_json)
                }
              >
                {tr('ui.downloadPackageJson')}
              </Button>
              <Button
                onClick={() =>
                  download(
                    exported.build.metadata.manager_type === 'PNPM'
                      ? 'pnpm-lock.yaml'
                      : 'package-lock.json',
                    exported.build.lockfile,
                  )
                }
              >
                {tr('ui.downloadLockfile')}
              </Button>
            </Space>
            <pre style={{ maxHeight: '55vh', overflow: 'auto' }}>
              {exported.build.package_json + '\n' + exported.build.lockfile}
            </pre>
          </>
        ) : (
          <pre style={{ maxHeight: '55vh', overflow: 'auto' }}>
            {exported?.text}
          </pre>
        )}
      </Modal>
    </div>
  );
}
