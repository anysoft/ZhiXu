import { translateEnum } from '@/utils/i18n';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Form,
  Input,
  Select,
  Space,
  Switch,
  Table,
  message,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
export default function DiscoveryPolicy({
  subscriptionId,
}: {
  subscriptionId: number;
}) {
  useI18nLocale();
  const [policy, setPolicy] = useState<any>(),
    [preview, setPreview] = useState<any>();
  const [form] = Form.useForm();
  const api = `${config.apiPrefix}subscriptions/${subscriptionId}/discovery`;
  const load = async () => {
    const result = await request.get(api);
    if (result.code === 200) {
      setPolicy(result.data);
      form.setFieldsValue({
        ...result.data,
        includes: result.data.includes.join('\n'),
        excludes: result.data.excludes.join('\n'),
      });
    }
  };
  useEffect(() => {
    void load();
  }, [subscriptionId]);
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Alert
        message={tr('ui.discoveryPolicy')}
        description={tr(
          'ui.previewReadsTheSavedPolicyApplyDiscoversTaskSourcesAndTheirCronMetadataUserOverridesArePreserved',
        )}
      />
      <Form form={form} layout="vertical">
        <Form.Item
          name="enabled"
          label={tr('ui.discoveryEnabled')}
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Form.Item name="includes" label={tr('ui.includeGlobsOnePerLine')}>
          <Input.TextArea />
        </Form.Item>
        <Form.Item name="excludes" label={tr('ui.excludeGlobsOnePerLine')}>
          <Input.TextArea />
        </Form.Item>
        <Form.Item name="languages" label={tr('ui.languages')}>
          <Select
            mode="multiple"
            options={['PYTHON', 'JAVASCRIPT', 'TYPESCRIPT', 'SHELL'].map(
              (value) => ({ value, label: translateEnum('language', value) }),
            )}
          />
        </Form.Item>
      </Form>
      <Space wrap>
        <Button
          onClick={async () => {
            const value = await form.validateFields();
            const result = await request.put(api, {
              ...value,
              includes: value.includes
                .split('\n')
                .map((x: string) => x.trim())
                .filter(Boolean),
              excludes: value.excludes
                .split('\n')
                .map((x: string) => x.trim())
                .filter(Boolean),
              expected_version: policy.version,
            });
            if (result.code === 200) {
              message.success(tr('ui.discoveryPolicySaved'));
              await load();
            }
          }}
        >
          {tr('ui.saveDiscoveryPolicy')}
        </Button>
        <Button
          onClick={async () => {
            const result = await request.post(api + '/preview', {});
            if (result.code === 200) setPreview(result.data);
          }}
        >
          {tr('ui.previewDiscovery')}
        </Button>
        <Button
          onClick={async () => {
            const result = await request.post(api + '/apply', {});
            if (result.code === 200) {
              message.success(tr('ui.discoveryApplied'));
              await load();
              setPreview(undefined);
            }
          }}
        >
          {tr('ui.applyDiscoveryVariant16')}
        </Button>
      </Space>
      {policy?.last_reconciled_at && (
        <Alert
          message={tr('ui.template.lastReconcileValue', {
            p0: policy.last_reconciled_at,
          })}
          description={JSON.stringify(policy.last_result)}
        />
      )}
      {preview && (
        <Table
          size="small"
          rowKey={(row: any) => row.file?.key ?? row.task_id}
          dataSource={preview.changes}
          columns={[
            { title: tr('ui.action'), dataIndex: 'action' },
            {
              title: tr('ui.source'),
              render: (_: unknown, row: any) =>
                row.file?.relative_path ??
                tr('ui.presentation.taskId', { id: row.task_id }),
            },
          ]}
          pagination={{ pageSize: 10 }}
        />
      )}
    </Space>
  );
}
