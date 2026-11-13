import React from 'react';
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Tabs,
} from 'antd';
import { call, list, useResource } from '../api';
import { ErrorPanel, FormDialog, enumOptions, required } from '../components';
import { label, useText } from '../i18n';
import { EnvironmentPicker } from './Resources';
function EntrypointFields({ id, form }: { id: number; form: any }) {
  const t = useText(),
    entries = useResource(id ? `/workspaces/${id}/entries` : null),
    profiles = useResource(id ? `/scoped-env/workspaces/${id}/profiles` : null);
  return (
    <>
      <ErrorPanel error={entries.error} />
      <Form.Item
        name={['source', 'relative_entrypoint']}
        label={t('entrypoint')}
        rules={[required()]}
      >
        <AutoComplete
          options={list(entries.data)
            .filter((item: any) => item.kind === 'FILE')
            .map((item: any) => ({ value: item.path, label: item.path }))}
          onSelect={(value) => {
            const ext = String(value).split('.').pop(),
              language =
                ext === 'py'
                  ? 'PYTHON'
                  : ext === 'ts'
                  ? 'TYPESCRIPT'
                  : ['js', 'cjs', 'mjs'].includes(ext || '')
                  ? 'JAVASCRIPT'
                  : 'SHELL';
            form.setFieldsValue({
              source: { ...form.getFieldValue('source'), language },
              runtime_environment_id: null,
            });
          }}
        />
      </Form.Item>
      <Form.Item name="env_profile_id" label={t('profile')}>
        <Select
          allowClear
          placeholder={t('runtimeInheritance')}
          options={list(profiles.data).map((item: any) => ({
            value: item.id,
            label: item.name,
          }))}
        />
      </Form.Item>
    </>
  );
}
export function TaskEditor({
  task,
  workspaceId,
  entrypoint,
  onClose,
  onSaved,
}: {
  task?: any;
  workspaceId?: number;
  entrypoint?: string;
  onClose: () => void;
  onSaved: (value: any) => void;
}) {
  const t = useText(),
    workspaces = useResource('/workspaces?size=200');
  const initial = task
    ? {
        ...task,
        arguments: task.arguments || [],
        runtime_environment_id:
          task.runtime?.python_environment_id ||
          task.runtime?.node_environment_id ||
          null,
      }
    : {
        name: '',
        description: '',
        enabled: true,
        arguments: [],
        source: {
          type: 'WORKSPACE_ENTRYPOINT',
          workspace_id: workspaceId,
          relative_entrypoint: entrypoint,
          language: entrypoint?.endsWith('.py')
            ? 'PYTHON'
            : entrypoint?.endsWith('.ts')
            ? 'TYPESCRIPT'
            : entrypoint && /\.[cm]?js$/.test(entrypoint)
            ? 'JAVASCRIPT'
            : 'SHELL',
          cwd_mode: 'WORKSPACE_ROOT',
          cwd_relative_path: null,
        },
        runtime_environment_id: null,
        env_profile_id: null,
        execution: {
          timeout_seconds: 3600,
          max_attempts: 1,
          initial_delay_seconds: 0,
          backoff: 'FIXED',
          concurrency: 'QUEUE',
          notification: 'NONE',
        },
      };
  return (
    <FormDialog
      title={t(task ? 'edit' : 'newTask')}
      initial={initial}
      width={760}
      onClose={onClose}
      onSubmit={async (values, key) => {
        const language = values.source.language,
          kind =
            language === 'PYTHON'
              ? 'PYTHON'
              : language === 'SHELL'
              ? 'SHELL'
              : 'NODE';
        const body = {
          name: values.name,
          description: values.description || '',
          enabled: !!values.enabled,
          arguments: values.arguments || [],
          source: {
            ...values.source,
            type: 'WORKSPACE_ENTRYPOINT',
            cwd_relative_path:
              values.source.cwd_mode === 'CUSTOM_RELATIVE'
                ? values.source.cwd_relative_path
                : null,
          },
          runtime: {
            kind,
            python_environment_id:
              kind === 'PYTHON' ? values.runtime_environment_id || null : null,
            node_environment_id:
              kind === 'NODE' ? values.runtime_environment_id || null : null,
          },
          env_profile_id: values.env_profile_id || null,
          execution: {
            ...values.execution,
            timeout_seconds: values.execution.timeout_seconds || null,
          },
          ...(task ? { expected_version: task.version } : {}),
        };
        onSaved(
          await call('/tasks' + (task ? '/' + task.id : ''), {
            method: task ? 'PUT' : 'POST',
            body,
            key,
          }),
        );
      }}
    >
      <ErrorPanel error={workspaces.error} />
      <Tabs
        items={[
          {
            key: 'source',
            label: t('source'),
            forceRender: true,
            children: (
              <>
                <Form.Item name="name" label={t('name')} rules={[required()]}>
                  <Input maxLength={255} />
                </Form.Item>
                <Form.Item name="description" label={t('description')}>
                  <Input.TextArea rows={2} />
                </Form.Item>
                <Form.Item
                  name={['source', 'workspace_id']}
                  label={t('workspace')}
                  rules={[required()]}
                >
                  <Select
                    options={list(workspaces.data)
                      .filter((item: any) => item.lifecycle_state === 'READY')
                      .map((item: any) => ({
                        value: item.id,
                        label: `${item.name} · ${label(item.type)}`,
                      }))}
                    onChange={() => {}}
                  />
                </Form.Item>
                <Form.Item
                  noStyle
                  shouldUpdate={(a, b) =>
                    a.source?.workspace_id !== b.source?.workspace_id
                  }
                >
                  {(form) => (
                    <EntrypointFields
                      key={form.getFieldValue(['source', 'workspace_id'])}
                      id={form.getFieldValue(['source', 'workspace_id'])}
                      form={form}
                    />
                  )}
                </Form.Item>
                <Form.Item
                  name={['source', 'language']}
                  label={t('language')}
                  rules={[required()]}
                >
                  <Select
                    options={enumOptions([
                      'PYTHON',
                      'JAVASCRIPT',
                      'TYPESCRIPT',
                      'SHELL',
                    ])}
                  />
                </Form.Item>
                <Form.Item name={['source', 'cwd_mode']} label={t('cwd')}>
                  <Select
                    options={enumOptions([
                      'WORKSPACE_ROOT',
                      'ENTRYPOINT_DIR',
                      'CUSTOM_RELATIVE',
                    ])}
                  />
                </Form.Item>
                <Form.Item
                  noStyle
                  shouldUpdate={(a, b) =>
                    a.source?.cwd_mode !== b.source?.cwd_mode
                  }
                >
                  {({ getFieldValue }) =>
                    getFieldValue(['source', 'cwd_mode']) ===
                      'CUSTOM_RELATIVE' && (
                      <Form.Item
                        name={['source', 'cwd_relative_path']}
                        label={t('customCwd')}
                        rules={[required()]}
                      >
                        <Input />
                      </Form.Item>
                    )
                  }
                </Form.Item>
              </>
            ),
          },
          {
            key: 'runtime',
            label: t('runtime'),
            forceRender: true,
            children: (
              <>
                <Alert type="info" message={t('managedOnly')} />
                <Form.Item
                  noStyle
                  shouldUpdate={(a, b) =>
                    a.source?.language !== b.source?.language
                  }
                >
                  {({ getFieldValue }) =>
                    getFieldValue(['source', 'language']) !== 'SHELL' && (
                      <Form.Item
                        name="runtime_environment_id"
                        label={t('runtimeOverride')}
                      >
                        <EnvironmentPicker
                          kind={
                            getFieldValue(['source', 'language']) === 'PYTHON'
                              ? 'PYTHON'
                              : 'NODE'
                          }
                          placeholder={t('runtimeInheritance')}
                        />
                      </Form.Item>
                    )
                  }
                </Form.Item>
                <Form.Item
                  label={t('arguments')}
                  extra={t('argumentsExactHelp')}
                >
                  <Form.List name="arguments">
                    {(fields, { add, remove }) => (
                      <>
                        {fields.map((field) => (
                          <Space
                            key={field.key}
                            align="start"
                            className="v2-argument-row"
                          >
                            <Form.Item {...field} noStyle>
                              <Input.TextArea
                                aria-label={t('argumentNumber', {
                                  number: field.name + 1,
                                })}
                                rows={2}
                                spellCheck={false}
                              />
                            </Form.Item>
                            <Button onClick={() => remove(field.name)}>
                              {t('delete')}
                            </Button>
                          </Space>
                        ))}
                        <Button onClick={() => add('')}>
                          {t('addArgument')}
                        </Button>
                      </>
                    )}
                  </Form.List>
                </Form.Item>
              </>
            ),
          },
          {
            key: 'execution',
            label: t('taskPolicy'),
            forceRender: true,
            children: (
              <>
                <Form.Item
                  name={['execution', 'timeout_seconds']}
                  label={t('timeout')}
                >
                  <InputNumber min={1} max={86400} />
                </Form.Item>
                <Form.Item
                  name={['execution', 'max_attempts']}
                  label={t('maxAttempts')}
                  rules={[required()]}
                >
                  <InputNumber min={1} max={10} />
                </Form.Item>
                <Form.Item
                  name={['execution', 'initial_delay_seconds']}
                  label={t('retryDelay')}
                >
                  <InputNumber min={0} />
                </Form.Item>
                <Form.Item name={['execution', 'backoff']} label={t('backoff')}>
                  <Select options={enumOptions(['FIXED', 'EXPONENTIAL'])} />
                </Form.Item>
                <Form.Item
                  name={['execution', 'concurrency']}
                  label={t('concurrency')}
                >
                  <Select options={enumOptions(['FORBID', 'QUEUE', 'ALLOW'])} />
                </Form.Item>
                <Form.Item
                  name={['execution', 'notification']}
                  label={t('notificationPolicy')}
                >
                  <Select
                    options={enumOptions([
                      'NONE',
                      'FAILURE',
                      'SUCCESS',
                      'ALWAYS',
                    ])}
                  />
                </Form.Item>
                <Form.Item name="enabled" valuePropName="checked">
                  <Checkbox>{t('enabled')}</Checkbox>
                </Form.Item>
              </>
            ),
          },
        ]}
      />
    </FormDialog>
  );
}
