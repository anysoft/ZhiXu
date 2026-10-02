import { translateEnum, translateError } from '@/utils/i18n';
import { formatDateTime, formatDuration, formatBytes } from '@/utils/format';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import TaskPolicy, { TaskHealth } from '@/components/observability/taskPolicy';
import { RunsTable, RunDetail } from '@/components/observability';
import TaskTriggers from './triggers';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import { TaskEnvironment } from '@/components/scoped-environment';
import { ConfigBindings } from '@/components/config-bindings';
import { TaskHooks } from '@/components/task-hooks';
const api = config.apiPrefix;
const kindOf = (language: string) =>
  language === 'PYTHON' ? 'PYTHON' : language === 'SHELL' ? 'SHELL' : 'NODE';
const languageOf = (entry: string) =>
  entry.endsWith('.py')
    ? 'PYTHON'
    : entry.endsWith('.sh')
    ? 'SHELL'
    : entry.endsWith('.ts')
    ? 'TYPESCRIPT'
    : 'JAVASCRIPT';
async function get(resource: string) {
  const response = await request.get(api + resource);
  if (response.code !== 200) throw Error(response.message);
  return response.data;
}
function RuntimeDefaults({
  repositoryId,
  subscriptionId,
  kind,
  environments,
  onChange,
}: {
  repositoryId?: number;
  subscriptionId?: number;
  kind: string;
  environments: any[];
  onChange: () => void;
}) {
  useI18nLocale();
  const [detailRun, setDetailRun] = useState<number>();
  const [rows, setRows] = useState<Record<string, any>>({}),
    [values, setValues] = useState<Record<string, number | null>>({});
  const scopes = [
    { name: 'Repository', resource: 'repositories', id: repositoryId },
    ...(subscriptionId
      ? [
          {
            name: 'Subscription',
            resource: 'subscriptions',
            id: subscriptionId,
          },
        ]
      : []),
  ];
  const load = async () => {
    const result: Record<string, any> = {};
    for (const scope of scopes)
      if (scope.id)
        result[scope.name] = (
          await get(`${scope.resource}/${scope.id}/runtime-defaults`)
        ).find((row: any) => row.kind === kind);
    setRows(result);
    setValues(
      Object.fromEntries(
        Object.entries(result).map(([key, row]) => [
          key,
          (kind === 'PYTHON'
            ? row?.python_environment_id
            : row?.node_environment_id) ?? null,
        ]),
      ),
    );
  };
  useEffect(() => {
    load().catch(() => {});
  }, [repositoryId, subscriptionId, kind]);
  if (kind === 'SHELL') return null;
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {scopes
        .filter((s) => s.id)
        .map((scope) => (
          <Card
            size="small"
            key={scope.name}
            title={tr('ui.template.valueRuntimeDefault', {
              p0: translateEnum('scope', scope.name.toUpperCase()),
            })}
          >
            <Space>
              <Select
                aria-label={tr('ui.template.valueRuntimeDefault', {
                  p0: translateEnum('scope', scope.name.toUpperCase()),
                })}
                style={{ minWidth: 220 }}
                value={values[scope.name] ?? null}
                onChange={(value) =>
                  setValues((old) => ({ ...old, [scope.name]: value }))
                }
                options={[
                  { value: null, label: tr('ui.unsetInherit') },
                  ...environments.map((env) => ({
                    value: env.id,
                    label: env.name,
                  })),
                ]}
              />
              <Button
                onClick={async () => {
                  const response = await request.put(
                    api + `${scope.resource}/${scope.id}/runtime-defaults`,
                    {
                      kind,
                      environment_id: values[scope.name] ?? null,
                      expected_version: rows[scope.name]?.version ?? 0,
                    },
                  );
                  if (response.code === 200) {
                    await load();
                    onChange();
                    message.success(tr('ui.runtimeDefaultSaved'));
                  }
                }}
              >
                {tr('ui.saveScopeDefault', {
                  scope: translateEnum('scope', scope.name.toUpperCase()),
                })}
              </Button>
            </Space>
          </Card>
        ))}
    </Space>
  );
}
export default function TasksPage() {
  useI18nLocale();
  const [detailRun, setDetailRun] = useState<number>();
  const [rows, setRows] = useState<any[]>([]),
    [worktrees, setWorktrees] = useState<any[]>([]),
    [python, setPython] = useState<any[]>([]),
    [node, setNode] = useState<any[]>([]),
    [entries, setEntries] = useState<string[]>([]);
  const [selected, setSelected] = useState<any>(),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState('general'),
    [preview, setPreview] = useState<any>(),
    [log, setLog] = useState<string>(),
    [runs, setRuns] = useState<any[]>(),
    [runTask, setRunTask] = useState<number>();
  const [form] = Form.useForm();
  const worktreeId = Form.useWatch('worktree_id', form),
    language = Form.useWatch('language', form) ?? 'SHELL',
    cwdMode = Form.useWatch('cwd_mode', form),
    environmentId = Form.useWatch('environment_id', form);
  const kind = kindOf(language),
    environments = kind === 'PYTHON' ? python : node,
    worktree = worktrees.find((row) => row.id === worktreeId);
  const load = async () => {
    const [tasks, trees, py, js] = await Promise.all([
      get('tasks?size=1000'),
      get('worktrees'),
      get('runtime/python/environments'),
      get('runtime/node/environments'),
    ]);
    setRows(tasks.data);
    setWorktrees(trees);
    setPython(py);
    setNode(js);
  };
  useEffect(() => {
    load()
      .then(() => {
        const id = Number(
          new URLSearchParams(window.location.search).get('task_id'),
        );
        if (id > 0) return edit(id);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (worktreeId)
      get(`task-sources/${worktreeId}/entries`)
        .then(setEntries)
        .catch(() => setEntries([]));
    else setEntries([]);
  }, [worktreeId]);
  const edit = async (id?: number) => {
    const task = id ? await get(`tasks/${id}`) : null;
    setSelected(task);
    setPreview(task?.resources);
    setTab('general');
    form.resetFields();
    form.setFieldsValue({
      name: task?.name,
      description: task?.description ?? '',
      enabled: task?.enabled ?? false,
      worktree_id: task?.source?.worktree_id,
      relative_entrypoint: task?.source?.relative_entrypoint,
      language: task?.source?.language ?? 'SHELL',
      cwd_mode: task?.source?.cwd_mode ?? 'ENTRYPOINT_DIR',
      cwd_relative_path: task?.source?.cwd_relative_path,
      environment_id:
        task?.runtime?.python_environment_id ??
        task?.runtime?.node_environment_id ??
        null,
      arguments_json: JSON.stringify(task?.arguments ?? [], null, 2),
      timeout_seconds: task?.settings?.timeout_seconds ?? null,
      max_attempts: task?.settings?.max_attempts ?? 1,
      initial_delay_seconds: task?.settings?.initial_delay_seconds ?? 0,
      backoff: task?.settings?.backoff ?? 'FIXED',
      concurrency: task?.settings?.concurrency ?? 'FORBID',
      notification: task?.settings?.notification ?? 'NONE',
    });
    setOpen(true);
  };
  const save = async () => {
    setBusy(true);
    try {
      const value = await form.validateFields();
      let args;
      try {
        args = JSON.parse(value.arguments_json);
        if (
          !Array.isArray(args) ||
          args.some((arg: unknown) => typeof arg !== 'string')
        )
          throw Error();
      } catch {
        message.error(tr('ui.argumentsMustBeAJSONArrayOfStrings'));
        return;
      }
      const body = {
        name: value.name,
        description: value.description,
        enabled: value.enabled,
        arguments: args,
        expected_version: selected?.version,
        source: {
          type: 'WORKTREE_ENTRYPOINT',
          worktree_id: value.worktree_id,
          relative_entrypoint: value.relative_entrypoint,
          language: value.language,
          cwd_mode: value.cwd_mode,
          cwd_relative_path:
            value.cwd_mode === 'CUSTOM_RELATIVE'
              ? value.cwd_relative_path
              : null,
        },
        runtime: {
          kind,
          python_environment_id:
            kind === 'PYTHON' ? value.environment_id ?? null : null,
          node_environment_id:
            kind === 'NODE' ? value.environment_id ?? null : null,
        },
        settings: {
          timeout_seconds: value.timeout_seconds ?? null,
          max_attempts: value.max_attempts,
          initial_delay_seconds: value.initial_delay_seconds,
          backoff: value.backoff,
          concurrency: value.concurrency,
          notification: value.notification,
        },
      };
      const response = selected
        ? await request.put(api + `tasks/${selected.id}`, body)
        : await request.post(api + 'tasks', body);
      if (response.code === 200) {
        setSelected(response.data);
        setPreview(response.data.resources);
        await load();
        message.success(tr('ui.taskSaved'));
      }
    } finally {
      setBusy(false);
    }
  };
  const validate = async (id: number) => {
    const response = await request.post(api + `tasks/${id}/validate`);
    if (response.code === 200) {
      setPreview(response.data);
      if (!open)
        Modal.info({
          title: tr('ui.taskReadiness'),
          content: (
            <pre style={{ whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(response.data.readiness, null, 2)}
            </pre>
          ),
        });
      await load();
    }
  };
  const inherited = () =>
    selected && get(`tasks/${selected.id}/resources`).then(setPreview);
  const resourceTabs = selected
    ? [
        {
          key: 'runs',
          label: tr('ui.runs'),
          children: <RunsTable taskId={selected.id} />,
        },
        {
          key: 'health',
          label: tr('ui.health'),
          children: <TaskHealth id={selected.id} />,
        },
        {
          key: 'notifications',
          label: tr('ui.notifications'),
          children: <TaskPolicy id={selected.id} />,
        },
        {
          key: 'environment',
          label: 'ENV',
          children: <TaskEnvironment id={selected.id} />,
        },
        {
          key: 'config',
          label: tr('ui.config'),
          children: <ConfigBindings scope="task" id={selected.id} />,
        },
        {
          key: 'hooks',
          label: tr('ui.hooks'),
          children: <TaskHooks id={selected.id} />,
        },
      ]
    : ['ENV', 'Config', 'Hooks'].map((label) => ({
        key: label.toLowerCase(),
        label,
        children: (
          <Alert
            message={tr(
              'ui.saveTheTaskFirstThenConfigureTheseSeparatelySavedResources',
            )}
          />
        ),
      }));
  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Space>
          <Typography.Title level={2} style={{ margin: 0 }}>
            {tr('ui.tasks')}
          </Typography.Title>
          <Button type="primary" onClick={() => edit()}>
            {tr('ui.createTask')}
          </Button>
          <Button onClick={load}>{tr('ui.refresh')}</Button>
        </Space>
        <Alert
          type="info"
          showIcon
          message={tr('ui.configuredResources')}
          description={tr(
            'ui.tasksExecuteFilesInAWorktreeEachRunPinsTheEnvironmentBuildVariablesConfigAndHooksArgumentsArePassedI',
          )}
        />
        <Table
          rowKey="id"
          dataSource={rows}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 1100 }}
          columns={[
            {
              title: tr('ui.name'),
              dataIndex: 'name',
              render: (name: string, task: any) => (
                <Button type="link" onClick={() => edit(task.id)}>
                  {name}
                </Button>
              ),
            },
            {
              title: tr('ui.source'),
              render: (_: unknown, task: any) =>
                task.resources?.source?.relative_entrypoint ??
                tr('ui.extra.sourceRequired'),
            },
            {
              title: tr('ui.runtime'),
              render: (_: unknown, task: any) => (
                <span>
                  {task.resources?.runtime?.kind
                    ? translateEnum('language', task.resources.runtime.kind)
                    : tr('ui.extra.unbound')}{' '}
                  · {task.resources?.runtime?.environment_id ?? '—'}
                  <br />
                  {translateEnum(
                    'selectionSource',
                    task.resources?.runtime?.selected_by,
                  )}
                </span>
              ),
            },
            {
              title: tr('ui.lastRun'),
              render: (_: unknown, task: any) =>
                task.last_run
                  ? tr('ui.lastRunSummary', {
                      status: translateEnum('taskRun', task.last_run.status),
                      id: task.last_run.id,
                      count: task.last_run.attempt_count,
                    })
                  : tr('ui.extra.noRuns'),
            },
            {
              title: tr('ui.readiness'),
              render: (_: unknown, task: any) => (
                <Tag
                  color={
                    task.resources?.readiness?.status === 'READY'
                      ? 'green'
                      : 'orange'
                  }
                >
                  {translateEnum(
                    'readiness',
                    task.resources?.readiness?.status,
                  )}
                </Tag>
              ),
            },
            {
              title: tr('ui.enabled'),
              render: (_: unknown, task: any) => (
                <Switch
                  checked={task.enabled}
                  onChange={async (enabled) => {
                    const response = await request.put(
                      api + `tasks/${task.id}/enabled`,
                      { enabled, expected_version: task.version },
                    );
                    if (response.code === 200) await load();
                  }}
                />
              ),
            },
            {
              title: tr('ui.actions'),
              render: (_: unknown, task: any) => (
                <Space wrap>
                  <Button onClick={() => validate(task.id)}>
                    {tr('ui.validate')}
                  </Button>
                  <Button
                    onClick={async () => {
                      const response = await request.post(
                        api + `tasks/${task.id}/clone`,
                        { name: task.name + ' copy' },
                      );
                      if (response.code === 200) {
                        await load();
                        await edit(response.data.id);
                        if (response.data.webhook_secrets?.length)
                          Modal.info({
                            title: tr('ui.copyClonedWebhookSecretsNow'),
                            content: (
                              <pre>
                                {JSON.stringify(
                                  response.data.webhook_secrets,
                                  null,
                                  2,
                                )}
                              </pre>
                            ),
                            width: 700,
                          });
                      }
                    }}
                  >
                    {tr('ui.clone')}
                  </Button>
                  <Button
                    onClick={async () => {
                      await request.post(api + `tasks/${task.id}/run`, {
                        source: 'MANUAL',
                      });
                      await load();
                    }}
                  >
                    {tr('ui.run')}
                  </Button>
                  <Button
                    onClick={async () => {
                      setRunTask(task.id);
                      setRuns(await get(`tasks/${task.id}/runs`));
                    }}
                  >
                    {tr('ui.runs')}
                  </Button>
                  <Button
                    onClick={async () => {
                      await request.post(api + `tasks/${task.id}/stop`);
                      await load();
                    }}
                  >
                    {tr('ui.stop')}
                  </Button>
                  <Button
                    onClick={async () => {
                      const latest = await get(
                        `task-runs?task_id=${task.id}&limit=1`,
                      );
                      if (latest.data[0]) setDetailRun(latest.data[0].id);
                    }}
                  >
                    {tr('ui.log')}
                  </Button>
                  <Popconfirm
                    title={tr(
                      'ui.deleteTaskAndItsOwnedBindingsHistoricalLogsAreRetained',
                    )}
                    onConfirm={async () => {
                      const response = await request.delete(
                        api + `tasks/${task.id}`,
                        { data: { expected_version: task.version } },
                      );
                      if (response.code === 200) await load();
                    }}
                  >
                    <Button danger>{tr('ui.delete')}</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
        <Modal
          title={
            selected
              ? tr('ui.presentation.taskTitle', { name: selected.name })
              : tr('ui.createTask')
          }
          open={open}
          width={960}
          onCancel={() => setOpen(false)}
          footer={
            <Space>
              {selected && (
                <Button onClick={() => validate(selected.id)}>
                  {tr('ui.validateTask')}
                </Button>
              )}
              <Button onClick={() => setOpen(false)}>{tr('ui.close')}</Button>
              <Button type="primary" loading={busy} onClick={save}>
                {tr('ui.saveTask')}
              </Button>
            </Space>
          }
          destroyOnClose
        >
          <Form name="task-definition" form={form} layout="vertical" preserve>
            <Tabs
              activeKey={tab}
              onChange={setTab}
              items={[
                {
                  key: 'general',
                  label: tr('ui.general'),
                  forceRender: true,
                  children: (
                    <>
                      <Form.Item
                        name="name"
                        label={tr('ui.name')}
                        rules={[{ required: true }]}
                      >
                        <Input maxLength={255} />
                      </Form.Item>
                      <Form.Item
                        name="description"
                        label={tr('ui.description')}
                      >
                        <Input.TextArea />
                      </Form.Item>
                      <Form.Item
                        name="enabled"
                        label={tr('ui.enabled')}
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name="arguments_json"
                        label={tr('ui.argumentsJSONArray')}
                        rules={[{ required: true }]}
                      >
                        <Input.TextArea rows={4} />
                      </Form.Item>
                      <Alert
                        message={tr(
                          'ui.doNotPutSecretsInArgumentsUseEnvironmentOrConfigAssetsArgumentsCanAppearInProcessListingsTOKENIsALit',
                        )}
                      />
                    </>
                  ),
                },
                {
                  key: 'source',
                  label: tr('ui.source'),
                  forceRender: true,
                  children: (
                    <>
                      <Form.Item
                        name="worktree_id"
                        label="Worktree"
                        rules={[{ required: true }]}
                      >
                        <Select
                          showSearch
                          optionFilterProp="label"
                          disabled={selected?.origin === 'DISCOVERED'}
                          options={worktrees.map((tree) => ({
                            value: tree.id,
                            label: tr('ui.template.valueRepositoryValueValue', {
                              p0: tree.name,
                              p1: tree.repository_id,
                              p2: tree.ref_name,
                            }),
                          }))}
                          onChange={() =>
                            form.setFieldValue('relative_entrypoint', undefined)
                          }
                        />
                      </Form.Item>
                      <Form.Item
                        name="relative_entrypoint"
                        label={tr('ui.entrypoint')}
                        rules={[{ required: true }]}
                      >
                        <Select
                          showSearch
                          disabled={selected?.origin === 'DISCOVERED'}
                          options={entries.map((entry) => ({
                            value: entry,
                            label: entry,
                          }))}
                          onChange={(entry) => {
                            const next = languageOf(entry);
                            if (kindOf(next) !== kind)
                              form.setFieldValue('environment_id', null);
                            form.setFieldValue('language', next);
                          }}
                        />
                      </Form.Item>
                      <Form.Item name="language" label={tr('ui.language')}>
                        <Input readOnly />
                      </Form.Item>
                      <Form.Item
                        name="cwd_mode"
                        label={tr('ui.workingDirectoryVariant397')}
                      >
                        <Select
                          options={[
                            'WORKTREE_ROOT',
                            'ENTRYPOINT_DIR',
                            'CUSTOM_RELATIVE',
                          ].map((value) => ({
                            value,
                            label: translateEnum('cwdMode', value),
                          }))}
                        />
                      </Form.Item>
                      {cwdMode === 'CUSTOM_RELATIVE' && (
                        <Form.Item
                          name="cwd_relative_path"
                          label={tr('ui.relativeWorkingDirectory')}
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                      )}
                    </>
                  ),
                },
                {
                  key: 'runtime',
                  label: tr('ui.runtime'),
                  forceRender: true,
                  children: (
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <Alert
                        message={tr('ui.template.valueConfiguredResources', {
                          p0: kind,
                        })}
                        description={tr(
                          'ui.eachRunPinsTheEnvironmentSCurrentBuildTypeScriptRequiresTsx4XInThatBuild',
                        )}
                      />
                      {kind !== 'SHELL' && (
                        <Form.Item
                          name="environment_id"
                          label={tr('ui.template.valueEnvironment', {
                            p0: kind === 'PYTHON' ? 'Python' : 'Node',
                          })}
                        >
                          <Select
                            options={[
                              {
                                value: null,
                                label: tr(
                                  'ui.inheritSubscriptionRepositoryDefault',
                                ),
                              },
                              ...environments.map((env) => ({
                                value: env.id,
                                label: tr(
                                  'ui.template.valueValueCurrentBuildValue',
                                  {
                                    p0: env.name,
                                    p1: translateEnum(
                                      form.getFieldValue([
                                        'runtime',
                                        'kind',
                                      ]) === 'PYTHON'
                                        ? 'pythonEnvironment'
                                        : 'nodeEnvironment',
                                      env.state,
                                    ),
                                    p2:
                                      env.current_build_id ?? tr('common.none'),
                                  },
                                ),
                              })),
                            ]}
                          />
                        </Form.Item>
                      )}
                      <Typography.Text>
                        {tr('ui.selection')}{' '}
                        {translateEnum(
                          'selectionSource',
                          environmentId
                            ? 'TASK'
                            : preview?.runtime?.selected_by ?? 'UNBOUND',
                        )}
                      </Typography.Text>
                      <RuntimeDefaults
                        repositoryId={worktree?.repository_id}
                        subscriptionId={selected?.subscription_id}
                        kind={kind}
                        environments={environments}
                        onChange={inherited}
                      />
                    </Space>
                  ),
                },
                ...resourceTabs,
                {
                  key: 'triggers',
                  label: tr('ui.triggers'),
                  children: <TaskTriggers taskId={selected?.id} />,
                },
                {
                  key: 'settings',
                  label: tr('ui.executionSettings'),
                  forceRender: true,
                  children: (
                    <>
                      <Alert
                        message={tr(
                          'ui.retryAndConcurrencyApplyToEachRunConfigureDeliverySeparatelyInNotifications',
                        )}
                      />
                      <Form.Item
                        name="timeout_seconds"
                        label={tr('ui.timeoutSecondsEmptyPlatformDefault')}
                      >
                        <InputNumber min={1} max={86400} />
                      </Form.Item>
                      <Form.Item
                        name="max_attempts"
                        label={tr('ui.maximumAttempts')}
                      >
                        <InputNumber min={1} max={10} />
                      </Form.Item>
                      <Form.Item
                        name="initial_delay_seconds"
                        label={tr('ui.initialDelaySeconds')}
                      >
                        <InputNumber min={0} max={3600} />
                      </Form.Item>
                      {[
                        [
                          'backoff',
                          tr('ui.extra.backoff'),
                          ['FIXED', 'EXPONENTIAL'],
                        ],
                        [
                          'concurrency',
                          tr('ui.extra.concurrency'),
                          ['FORBID', 'QUEUE', 'ALLOW'],
                        ],
                      ].map(([name, label, values]) => (
                        <Form.Item
                          key={name as string}
                          name={name as string}
                          label={label as string}
                        >
                          <Select
                            options={(values as string[]).map((value) => ({
                              value,
                              label: translateEnum(String(name), value),
                            }))}
                          />
                        </Form.Item>
                      ))}
                    </>
                  ),
                },
                {
                  key: 'resources',
                  label: tr('ui.resourcePreview'),
                  children: preview ? (
                    <>
                      <Tag>
                        {translateEnum('readiness', preview.readiness.status)}
                      </Tag>
                      <pre style={{ whiteSpace: 'pre-wrap' }}>
                        {JSON.stringify(preview, null, 2)}
                      </pre>
                    </>
                  ) : (
                    <Alert message={tr('ui.saveTaskToPreviewResources')} />
                  ),
                },
              ]}
            />
          </Form>
        </Modal>
        <Modal
          open={runs !== undefined}
          title={tr('ui.taskRuns')}
          width={850}
          footer={null}
          onCancel={() => setRuns(undefined)}
        >
          <Button
            onClick={async () => setRuns(await get(`tasks/${runTask}/runs`))}
          >
            {tr('ui.refreshRuns')}
          </Button>
          <Table
            rowKey="id"
            dataSource={runs}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: tr('ui.run'), dataIndex: 'id' },
              {
                title: tr('ui.status'),
                dataIndex: 'status',
                render: (value: unknown) => translateEnum('taskRun', value),
              },
              { title: tr('ui.attempts'), dataIndex: 'attempt_count' },
              {
                title: tr('ui.result'),
                dataIndex: 'error_code',
                render: (value: unknown) =>
                  value ? translateError(value) : '—',
              },
              {
                title: tr('ui.actions'),
                render: (_: unknown, run: any) => (
                  <Space>
                    <Button onClick={async () => setDetailRun(run.id)}>
                      {tr('ui.runLog')}
                    </Button>
                    <Button
                      disabled={
                        !['QUEUED', 'RESOLVING', 'RUNNING'].includes(run.status)
                      }
                      onClick={async () => {
                        await request.post(api + `task-runs/${run.id}/cancel`);
                        setRuns(await get(`tasks/${runTask}/runs`));
                        await load();
                      }}
                    >
                      {tr('ui.cancelRun')}
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        </Modal>
        <RunDetail id={detailRun} onClose={() => setDetailRun(undefined)} />
        <Modal
          open={log !== undefined}
          title={tr('ui.runLog')}
          width={900}
          onCancel={() => setLog(undefined)}
          footer={null}
        >
          <pre style={{ whiteSpace: 'pre-wrap' }}>{log}</pre>
        </Modal>
      </Space>
    </div>
  );
}
