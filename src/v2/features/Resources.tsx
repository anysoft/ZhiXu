import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
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
  Typography,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { ApiError, call, getEtag, list, useAction, useResource } from '../api';
import {
  ErrorPanel,
  FormDialog,
  Reload,
  State,
  enumOptions,
  lines,
  required,
} from '../components';
import { useText, label } from '../i18n';

export function EnvironmentPicker({
  kind,
  ...props
}: {
  kind: string;
  value?: number | null;
  onChange?: (value: number | null) => void;
  placeholder?: string;
}) {
  const data = useResource(
    `/runtime/${kind === 'NODE' ? 'node' : 'python'}/environments`,
  );
  return (
    <Select
      {...props}
      allowClear
      loading={data.loading}
      onClear={() => props.onChange?.(null)}
      options={list(data.data).map((item: any) => ({
        value: item.id,
        label: `${item.name} · ${label(item.state)}`,
      }))}
    />
  );
}
export function RuntimeDefaults({
  workspace,
  onChanged,
}: {
  workspace: any;
  onChanged: () => void;
}) {
  const t = useText(),
    data = useResource(`/workspaces/${workspace.id}/runtime-defaults`),
    [editing, setEditing] = useState<any>();
  return (
    <>
      <Alert type="info" showIcon message={t('managedOnly')} />
      <ErrorPanel error={data.error} />
      <div className="v2-toolbar v2-section">
        <Button
          disabled={!workspace.capabilities.write_files}
          onClick={() => setEditing({ kind: 'PYTHON', environment_id: null })}
        >
          {t('edit')}
        </Button>
        <Reload onClick={() => void data.reload()} />
      </div>
      <Table
        rowKey="kind"
        dataSource={list(data.data)}
        pagination={false}
        columns={[
          {
            title: t('type'),
            dataIndex: 'kind',
            render: (value) => <State value={value} />,
          },
          { title: t('environment'), dataIndex: 'environment_id' },
          { title: t('version'), dataIndex: 'version' },
          {
            title: t('actions'),
            render: (_, row: any) => (
              <Button
                disabled={!workspace.capabilities.write_files}
                onClick={() => setEditing(row)}
              >
                {t('edit')}
              </Button>
            ),
          },
        ]}
      />
      {editing && (
        <FormDialog
          title={t('runtime')}
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSubmit={async (values) => {
            await call(`/workspaces/${workspace.id}/runtime-defaults`, {
              method: 'PUT',
              body: {
                kind: values.kind,
                environment_id: values.environment_id || null,
                expected_version: workspace.version,
              },
            });
            await data.reload();
            onChanged();
          }}
        >
          <Form.Item name="kind" label={t('type')} rules={[required()]}>
            <Select options={enumOptions(['PYTHON', 'NODE'])} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.kind !== b.kind}>
            {({ getFieldValue }) => (
              <Form.Item name="environment_id" label={t('environment')}>
                <EnvironmentPicker kind={getFieldValue('kind')} />
              </Form.Item>
            )}
          </Form.Item>
        </FormDialog>
      )}
    </>
  );
}

export function VariablesEditor({
  path,
  version,
  onChanged,
  global = false,
  editable = true,
}: {
  path: string;
  version?: number;
  onChanged: () => void;
  global?: boolean;
  editable?: boolean;
}) {
  const t = useText(),
    data = useResource(path),
    action = useAction(),
    [rows, setRows] = useState<any[]>([]),
    [dirty, setDirty] = useState(false),
    [baselineEtag, setBaselineEtag] = useState<string>();
  useEffect(() => {
    setRows(
      list(data.data).map((row: any) => ({
        ...row,
        value: row.is_secret ? '' : row.value || '',
        secret_action: row.is_secret ? 'KEEP' : 'REPLACE',
      })),
    );
    setDirty(false);
    setBaselineEtag(data.etag);
  }, [data.data, data.etag]);
  const change = (index: number, key: string, value: any) => {
    setDirty(true);
    setRows((old) =>
      old.map((row, number) =>
        number === index
          ? {
              ...row,
              [key]: value,
              ...(key === 'is_secret'
                ? { secret_action: value ? 'REPLACE' : undefined }
                : {}),
            }
          : row,
      ),
    );
  };
  const save = () =>
    action.run(async () => {
      const variables = rows.map((row) => {
        if (global && row.secret_action === 'CLEAR')
          return { name: row.name, clear: true };
        const output: any = {
          name: row.name,
          operation: row.operation || 'SET',
          status: row.status || 'enabled',
          is_secret: row.operation === 'UNSET' ? false : !!row.is_secret,
        };
        if (output.operation === 'SET') {
          if (output.is_secret && row.secret_action === 'KEEP') {
            if (!row.has_value)
              throw new ApiError(400, 'ENV_SECRET_ACTION_INVALID');
          } else if (output.is_secret && row.secret_action === 'CLEAR')
            output.clear = true;
          else {
            output.value = row.value || '';
            if (output.is_secret) output.replace_secret = true;
          }
        }
        return output;
      });
      if (global)
        for (const previous of list(data.data)) {
          if (!rows.some((row) => row.name === previous.name))
            variables.push({ name: previous.name, clear: true });
        }
      await call(path, {
        method: 'PUT',
        body: global ? variables : { expected_version: version, variables },
        ifMatch: global ? baselineEtag : undefined,
      });
      await data.reload();
      onChanged();
    });
  return (
    <>
      <div className="v2-toolbar">
        <Space>
          <Button
            disabled={!editable}
            icon={<PlusOutlined />}
            onClick={() => {
              setRows((old) => [
                ...old,
                {
                  name: '',
                  value: '',
                  operation: 'SET',
                  status: 'enabled',
                  is_secret: false,
                },
              ]);
              setDirty(true);
            }}
          >
            {t('create')}
          </Button>
          <Button
            type="primary"
            disabled={!editable || !dirty}
            loading={action.busy}
            onClick={() => void save()}
          >
            {t('save')}
          </Button>
        </Space>
        <Reload
          onClick={() => {
            if (!dirty) void data.reload();
            else
              Modal.confirm({
                title: t('discardTitle'),
                content: t('discardHelp'),
                okText: t('confirm'),
                cancelText: t('cancel'),
                onOk: () => void data.reload(),
              });
          }}
        />
      </div>
      <ErrorPanel error={data.error || action.error} />
      {rows.map((row, index) => (
        <div className="v2-variables" key={index}>
          <Input
            aria-label={t('name')}
            value={row.name}
            disabled={!editable}
            onChange={(event) => change(index, 'name', event.target.value)}
          />
          <Select
            aria-label={t('operation')}
            value={row.operation || 'SET'}
            disabled={!editable}
            options={enumOptions(['SET', 'UNSET'])}
            onChange={(value) => change(index, 'operation', value)}
          />
          {row.is_secret ? (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Select
                aria-label={t('secret')}
                value={row.secret_action}
                disabled={!editable}
                onChange={(value) => change(index, 'secret_action', value)}
                options={[
                  { value: 'KEEP', label: t('keepSecret') },
                  { value: 'REPLACE', label: t('replaceSecret') },
                  {
                    value: 'CLEAR',
                    label: t(global ? 'delete' : 'clearSecret'),
                  },
                ]}
              />
              {row.secret_action === 'REPLACE' && (
                <Input.Password
                  aria-label={t('value')}
                  autoComplete="new-password"
                  value={row.value}
                  disabled={!editable || row.operation === 'UNSET'}
                  onChange={(event) =>
                    change(index, 'value', event.target.value)
                  }
                />
              )}
            </Space>
          ) : (
            <Input
              aria-label={t('value')}
              value={row.value}
              disabled={!editable || row.operation === 'UNSET'}
              onChange={(event) => change(index, 'value', event.target.value)}
            />
          )}
          <Checkbox
            disabled={!editable || row.operation === 'UNSET'}
            checked={row.is_secret}
            onChange={(event) =>
              change(index, 'is_secret', event.target.checked)
            }
          >
            {t('secret')}
          </Checkbox>
          <Space>
            <Switch
              size="small"
              disabled={!editable}
              checked={row.status !== 'disabled'}
              onChange={(value) =>
                change(index, 'status', value ? 'enabled' : 'disabled')
              }
            />
            <Button
              aria-label={t('delete')}
              icon={<DeleteOutlined />}
              disabled={!editable}
              danger
              onClick={() => {
                setRows((old) => old.filter((_, number) => number !== index));
                setDirty(true);
              }}
            />
          </Space>
        </div>
      ))}
      {!rows.length && (
        <Typography.Text type="secondary">{t('empty')}</Typography.Text>
      )}
    </>
  );
}
function ProfileVariables({
  id,
  editable,
  onChanged,
}: {
  id: number;
  editable: boolean;
  onChanged: () => void;
}) {
  const profile = useResource(`/scoped-env/profiles/${id}`),
    action = useAction(),
    [editing, setEditing] = useState(false);
  const t = useText();
  return (
    <>
      <ErrorPanel error={profile.error || action.error} />
      <Space className="v2-section">
        <Button
          disabled={!editable || !profile.data}
          onClick={() => setEditing(true)}
        >
          {t('edit')}
        </Button>
        <Popconfirm
          title={t('confirmDelete')}
          onConfirm={() =>
            action.run(async () => {
              await call(`/scoped-env/profiles/${id}`, {
                method: 'DELETE',
                body: { expected_version: profile.data.version },
              });
              onChanged();
            })
          }
        >
          <Button danger disabled={!editable || !profile.data}>
            {t('delete')}
          </Button>
        </Popconfirm>
      </Space>
      {profile.data && (
        <VariablesEditor
          path={`/scoped-env/profiles/${id}/variables`}
          version={profile.data.version}
          editable={editable}
          onChanged={() => {
            void profile.reload();
            onChanged();
          }}
        />
      )}
      {editing && (
        <FormDialog
          title={t('profile')}
          initial={profile.data}
          onClose={() => setEditing(false)}
          onSubmit={async (v) => {
            await call('/scoped-env/profiles', {
              method: 'PUT',
              body: {
                id,
                workspace_id: profile.data.workspace_id,
                name: v.name,
                description: v.description || '',
                status: v.status,
                expected_version: profile.data.version,
              },
            });
            await profile.reload();
            onChanged();
          }}
        >
          <Form.Item name="name" label={t('name')} rules={[required()]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('description')}>
            <Input />
          </Form.Item>
          <Form.Item name="status" label={t('status')}>
            <Select options={enumOptions(['enabled', 'disabled'])} />
          </Form.Item>
        </FormDialog>
      )}
    </>
  );
}
export function EnvironmentPanel({
  scope,
  id,
  editable = true,
  onChanged,
}: {
  scope: 'workspaces' | 'tasks';
  id: number;
  editable?: boolean;
  onChanged: () => void;
}) {
  const t = useText(),
    context = useResource(`/scoped-env/${scope}/${id}/context`),
    [profile, setProfile] = useState<number>(),
    [dialog, setDialog] = useState<string>(),
    action = useAction();
  const preview = useResource(
      scope === 'tasks' ? `/scoped-env/tasks/${id}/preview` : null,
    ),
    selected = list(context.data?.profiles);
  return (
    <>
      <ErrorPanel error={context.error || action.error} />
      <Card title={t(scope === 'workspaces' ? 'defaultProfile' : 'profile')}>
        <Space wrap>
          <Select
            value={context.data?.selected_profile_id || undefined}
            allowClear
            placeholder={t('noProfile')}
            disabled={!editable}
            style={{ minWidth: 240 }}
            options={selected.map((item: any) => ({
              value: item.id,
              label: item.name,
            }))}
            onChange={(value) =>
              void action.run(async () => {
                await call(`/scoped-env/${scope}/${id}/profile`, {
                  method: 'PUT',
                  body: {
                    env_profile_id: value || null,
                    expected_version: context.data.owner_version,
                  },
                });
                await context.reload();
                await preview.reload();
                onChanged();
              })
            }
          />
          <Button
            disabled={!editable || !context.data}
            onClick={() => setDialog('create')}
          >
            {t('create')}
          </Button>
        </Space>
      </Card>
      <Tabs
        className="v2-section"
        items={[
          {
            key: 'profiles',
            label: t('profiles'),
            children: (
              <>
                <Select
                  value={profile}
                  allowClear
                  placeholder={t('profile')}
                  style={{ minWidth: 240, marginBottom: 16 }}
                  options={selected.map((item: any) => ({
                    value: item.id,
                    label: item.name,
                  }))}
                  onChange={setProfile}
                />
                {profile && (
                  <ProfileVariables
                    key={profile}
                    id={profile}
                    editable={editable}
                    onChanged={() => {
                      void context.reload();
                      void preview.reload();
                      onChanged();
                    }}
                  />
                )}
              </>
            ),
          },
          ...(scope === 'tasks'
            ? [
                {
                  key: 'task',
                  label: t('taskOverrides'),
                  children: context.data ? (
                    <VariablesEditor
                      path={`/scoped-env/tasks/${id}/variables`}
                      version={context.data.owner_version}
                      editable={editable}
                      onChanged={() => {
                        void context.reload();
                        void preview.reload();
                        onChanged();
                      }}
                    />
                  ) : null,
                },
                {
                  key: 'preview',
                  label: t('effectivePreview'),
                  children: (
                    <>
                      <ErrorPanel error={preview.error} />
                      <Table
                        rowKey="name"
                        dataSource={preview.data?.variables || []}
                        pagination={false}
                        columns={[
                          { title: t('name'), dataIndex: 'name' },
                          {
                            title: t('operation'),
                            dataIndex: 'operation',
                            render: (value: any) => <State value={value} />,
                          },
                          { title: t('source'), dataIndex: 'source' },
                          {
                            title: t('value'),
                            render: (_: any, row: any) =>
                              row.is_secret
                                ? t('secretMasked')
                                : row.value || '—',
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
      {dialog && (
        <FormDialog
          title={t('profile')}
          initial={{ status: 'enabled', description: '' }}
          onClose={() => setDialog(undefined)}
          onSubmit={async (values) => {
            const result = await call('/scoped-env/profiles', {
              method: 'POST',
              body: { workspace_id: context.data.workspace_id, ...values },
            });
            await context.reload();
            setProfile(result.id);
            onChanged();
          }}
        >
          <Form.Item name="name" label={t('name')} rules={[required()]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="description" label={t('description')}>
            <Input.TextArea />
          </Form.Item>
          <Form.Item name="status" label={t('status')}>
            <Select options={enumOptions(['enabled', 'disabled'])} />
          </Form.Item>
        </FormDialog>
      )}
    </>
  );
}

export function ConfigBindings({
  scope,
  id,
  editable = true,
  onChanged,
}: {
  scope: 'workspaces' | 'tasks';
  id: number;
  editable?: boolean;
  onChanged: () => void;
}) {
  const t = useText(),
    path = `/${scope}/${id}/config-bindings`,
    data = useResource(path),
    assets = useResource('/config-assets'),
    [editing, setEditing] = useState<any>(),
    action = useAction(),
    [showPreview, setShowPreview] = useState(false),
    preview = useResource(
      showPreview && scope === 'tasks' ? `/tasks/${id}/config-preview` : null,
    );
  return (
    <>
      <div className="v2-toolbar">
        <Space>
          <Button
            disabled={!editable}
            onClick={() =>
              setEditing({
                operation: 'ATTACH',
                target_base: 'WORKSPACE_ROOT',
                materialization_mode: 'COPY',
                conflict_policy: 'REPLACE_RESTORE',
                writable: false,
                enabled: true,
              })
            }
          >
            {t('create')}
          </Button>
          {scope === 'tasks' && (
            <Button onClick={() => setShowPreview((value) => !value)}>
              {t('preview')}
            </Button>
          )}
        </Space>
        <Reload onClick={() => void data.reload()} />
      </div>
      <ErrorPanel error={data.error || action.error || preview.error} />
      <Table
        rowKey="id"
        pagination={false}
        dataSource={list(data.data)}
        columns={[
          {
            title: t('operation'),
            dataIndex: 'operation',
            render: (value) => <State value={value} />,
          },
          {
            title: t('asset'),
            dataIndex: 'asset_id',
            render: (value) =>
              list(assets.data).find((item: any) => item.id === value)?.name ||
              value ||
              '—',
          },
          {
            title: t('targetBase'),
            dataIndex: 'target_base',
            render: (value) => <State value={value} />,
          },
          { title: t('targetPath'), dataIndex: 'target_path' },
          {
            title: t('actions'),
            render: (_, row: any) => (
              <Space>
                <Button disabled={!editable} onClick={() => setEditing(row)}>
                  {t('edit')}
                </Button>
                <Popconfirm
                  title={t('confirmDelete')}
                  onConfirm={() =>
                    action.run(async () => {
                      await call(path + '/' + row.id, {
                        method: 'DELETE',
                        body: { expected_version: row.version },
                      });
                      await data.reload();
                      onChanged();
                    })
                  }
                >
                  <Button danger disabled={!editable}>
                    {t('delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      {showPreview && preview.data && (
        <Table
          className="v2-section"
          rowKey="binding_id"
          pagination={false}
          dataSource={preview.data.effective || []}
          columns={[
            { title: t('source'), dataIndex: 'source' },
            { title: t('asset'), dataIndex: 'asset_id' },
            { title: t('revision'), dataIndex: 'revision_id' },
            { title: t('targetPath'), dataIndex: 'target_path' },
            {
              title: t('secret'),
              dataIndex: 'is_secret',
              render: (value) => (value ? t('secretMasked') : '—'),
            },
          ]}
        />
      )}
      {editing && (
        <FormDialog
          title={t('configBindings')}
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSubmit={async (values) => {
            const body = {
              ...values,
              asset_id: values.operation === 'MASK' ? null : values.asset_id,
              revision_id:
                values.operation === 'MASK' ? null : values.revision_id || null,
              ...(editing.id ? { expected_version: editing.version } : {}),
            };
            await call(path + (editing.id ? '/' + editing.id : ''), {
              method: editing.id ? 'PUT' : 'POST',
              body,
            });
            await data.reload();
            onChanged();
          }}
        >
          <Form.Item name="operation" label={t('operation')}>
            <Select
              options={enumOptions(
                scope === 'tasks' ? ['ATTACH', 'MASK'] : ['ATTACH'],
              )}
            />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(a, b) => a.operation !== b.operation}
          >
            {({ getFieldValue }) =>
              getFieldValue('operation') === 'ATTACH' && (
                <>
                  <Form.Item
                    name="asset_id"
                    label={t('asset')}
                    rules={[required()]}
                  >
                    <Select
                      options={list(assets.data).map((item: any) => ({
                        value: item.id,
                        label: item.name,
                      }))}
                    />
                  </Form.Item>
                  <Form.Item name="revision_id" label={t('revision')}>
                    <InputNumber min={1} placeholder={t('currentRevision')} />
                  </Form.Item>
                </>
              )
            }
          </Form.Item>
          <Form.Item name="target_base" label={t('targetBase')}>
            <Select options={enumOptions(['WORKSPACE_ROOT', 'TASK_DIR'])} />
          </Form.Item>
          <Form.Item
            name="target_path"
            label={t('targetPath')}
            rules={[required()]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="materialization_mode" label={t('materialization')}>
            <Select options={enumOptions(['COPY', 'SYMLINK'])} />
          </Form.Item>
          <Form.Item name="conflict_policy" label={t('conflictPolicy')}>
            <Select
              options={enumOptions(['FAIL_IF_EXISTS', 'REPLACE_RESTORE'])}
            />
          </Form.Item>
          <Form.Item name="writable" valuePropName="checked">
            <Checkbox>{t('writable')}</Checkbox>
          </Form.Item>
          <Form.Item name="enabled" valuePropName="checked">
            <Checkbox>{t('enabled')}</Checkbox>
          </Form.Item>
        </FormDialog>
      )}
    </>
  );
}

export function Hooks({
  task,
  onChanged,
  editable = true,
}: {
  task: any;
  onChanged: () => void;
  editable?: boolean;
}) {
  const t = useText(),
    path = `/tasks/${task.id}/hooks`,
    data = useResource(path),
    action = useAction(),
    [editing, setEditing] = useState<any>();
  return (
    <>
      <div className="v2-toolbar">
        <Button
          disabled={!editable}
          onClick={() =>
            setEditing({
              phase: 'BEFORE',
              cwd_base: 'TASK_CWD',
              position: 0,
              timeout_seconds: 30,
              failure_policy: 'FAIL_EXECUTION',
              enabled: true,
            })
          }
        >
          {t('create')}
        </Button>
        <Reload onClick={() => void data.reload()} />
      </div>
      <ErrorPanel error={data.error || action.error} />
      <Table
        rowKey="id"
        pagination={false}
        dataSource={list(data.data)}
        columns={[
          { title: t('name'), dataIndex: 'name' },
          {
            title: t('phase'),
            dataIndex: 'phase',
            render: (value) => <State value={value} />,
          },
          { title: t('position'), dataIndex: 'position' },
          {
            title: t('status'),
            dataIndex: 'enabled',
            render: (value) => <State value={value ? 'enabled' : 'disabled'} />,
          },
          {
            title: t('actions'),
            render: (_, row: any) => (
              <Space>
                <Button disabled={!editable} onClick={() => setEditing(row)}>
                  {t('edit')}
                </Button>
                <Popconfirm
                  title={t('confirmDelete')}
                  onConfirm={() =>
                    action.run(async () => {
                      await call(path + '/' + row.id, {
                        method: 'DELETE',
                        body: { expected_version: row.version },
                      });
                      await data.reload();
                      onChanged();
                    })
                  }
                >
                  <Button danger disabled={!editable}>
                    {t('delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      {editing && (
        <FormDialog
          title={t('hooks')}
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSubmit={async (values) => {
            await call(path + (editing.id ? '/' + editing.id : ''), {
              method: editing.id ? 'PUT' : 'POST',
              body: {
                ...values,
                ...(editing.id ? { expected_version: editing.version } : {}),
              },
            });
            await data.reload();
            onChanged();
          }}
        >
          <Form.Item name="name" label={t('name')} rules={[required()]}>
            <Input />
          </Form.Item>
          <Form.Item name="phase" label={t('phase')}>
            <Select
              options={enumOptions([
                'BEFORE',
                'AFTER_SUCCESS',
                'AFTER_FAILURE',
                'FINALLY',
              ])}
            />
          </Form.Item>
          <Form.Item name="command" label={t('command')} rules={[required()]}>
            <Input.TextArea rows={5} spellCheck={false} />
          </Form.Item>
          <Form.Item name="cwd_base" label={t('cwd')}>
            <Select options={enumOptions(['TASK_CWD', 'WORKSPACE_ROOT'])} />
          </Form.Item>
          <Form.Item name="position" label={t('position')}>
            <InputNumber min={0} />
          </Form.Item>
          <Form.Item name="timeout_seconds" label={t('timeout')}>
            <InputNumber min={1} max={3600} />
          </Form.Item>
          <Form.Item name="failure_policy" label={t('failurePolicy')}>
            <Select options={enumOptions(['FAIL_EXECUTION', 'CONTINUE'])} />
          </Form.Item>
          <Form.Item name="enabled" valuePropName="checked">
            <Checkbox>{t('enabled')}</Checkbox>
          </Form.Item>
        </FormDialog>
      )}
    </>
  );
}
