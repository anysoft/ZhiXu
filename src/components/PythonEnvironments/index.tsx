import { translateEnum, translateError } from '@/utils/i18n';
import { formatDateTime, formatDuration, formatBytes } from '@/utils/format';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
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
  Typography,
  message,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import { TaskResourceReferences } from '@/components/task-resource-references';
const base = `${config.apiPrefix}runtime/python/environments`;
interface Props {
  runtimes: any[];
  busy: boolean;
  onOperation: (id: number) => void;
}
export default function PythonEnvironments({
  runtimes,
  busy,
  onOperation,
}: Props) {
  useI18nLocale();
  const [rows, setRows] = useState<any[]>([]),
    [selected, setSelected] = useState<number>(),
    [environment, setEnvironment] = useState<any>(),
    [revisions, setRevisions] = useState<any[]>([]),
    [builds, setBuilds] = useState<any[]>([]),
    [operations, setOperations] = useState<any[]>([]);
  const [taskReferencesBlocked, setTaskReferencesBlocked] = useState(true);
  const [editor, setEditor] = useState<
      'create' | 'dependencies' | 'metadata' | 'clone'
    >(),
    [submitting, setSubmitting] = useState(false),
    [error, setError] = useState(''),
    [comparison, setComparison] = useState<any>(),
    [pair, setPair] = useState<number[]>([]);
  const [form] = Form.useForm();
  const call = async (
    method: 'get' | 'post' | 'patch' | 'delete',
    url: string,
    data?: any,
  ) => {
    const result =
      method === 'get'
        ? await request.get(base + url)
        : method === 'delete'
        ? await request.delete(base + url, { data })
        : method === 'patch'
        ? await request.patch<
            unknown,
            { code: number; data: any; message?: string }
          >(base + url, data)
        : await request.post(base + url, data);
    if (result.code !== 200)
      throw Error(result.message ?? 'PYTHON_ENV_REQUEST_FAILED');
    return result.data;
  };
  const load = async () => {
    setRows(await call('get', ''));
    if (selected) {
      const values = await Promise.all(
        ['', '/revisions', '/builds', '/operations'].map((s) =>
          call('get', `/${selected}${s}`),
        ),
      );
      setEnvironment(values[0]);
      setRevisions(values[1]);
      setBuilds(values[2]);
      setOperations(values[3]);
    }
    setError('');
  };
  useEffect(() => {
    load().catch(() => setError('PYTHON_ENV_REQUEST_FAILED'));
    const timer = setInterval(() => load().catch(() => {}), 2000);
    return () => clearInterval(timer);
  }, [selected]);
  const act = async (url: string, remove = false) => {
    setSubmitting(true);
    try {
      const op = await call(remove ? 'delete' : 'post', url, {
        expected_version: environment.version,
      });
      onOperation(op.id);
      await load();
    } catch {
      message.error(tr('ui.operationFailedRefreshTheStatusBeforeRetrying'));
    } finally {
      setSubmitting(false);
    }
  };
  const edit = (mode: typeof editor) => {
    setEditor(mode);
    form.resetFields();
    const revision = revisions.find(
      (x) => x.id === environment?.current_revision_id,
    );
    form.setFieldsValue({
      name: mode === 'clone' ? `${environment.name}-copy` : environment?.name,
      description: environment?.description ?? '',
      runtime_id:
        revision?.runtime_id ??
        runtimes.find((x) => x.state === 'READY' && x.health === 'HEALTHY')?.id,
      requirements:
        revision?.dependencies.map((x: any) => x.requirement).join('\n') ?? '',
    });
  };
  const save = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      let env = environment;
      if (editor === 'metadata') {
        await call('patch', `/${selected}`, {
          name: values.name,
          description: values.description ?? '',
          expected_version: environment.version,
        });
      } else {
        if (editor === 'clone') {
          env = await call('post', `/${selected}/clone`, { name: values.name });
        } else {
          const specs = {
            runtime_id: values.runtime_id,
            requirements: values.requirements
              .split(/\r?\n/)
              .map((x: string) => x.trim())
              .filter(Boolean),
          };
          if (editor === 'create')
            env = await call('post', '', {
              name: values.name,
              description: values.description ?? '',
              ...specs,
            });
          else {
            await call('post', `/${selected}/revisions`, {
              ...specs,
              expected_version: environment.version,
            });
            env = await call('get', `/${selected}`);
          }
        }
        setSelected(env.id);
        setEnvironment(env);
        // Definition is retained even if the later build request encounters a busy provider.
        const operation = await call('post', `/${env.id}/build`, {
          expected_version: env.version,
        });
        onOperation(operation.id);
      }
      setEditor(undefined);
      await load();
    } catch {
      message.error(
        tr(
          'ui.saveOrBuildFailedCheckYourInputAndRefreshSavedDefinitionsCanBeRebuilt',
        ),
      );
    } finally {
      setSubmitting(false);
    }
  };
  const current = builds.find((x) => x.id === environment?.current_build_id),
    desired = revisions.find((x) => x.id === environment?.current_revision_id),
    disabled = busy || submitting;
  return (
    <div
      style={{
        maxHeight: 'calc(100vh - 190px)',
        overflowY: 'auto',
        paddingRight: 8,
      }}
    >
      {error && (
        <Alert
          type="error"
          message={translateError(error)}
          action={<Button onClick={() => load()}>{tr('ui.retry')}</Button>}
        />
      )}
      <Card
        title={tr('ui.pythonEnvironments')}
        extra={
          <Button
            type="primary"
            onClick={() => edit('create')}
            disabled={
              disabled ||
              !runtimes.some(
                (x) => x.state === 'READY' && x.health === 'HEALTHY',
              )
            }
          >
            {tr('ui.createEnvironment')}
          </Button>
        }
      >
        <Table
          rowKey="id"
          dataSource={rows}
          pagination={{ pageSize: 10 }}
          scroll={{ x: 900 }}
          columns={[
            {
              title: tr('ui.name'),
              dataIndex: 'name',
              render: (name: string, row: any) => (
                <Button
                  type="link"
                  onClick={() => {
                    setEnvironment(row);
                    setSelected(row.id);
                  }}
                >
                  {name}
                </Button>
              ),
            },
            { title: 'Python', dataIndex: 'runtime_version' },
            {
              title: tr('ui.status'),
              render: (_: any, row: any) => (
                <Tag>
                  {translateEnum('pythonEnvironment', row.state)} /{' '}
                  {translateEnum('health', row.health)}
                </Tag>
              ),
            },
            {
              title: tr('ui.currentBuild'),
              dataIndex: 'current_build_id',
              render: (x: number) => (x ? `#${x}` : '—'),
            },
            {
              title: tr('ui.directResolved'),
              render: (_: any, row: any) =>
                `${row.direct_packages} / ${row.resolved_packages}`,
            },
            {
              title: tr('ui.updated'),
              dataIndex: 'updatedAt',
              render: (value: any) => formatDateTime(value),
            },
          ]}
        />
      </Card>
      {environment && (
        <Card
          title={tr('ui.template.environmentValue', { p0: environment.name })}
          style={{ marginTop: 16 }}
          extra={
            <Space>
              <Button disabled={disabled} onClick={() => edit('metadata')}>
                {tr('ui.editDetails')}
              </Button>
              <Button disabled={disabled} onClick={() => edit('clone')}>
                {tr('ui.clone')}
              </Button>
              <Popconfirm
                title={tr('ui.deleteThisEnvironmentAndItsUnusedBuilds')}
                onConfirm={async () => {
                  await act(`/${environment.id}`, true);
                  setSelected(undefined);
                  setEnvironment(undefined);
                }}
              >
                <Button danger disabled={disabled || taskReferencesBlocked}>
                  {tr('ui.deleteEnvironment')}
                </Button>
              </Popconfirm>
            </Space>
          }
        >
          <Tabs
            items={[
              {
                key: 'overview',
                label: tr('ui.overview'),
                children: (
                  <>
                    <TaskResourceReferences
                      kind="python"
                      id={environment.id}
                      onBlocked={setTaskReferencesBlocked}
                    />
                    <Descriptions column={2}>
                      <Descriptions.Item label={tr('ui.environmentID')}>
                        {environment.id}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr('ui.runtimeID')}>
                        {environment.runtime_id}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr('ui.state')}>
                        {translateEnum('pythonEnvironment', environment.state)}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr('ui.currentBuild')}>
                        {environment.current_build_id ?? '—'}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr('ui.desiredRevision')}>
                        {environment.current_revision_id}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr('ui.buildHealth')}>
                        {translateEnum(
                          'health',
                          current?.health ?? 'UNVERIFIED',
                        )}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr('ui.diskUsage')}>
                        {current?.metadata.disk_bytes ?? 0}{' '}
                        {tr('ui.bytesVariant404')}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr('ui.pythonExecutable')}>
                        {current?.health === 'HEALTHY'
                          ? tr('ui.extra.verified')
                          : tr('ui.extra.unverified')}
                      </Descriptions.Item>
                    </Descriptions>
                    {environment.last_error && (
                      <Alert
                        type="warning"
                        message={translateError(environment.last_error)}
                      />
                    )}
                    <Button
                      disabled={disabled}
                      onClick={() => act(`/${environment.id}/rebuild`)}
                    >
                      {tr('ui.rebuild')}
                    </Button>
                  </>
                ),
              },
              {
                key: 'dependencies',
                label: tr('ui.dependencies'),
                children: (
                  <>
                    <Space>
                      <Button
                        disabled={disabled}
                        onClick={() => edit('dependencies')}
                      >
                        {tr('ui.editDependenciesAndBuild')}
                      </Button>
                      <Button
                        disabled={!current}
                        onClick={async () => {
                          const result = await call(
                            'get',
                            `/${environment.id}/builds/${current.id}/freeze`,
                          );
                          Modal.info({
                            title: tr('ui.resolvedRequirements'),
                            width: 700,
                            content: (
                              <Typography.Paragraph
                                copyable={{ text: result.text }}
                              >
                                <pre>{result.text}</pre>
                              </Typography.Paragraph>
                            ),
                          });
                        }}
                      >
                        {tr('ui.exportResolvedRequirements')}
                      </Button>
                    </Space>
                    <Typography.Paragraph>
                      {tr(
                        'ui.dependencyChangesCreateANewRevisionAndBuildPublishedBuildsRemainIntact',
                      )}
                    </Typography.Paragraph>
                    <Table
                      size="small"
                      rowKey="normalized_name"
                      pagination={false}
                      dataSource={desired?.dependencies ?? []}
                      columns={[
                        {
                          title: tr('ui.directPackage'),
                          dataIndex: 'normalized_name',
                        },
                        {
                          title: tr('ui.desiredRequirement'),
                          dataIndex: 'requirement',
                        },
                      ]}
                    />
                    <Table
                      size="small"
                      rowKey="name"
                      pagination={false}
                      dataSource={current?.resolved ?? []}
                      columns={[
                        { title: tr('ui.resolvedPackage'), dataIndex: 'name' },
                        { title: tr('ui.version'), dataIndex: 'version' },
                        {
                          title: tr('ui.relation'),
                          dataIndex: 'direct',
                          render: (x: boolean) =>
                            x
                              ? tr('ui.presentation.Direct')
                              : tr('ui.presentation.TransitiveToolchain'),
                        },
                        {
                          title: tr('ui.indexPolicy'),
                          dataIndex: 'source_index',
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
                    <Space>
                      <Select
                        mode="multiple"
                        placeholder={tr('ui.selectTwoBuildsToCompare')}
                        style={{ minWidth: 250 }}
                        value={pair}
                        onChange={(x) => setPair(x.slice(-2))}
                        options={builds.map((x) => ({
                          value: x.id,
                          label: tr('ui.template.buildValue', { p0: x.id }),
                        }))}
                      />
                      <Button
                        disabled={pair.length !== 2}
                        onClick={async () =>
                          setComparison(
                            await call(
                              'get',
                              `/${environment.id}/diff?from=${pair[0]}&to=${pair[1]}`,
                            ),
                          )
                        }
                      >
                        {tr('ui.compareBuilds')}
                      </Button>
                    </Space>
                    {comparison && (
                      <div
                        aria-label={tr('ui.buildDependencyDiff')}
                        style={{ margin: '12px 0' }}
                      >
                        <Typography.Text>
                          {tr('ui.buildVariant30')} {comparison.from} → #
                          {comparison.to}
                        </Typography.Text>
                        <Table
                          size="small"
                          rowKey="name"
                          pagination={false}
                          scroll={{ y: 180 }}
                          dataSource={[
                            ...comparison.added.map((x: any) => ({
                              name: x.name,
                              from: '—',
                              to: x.version,
                              change: 'Added',
                            })),
                            ...comparison.removed.map((x: any) => ({
                              name: x.name,
                              from: x.version,
                              to: '—',
                              change: 'Removed',
                            })),
                            ...comparison.changed.map((x: any) => ({
                              ...x,
                              change: 'Changed',
                            })),
                          ]}
                          columns={[
                            { title: tr('ui.package'), dataIndex: 'name' },
                            { title: tr('ui.before'), dataIndex: 'from' },
                            { title: tr('ui.after'), dataIndex: 'to' },
                            {
                              title: tr('ui.change'),
                              dataIndex: 'change',
                              render: (value: unknown) =>
                                translateEnum('dependencyChange', value),
                            },
                          ]}
                        />
                      </div>
                    )}
                    <Table
                      rowKey="id"
                      dataSource={builds}
                      pagination={false}
                      scroll={{ x: 1000, y: 300 }}
                      columns={[
                        {
                          title: tr('ui.build'),
                          dataIndex: 'id',
                          render: (x: number) => (
                            <span>
                              #{x}{' '}
                              {x === environment.current_build_id && (
                                <Tag color="green">{tr('ui.current')}</Tag>
                              )}
                            </span>
                          ),
                        },
                        { title: tr('ui.revision'), dataIndex: 'revision_id' },
                        { title: tr('ui.runtime'), dataIndex: 'runtime_id' },
                        {
                          title: tr('ui.status'),
                          render: (_: any, x: any) =>
                            `${translateEnum(
                              'pythonBuild',
                              x.state,
                            )} / ${translateEnum('health', x.health)}`,
                        },
                        {
                          title: tr('ui.packages'),
                          dataIndex: 'resolved',
                          render: (x: any[]) => x.length,
                        },
                        {
                          title: tr('ui.created'),
                          dataIndex: 'createdAt',
                          render: (value: any) => formatDateTime(value),
                        },
                        {
                          title: tr('ui.actions'),
                          render: (_: any, x: any) => (
                            <Space>
                              <Button
                                disabled={disabled || x.state !== 'READY'}
                                onClick={() =>
                                  act(
                                    `/${environment.id}/builds/${x.id}/verify`,
                                  )
                                }
                              >
                                {tr('ui.verifyBuildVariant585')}
                              </Button>
                              <Button
                                disabled={
                                  disabled ||
                                  x.state !== 'READY' ||
                                  x.id === environment.current_build_id
                                }
                                onClick={() =>
                                  act(
                                    `/${environment.id}/builds/${x.id}/promote`,
                                  )
                                }
                              >
                                {tr('ui.setAsCurrent')}
                              </Button>
                              <Popconfirm
                                title={tr('ui.deleteThisUnusedBuild')}
                                onConfirm={() =>
                                  act(`/${environment.id}/builds/${x.id}`, true)
                                }
                              >
                                <Button
                                  danger
                                  disabled={
                                    disabled ||
                                    x.id === environment.current_build_id
                                  }
                                >
                                  {tr('ui.deleteBuildVariant457')}
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
                    dataSource={operations}
                    pagination={false}
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
                        render: (value: unknown) =>
                          translateEnum('runtimeStage', value),
                      },
                      {
                        title: tr('ui.log'),
                        render: (_: any, x: any) => (
                          <Button onClick={() => onOperation(x.id)}>
                            {tr('ui.viewOperationLog')}
                          </Button>
                        ),
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        </Card>
      )}
      <Modal
        title={
          editor === 'create'
            ? tr('ui.extra.createPythonEnvironment')
            : editor === 'dependencies'
            ? tr('ui.editDependenciesAndBuild')
            : editor === 'clone'
            ? tr('ui.extra.cloneEnvironment')
            : tr('ui.extra.editEnvironment')
        }
        open={!!editor}
        onCancel={() => setEditor(undefined)}
        onOk={save}
        confirmLoading={submitting}
        okText={
          editor === 'metadata'
            ? tr('ui.extra.save')
            : tr('ui.extra.saveAndBuild')
        }
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          {editor !== 'dependencies' && (
            <Form.Item
              name="name"
              label={tr('ui.environmentName')}
              rules={[{ required: true, max: 100 }]}
            >
              <Input />
            </Form.Item>
          )}
          {(editor === 'create' || editor === 'metadata') && (
            <Form.Item name="description" label={tr('ui.description')}>
              <Input.TextArea maxLength={1000} />
            </Form.Item>
          )}
          {(editor === 'create' || editor === 'dependencies') && (
            <>
              <Form.Item
                name="runtime_id"
                label={tr('ui.pythonRuntime')}
                rules={[{ required: true }]}
              >
                <Select
                  options={runtimes
                    .filter(
                      (x) => x.state === 'READY' && x.health === 'HEALTHY',
                    )
                    .map((x) => ({
                      value: x.id,
                      label: `CPython ${x.version} (#${x.id})`,
                    }))}
                />
              </Form.Item>
              <Form.Item
                name="requirements"
                label={tr('ui.dependenciesOnePEP508RequirementPerLine')}
              >
                <Input.TextArea
                  rows={6}
                  placeholder={'requests==2.32.3\nhttpx[http2]>=0.27,<0.29'}
                />
              </Form.Item>
              <Alert
                type="info"
                message={tr(
                  'ui.usesPublicPyPIByDefaultPrivateAuthenticatedIndexesURLsVCSAndLocalPathsAreNotSupported',
                )}
              />
            </>
          )}
        </Form>
      </Modal>
    </div>
  );
}
