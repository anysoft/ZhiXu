import React, { useState } from 'react';
import { Link } from '@umijs/max';
import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import { call, list, useAction, useResource } from '../api';
import {
  ErrorPanel,
  FormDialog,
  Reload,
  State,
  enumOptions,
  lines,
  required,
} from '../components';
import { useText } from '../i18n';
export function Triggers({
  task,
  workspace,
  onChanged,
}: {
  task: any;
  workspace: any;
  onChanged: () => void;
}) {
  const t = useText(),
    path = `/tasks/${task.id}/triggers`,
    data = useResource(path),
    events = useResource(`/tasks/${task.id}/trigger-events`, 3000),
    action = useAction(),
    [editing, setEditing] = useState<any>(),
    [secret, setSecret] = useState<string>();
  const edit = (row?: any) =>
    setEditing(
      row
        ? {
            ...row,
            ...row.config,
            path_filters: (row.config?.path_filters || []).join('\n'),
          }
        : {
            type: 'CRON',
            enabled: true,
            expression: '0 * * * *',
            timezone: 'UTC',
            misfire_policy: 'SKIP',
            mode: 'ANY_CHANGE',
            fire_on_initial: false,
            path_filters: '',
          },
    );
  const editable = workspace?.lifecycle_state === 'READY';
  return (
    <>
      <div className="v2-toolbar">
        <Button disabled={!editable} onClick={() => edit()}>
          {t('create')}
        </Button>
        <Reload
          onClick={() => {
            void data.reload();
            void events.reload();
          }}
        />
      </div>
      <ErrorPanel error={data.error || events.error || action.error} />
      {secret && (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={() => setSecret(undefined)}
          message={t('webhookSecretOnce')}
          description={
            <Typography.Text code copyable>
              {secret}
            </Typography.Text>
          }
        />
      )}
      <Table
        rowKey="id"
        dataSource={list(data.data)}
        pagination={false}
        columns={[
          {
            title: t('type'),
            dataIndex: 'type',
            render: (value) => <State value={value} />,
          },
          {
            title: t('status'),
            dataIndex: 'enabled',
            render: (value) => <State value={value ? 'enabled' : 'disabled'} />,
          },
          {
            title: t('configuration'),
            render: (_, row: any) =>
              row.type === 'CRON' ? (
                `${row.config?.expression} · ${row.config?.timezone}`
              ) : row.type === 'GIT_UPDATE' ? (
                <Space>
                  <State value={row.config?.mode} />
                  {row.config?.fire_on_initial && t('initialFire')}
                </Space>
              ) : (
                row.config?.public_id || '—'
              ),
          },
          {
            title: t('actions'),
            render: (_, row: any) => (
              <Space>
                <Button disabled={!editable} onClick={() => edit(row)}>
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
      <Typography.Title level={5} className="v2-section">
        {t('triggerHistory')}
      </Typography.Title>
      <Table
        rowKey="id"
        dataSource={list(events.data)}
        pagination={false}
        columns={[
          { title: t('id'), dataIndex: 'id' },
          {
            title: t('type'),
            dataIndex: 'trigger_type',
            render: (value) => <State value={value} />,
          },
          {
            title: t('status'),
            dataIndex: 'status',
            render: (value) => <State value={value} />,
          },
          {
            title: t('run'),
            dataIndex: 'task_run_id',
            render: (value) =>
              value ? <Link to={`/runs/${value}`}>#{value}</Link> : '—',
          },
          { title: t('diagnostics'), dataIndex: 'error_code' },
        ]}
      />
      {editing && (
        <FormDialog
          title={t('triggers')}
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSubmit={async (values) => {
            const config =
              values.type === 'CRON'
                ? {
                    expression: values.expression,
                    timezone: values.timezone,
                    misfire_policy: values.misfire_policy,
                  }
                : values.type === 'WEBHOOK'
                ? {}
                : {
                    mode: values.mode,
                    path_filters: lines(values.path_filters),
                    fire_on_initial: !!values.fire_on_initial,
                  };
            const result = await call(
              path + (editing.id ? '/' + editing.id : ''),
              {
                method: editing.id ? 'PUT' : 'POST',
                body: {
                  type: values.type,
                  enabled: !!values.enabled,
                  config,
                  ...(editing.id ? { expected_version: editing.version } : {}),
                },
              },
            );
            if (result.secret) setSecret(result.secret);
            await data.reload();
            onChanged();
          }}
        >
          <Form.Item name="type" label={t('type')}>
            <Select
              disabled={!!editing.id}
              options={[
                { value: 'CRON', label: t('status.CRON') },
                { value: 'WEBHOOK', label: t('status.WEBHOOK') },
                {
                  value: 'GIT_UPDATE',
                  label: t('gitUpdateTrigger'),
                  disabled: workspace?.type !== 'GIT',
                },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate>
            {({ getFieldValue }) =>
              getFieldValue('type') === 'CRON' ? (
                <>
                  <Form.Item
                    name="expression"
                    label={t('cron')}
                    rules={[required()]}
                  >
                    <Input />
                  </Form.Item>
                  <Form.Item
                    name="timezone"
                    label={t('timezone')}
                    rules={[required()]}
                  >
                    <Input />
                  </Form.Item>
                  <Form.Item name="misfire_policy" label={t('misfire')}>
                    <Select options={enumOptions(['SKIP', 'FIRE_ONCE'])} />
                  </Form.Item>
                </>
              ) : getFieldValue('type') === 'GIT_UPDATE' ? (
                <>
                  <Form.Item name="mode" label={t('triggerMode')}>
                    <Select
                      options={enumOptions([
                        'ANY_CHANGE',
                        'SOURCE_CHANGE',
                        'PATH_FILTER',
                      ])}
                    />
                  </Form.Item>
                  {getFieldValue('mode') === 'PATH_FILTER' && (
                    <Form.Item
                      name="path_filters"
                      label={t('pathFilters')}
                      rules={[required()]}
                    >
                      <Input.TextArea />
                    </Form.Item>
                  )}
                  <Form.Item name="fire_on_initial" valuePropName="checked">
                    <Checkbox>{t('initialFire')}</Checkbox>
                  </Form.Item>
                </>
              ) : null
            }
          </Form.Item>
          <Form.Item name="enabled" valuePropName="checked">
            <Checkbox>{t('enabled')}</Checkbox>
          </Form.Item>
        </FormDialog>
      )}
    </>
  );
}
