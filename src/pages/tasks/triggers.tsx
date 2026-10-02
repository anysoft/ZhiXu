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
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

export default function TaskTriggers({ taskId }: { taskId?: number }) {
  useI18nLocale();
  const [rows, setRows] = useState<any[]>([]),
    [events, setEvents] = useState<any[]>([]),
    [editing, setEditing] = useState<any>(),
    [secret, setSecret] = useState<string>();
  const [form] = Form.useForm(),
    type = Form.useWatch('type', form);
  const api = `${config.apiPrefix}tasks/${taskId}`;
  const load = async () => {
    const [triggers, recent] = await Promise.all([
      request.get(api + '/triggers'),
      request.get(api + '/trigger-events'),
    ]);
    if (triggers.code === 200) setRows(triggers.data);
    if (recent.code === 200) setEvents(recent.data);
  };
  useEffect(() => {
    setSecret(undefined);
    if (taskId) void load();
  }, [taskId]);
  if (!taskId)
    return <Alert message={tr('ui.saveThisTaskBeforeAddingTriggers')} />;
  const edit = (row?: any) => {
    const value = row ?? {
      type: 'CRON',
      enabled: true,
      config: { misfire_policy: 'SKIP' },
    };
    setEditing(value);
    form.setFieldsValue({
      ...value,
      ...value.config,
      path_filters: value.config?.path_filters?.join('\n') ?? '',
    });
  };
  const save = async () => {
    const value = await form.validateFields();
    const payload = {
      type: value.type,
      enabled: value.enabled,
      expected_version: editing?.version,
      config:
        value.type === 'CRON'
          ? {
              expression: value.expression,
              timezone: value.timezone,
              misfire_policy: value.misfire_policy,
            }
          : value.type === 'WEBHOOK'
          ? {}
          : {
              mode: value.mode,
              path_filters: (value.path_filters ?? '')
                .split('\n')
                .map((x: string) => x.trim())
                .filter(Boolean),
              fire_on_initial: !!value.fire_on_initial,
            },
    };
    const result = await request[editing?.id ? 'put' : 'post'](
      api + '/triggers' + (editing?.id ? '/' + editing.id : ''),
      payload,
    );
    if (result.code === 200) {
      setEditing(undefined);
      setSecret(result.data.secret);
      await load();
    } else message.error(translateError(result.error_code ?? result.message));
  };
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Alert
        message={tr(
          'ui.triggersSubmitRunsUsingThisTaskSSavedResourcesAndExecutionSettings',
        )}
      />
      <Space>
        <Button onClick={() => edit()}>{tr('ui.addTrigger')}</Button>
        <Button onClick={() => void load()}>{tr('ui.refreshTriggers')}</Button>
      </Space>
      {secret && (
        <Alert
          type="warning"
          closable
          onClose={() => setSecret(undefined)}
          message={tr('ui.copyThisWebhookSecretNowItIsShownOnlyOnce')}
          description={
            <Typography.Text copyable code>
              {secret}
            </Typography.Text>
          }
        />
      )}
      <Table
        size="small"
        rowKey="id"
        dataSource={rows}
        pagination={false}
        columns={[
          { title: tr('ui.type'), dataIndex: 'type' },
          {
            title: tr('ui.origin'),
            render: (_: unknown, row: any) => (
              <Tag>{translateEnum('triggerOrigin', row.origin)}</Tag>
            ),
          },
          {
            title: tr('ui.enabled'),
            render: (_: unknown, row: any) =>
              row.enabled ? tr('common.yes') : tr('common.no'),
          },
          {
            title: tr('ui.configuration'),
            render: (_: unknown, row: any) =>
              row.type === 'CRON' ? (
                <>
                  {row.config.expression} · {row.config.timezone} ·{' '}
                  {translateEnum('misfire', row.config.misfire_policy)}
                  <br />
                  {tr('ui.next')}{' '}
                  {row.enabled
                    ? formatDateTime(row.config.next_fire_at)
                    : tr('ui.extra.disabled')}
                  <br />
                  {tr('ui.last')} {formatDateTime(row.config.last_fire_at)}
                </>
              ) : row.type === 'WEBHOOK' ? (
                <Typography.Text copyable>
                  {window.location.origin +
                    config.baseUrl.replace(/\/$/, '') +
                    '/hooks/' +
                    row.config.public_id}
                </Typography.Text>
              ) : (
                <>
                  {translateEnum('gitUpdate', row.config.mode)} ·{' '}
                  {(row.config.path_filters ?? []).join(', ')}{' '}
                  {tr('ui.initial')}{' '}
                  {row.config.fire_on_initial
                    ? tr('ui.extra.yes')
                    : tr('ui.extra.no')}
                </>
              ),
          },
          {
            title: tr('ui.actions'),
            render: (_: unknown, row: any) => (
              <Space wrap>
                <Button onClick={() => edit(row)}>{tr('ui.edit')}</Button>
                {row.type === 'WEBHOOK' && (
                  <Button
                    onClick={async () => {
                      const result = await request.post(
                        api + `/triggers/${row.id}/rotate-secret`,
                        { expected_version: row.version },
                      );
                      if (result.code === 200) {
                        setSecret(result.data.secret);
                        await load();
                      }
                    }}
                  >
                    {tr('ui.rotateSecret')}
                  </Button>
                )}
                <Button
                  danger
                  onClick={async () => {
                    const result = await request.delete(
                      api + `/triggers/${row.id}`,
                      { data: { expected_version: row.version } },
                    );
                    if (result.code === 200) await load();
                  }}
                >
                  {tr('ui.remove')}
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <Typography.Title level={5}>
        {tr('ui.recentTriggerEvents')}
      </Typography.Title>
      <Table
        size="small"
        rowKey="id"
        dataSource={events}
        pagination={false}
        columns={[
          { title: tr('ui.event'), dataIndex: 'id' },
          {
            title: tr('ui.type'),
            dataIndex: 'trigger_type',
            render: (value: unknown) => translateEnum('triggerType', value),
          },
          {
            title: tr('ui.status'),
            dataIndex: 'status',
            render: (value: unknown) => translateEnum('triggerEvent', value),
          },
          {
            title: tr('ui.diagnostic'),
            dataIndex: 'error_code',
            render: (value: unknown) => (value ? translateError(value) : '—'),
          },
          {
            title: tr('ui.run'),
            render: (_: unknown, row: any) =>
              row.task_run_id ? (
                <Button
                  type="link"
                  href={`${config.baseUrl}runs?run=${row.task_run_id}`}
                >
                  #{row.task_run_id}
                </Button>
              ) : (
                '—'
              ),
          },
        ]}
      />
      <Modal
        open={!!editing}
        title={editing?.id ? tr('ui.extra.editTrigger') : tr('ui.addTrigger')}
        onCancel={() => setEditing(undefined)}
        onOk={() => void save()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="type"
            label={tr('ui.triggerType')}
            rules={[{ required: true }]}
          >
            <Select
              disabled={!!editing?.id}
              options={['CRON', 'WEBHOOK', 'GIT_UPDATE'].map((value) => ({
                value,
                label: translateEnum('triggerType', value),
              }))}
            />
          </Form.Item>
          <Form.Item
            name="enabled"
            label={tr('ui.enabled')}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          {type === 'CRON' && (
            <>
              <Form.Item
                name="expression"
                label={tr('ui.cronExpression')}
                rules={[{ required: true }]}
              >
                <Input placeholder="0 8 * * *" />
              </Form.Item>
              <Form.Item name="timezone" label={tr('ui.timezone')}>
                <Input placeholder={tr('ui.platformConfiguredTimezone')} />
              </Form.Item>
              <Form.Item
                name="misfire_policy"
                label={tr('ui.missedSchedules')}
                initialValue="SKIP"
              >
                <Select
                  options={[
                    { value: 'SKIP', label: tr('ui.skipMissedSchedules') },
                    {
                      value: 'FIRE_ONCE',
                      label: tr('ui.runOnceAfterAMissedSchedule'),
                    },
                  ]}
                />
              </Form.Item>
            </>
          )}
          {type === 'WEBHOOK' && (
            <Alert
              message={tr(
                'ui.postJSONOrAnEmptyBodyToTheEndpointWithAuthorizationBearerSecretTheBodyDoesNotChangeTaskExecution',
              )}
            />
          )}
          {type === 'GIT_UPDATE' && (
            <>
              <Form.Item
                name="mode"
                label={tr('ui.changeMode')}
                initialValue="ANY_CHANGE"
              >
                <Select
                  options={['ANY_CHANGE', 'SOURCE_CHANGE', 'PATH_FILTER'].map(
                    (value) => ({
                      value,
                      label: translateEnum('gitUpdate', value),
                    }),
                  )}
                />
              </Form.Item>
              <Form.Item
                name="path_filters"
                label={tr('ui.relativePathGlobsOnePerLine')}
              >
                <Input.TextArea placeholder="src/**/*.py" />
              </Form.Item>
              <Form.Item
                name="fire_on_initial"
                label={tr('ui.runOnInitialSync')}
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </Space>
  );
}
