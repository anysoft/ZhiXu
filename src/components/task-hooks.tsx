import { formatDuration } from '@/utils/format';
import { translateEnum } from '@/utils/i18n';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
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
  message,
} from 'antd';
import config from '@/utils/config';
import { request } from '@/utils/http';
const phases = ['BEFORE', 'AFTER_SUCCESS', 'AFTER_FAILURE', 'FINALLY'];
export function TaskHooks({ id }: { id: number }) {
  useI18nLocale();
  const [rows, setRows] = useState<any[]>([]),
    [editing, setEditing] = useState<any>();
  const [form] = Form.useForm();
  const endpoint = `${config.apiPrefix}tasks/${id}/hooks`;
  const load = async () => {
    const r = await request.get(endpoint);
    if (r.code === 200) setRows(r.data);
  };
  useEffect(() => {
    load().catch(() => {});
  }, [id]);
  const open = (phase: string, row: any = {}) => {
    setEditing(row);
    form.resetFields();
    form.setFieldsValue({
      phase,
      name: '',
      command: '',
      cwd_base: 'TASK_CWD',
      position:
        10 +
        Math.max(
          0,
          ...rows.filter((x) => x.phase === phase).map((x) => x.position),
        ),
      timeout_seconds: 60,
      failure_policy: phase === 'AFTER_FAILURE' ? 'CONTINUE' : 'FAIL_EXECUTION',
      enabled: true,
      ...row,
    });
  };
  const save = async () => {
    try {
      const values = await form.validateFields();
      const r = await request[editing.id ? 'put' : 'post'](
        editing.id ? `${endpoint}/${editing.id}` : endpoint,
        { ...values, expected_version: editing.version },
      );
      if (r.code === 200) {
        setEditing(undefined);
        await load();
        message.success(tr('ui.hookSaved'));
      }
    } catch {}
  };
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Alert
        type="info"
        message={tr(
          'ui.passSecretsThroughEnvironmentVariablesOrConfigAssetsBEFOREHooksCanUsePLATFORMHOOKOUTPUTToReturnEnvir',
        )}
      />
      <Tabs
        items={phases.map((phase) => ({
          key: phase,
          label: translateEnum('hook', phase),
          children: (
            <>
              <Button onClick={() => open(phase)}>
                {tr('ui.hookAdd', { phase: translateEnum('hook', phase) })}
              </Button>
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={rows
                  .filter((x) => x.phase === phase)
                  .sort((a, b) => a.position - b.position)}
                columns={[
                  { title: tr('ui.name'), dataIndex: 'name' },
                  { title: tr('ui.order'), dataIndex: 'position' },
                  {
                    title: tr('ui.timeoutS'),
                    dataIndex: 'timeout_seconds',
                    render: (v: number) => formatDuration(v),
                  },
                  {
                    title: tr('ui.failurePolicy'),
                    dataIndex: 'failure_policy',
                    render: (v: unknown) => translateEnum('failurePolicy', v),
                  },
                  {
                    title: tr('ui.enabled'),
                    render: (_, row) =>
                      row.enabled ? tr('ui.extra.yes') : tr('ui.extra.no'),
                  },
                  {
                    title: tr('ui.action'),
                    render: (_, row) => (
                      <Space>
                        <Button size="small" onClick={() => open(phase, row)}>
                          {tr('ui.edit')}
                        </Button>
                        <Popconfirm
                          title={tr('ui.deleteThisHook')}
                          onConfirm={async () => {
                            await request.delete(
                              `${endpoint}/${row.id}?version=${row.version}`,
                            );
                            await load();
                          }}
                        >
                          <Button size="small" danger>
                            {tr('ui.delete')}
                          </Button>
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]}
              />
            </>
          ),
        }))}
      />
      <Modal
        title={tr('ui.taskHook')}
        open={!!editing}
        onCancel={() => setEditing(undefined)}
        onOk={save}
        destroyOnClose
      >
        <Form
          name={`task-hook-${id}`}
          form={form}
          layout="vertical"
          preserve={false}
        >
          <Form.Item
            name="name"
            label={tr('ui.hookName')}
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="phase" label={tr('ui.phase')}>
            <Select
              options={phases.map((value) => ({
                value,
                label: translateEnum('hook', value),
              }))}
            />
          </Form.Item>
          <Form.Item
            name="command"
            label={tr('ui.command')}
            rules={[{ required: true }]}
          >
            <Input.TextArea rows={5} autoComplete="off" />
          </Form.Item>
          <Form.Item name="cwd_base" label={tr('ui.workingDirectory')}>
            <Select
              options={['TASK_CWD', 'WORKSPACE_ROOT'].map((value) => ({
                value,
                label: translateEnum('hookBase', value),
              }))}
            />
          </Form.Item>
          <Form.Item
            name="position"
            label={tr('ui.order')}
            rules={[{ required: true }]}
          >
            <InputNumber min={0} />
          </Form.Item>
          <Form.Item
            name="timeout_seconds"
            label={tr('ui.timeoutSecondsVariant368')}
            rules={[{ required: true }]}
          >
            <InputNumber min={1} max={3600} />
          </Form.Item>
          <Form.Item name="failure_policy" label={tr('ui.failurePolicy')}>
            <Select
              options={['FAIL_EXECUTION', 'CONTINUE'].map((value) => ({
                value,
                label: translateEnum('failurePolicy', value),
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
        </Form>
      </Modal>
    </Space>
  );
}
