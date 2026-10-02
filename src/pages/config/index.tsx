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
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from 'antd';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import config from '@/utils/config';

export default function ConfigAssetsPage() {
  useI18nLocale();
  const [rows, setRows] = useState<any[]>([]),
    [editing, setEditing] = useState<any>(),
    [replace, setReplace] = useState(false),
    [detail, setDetail] = useState<any>();
  const [form] = Form.useForm();
  const load = async () => {
    const result = await request.get(`${config.apiPrefix}config-assets`);
    if (result.code === 200) setRows(result.data);
  };
  useEffect(() => {
    load().catch(() => {});
  }, []);
  const open = async (row: any = {}) => {
    form.resetFields();
    setReplace(!row.id || !row.is_secret);
    const values: any = { name: '', description: '', is_secret: false, ...row };
    if (row.id && !row.is_secret) {
      const result = await request.get(
        `${config.apiPrefix}config-assets/${row.id}/content`,
      );
      if (result.code !== 200) return;
      values.content = result.data;
    }
    form.setFieldsValue(values);
    setEditing(row);
  };
  const save = async () => {
    try {
      const values = await form.validateFields();
      const payload = {
        ...values,
        content_type: 'TEXT',
        expected_version: editing.version,
      };
      if (!replace) delete payload.content;
      const result = await request[editing.id ? 'put' : 'post'](
        `${config.apiPrefix}config-assets${editing.id ? `/${editing.id}` : ''}`,
        payload,
      );
      if (result.code === 200) {
        setEditing(undefined);
        form.resetFields();
        await load();
        message.success(
          replace
            ? tr('ui.extra.newRevisionSaved')
            : tr('ui.extra.metadataSaved'),
        );
      }
    } catch {}
  };
  return (
    <PageContainer
      title={tr('ui.configAssets')}
      extra={
        <Button type="primary" onClick={() => open()}>
          {tr('ui.createConfigAsset')}
        </Button>
      }
    >
      <Alert
        type="info"
        showIcon
        message={tr(
          'ui.configAssetsAreIndependentOfGitEachContentChangeCreatesAnImmutableRevisionSecretContentCanOnlyBeRepl',
        )}
        style={{ marginBottom: 16 }}
      />
      <Table
        rowKey="id"
        dataSource={rows}
        columns={[
          { title: tr('ui.name'), dataIndex: 'name' },
          { title: tr('ui.type'), dataIndex: 'content_type' },
          {
            title: tr('ui.secret'),
            render: (_, row) =>
              row.is_secret ? (
                <Tag>{tr('ui.secretSet')}</Tag>
              ) : (
                tr('ui.extra.no')
              ),
          },
          {
            title: tr('ui.currentRevision'),
            render: (_, row) => row.current_revision?.revision_number,
          },
          {
            title: tr('ui.size'),
            render: (_, row) => formatBytes(row.current_revision?.size ?? 0),
          },
          { title: tr('ui.usageCount'), dataIndex: 'usage_count' },
          {
            title: tr('ui.updatedAt'),
            dataIndex: 'updatedAt',
            render: (value: any) => formatDateTime(value),
          },
          {
            title: tr('ui.action'),
            render: (_, row) => (
              <Space>
                <Button onClick={() => open(row)}>{tr('ui.edit')}</Button>
                <Button
                  onClick={async () => {
                    const [revisions, usage] = await Promise.all([
                      request.get(
                        `${config.apiPrefix}config-assets/${row.id}/revisions`,
                      ),
                      request.get(
                        `${config.apiPrefix}config-assets/${row.id}/usage`,
                      ),
                    ]);
                    if (revisions.code === 200 && usage.code === 200)
                      setDetail({
                        asset: row,
                        revisions: revisions.data,
                        usage: usage.data,
                      });
                  }}
                >
                  {tr('ui.details')}
                </Button>
                <Popconfirm
                  title={tr(
                    'ui.deleteThisAssetExistingBindingsPreventDeletion',
                  )}
                  onConfirm={async () => {
                    const r = await request.delete(
                      `${config.apiPrefix}config-assets/${row.id}?version=${row.version}`,
                    );
                    if (r.code === 200) await load();
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
          editing?.id
            ? tr('ui.extra.editConfigAsset')
            : tr('ui.createConfigAsset')
        }
        open={!!editing}
        onCancel={() => {
          setEditing(undefined);
          form.resetFields();
        }}
        onOk={save}
        width={720}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label={tr('ui.name')}
            rules={[{ required: true, max: 255 }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="description" label={tr('ui.description')}>
            <Input.TextArea maxLength={4096} />
          </Form.Item>
          <Form.Item
            name="is_secret"
            label={tr('ui.secret')}
            valuePropName="checked"
          >
            <Switch disabled={editing?.is_secret} />
          </Form.Item>
          {editing?.id && editing.is_secret && (
            <Space direction="vertical">
              <Alert message={tr('ui.secretContentSetKeepExisting')} />
              <Button onClick={() => setReplace(!replace)}>
                {replace ? tr('ui.extra.keepExisting') : tr('ui.extra.replace')}
              </Button>
            </Space>
          )}
          {replace && (
            <Form.Item
              name="content"
              label={tr('ui.contentUTF8TEXT1MiB')}
              rules={[
                {
                  validator: (_, value) =>
                    typeof value === 'string'
                      ? Promise.resolve()
                      : Promise.reject(
                          new Error(
                            tr('ui.extra.enterContentEmptyStringAllowed'),
                          ),
                        ),
                },
              ]}
              initialValue=""
            >
              <Input.TextArea rows={12} spellCheck={false} />
            </Form.Item>
          )}
        </Form>
      </Modal>
      <Modal
        title={detail?.asset.name}
        open={!!detail}
        onCancel={() => setDetail(undefined)}
        footer={null}
        width={850}
      >
        <h3>{tr('ui.immutableRevisions')}</h3>
        <Table
          rowKey="id"
          size="small"
          dataSource={detail?.revisions}
          columns={[
            { title: tr('ui.revision'), dataIndex: 'revision_number' },
            { title: tr('ui.size'), dataIndex: 'size' },
            { title: 'SHA-256', dataIndex: 'checksum' },
            {
              title: tr('ui.created'),
              dataIndex: 'createdAt',
              render: (value: any) => formatDateTime(value),
            },
          ]}
        />
        <h3>{tr('ui.repositoryBindings')}</h3>
        <Table
          rowKey="id"
          size="small"
          dataSource={detail?.usage.repositories}
          columns={[
            { title: tr('ui.repository'), dataIndex: 'repository_id' },
            { title: tr('ui.targetBase'), dataIndex: 'target_base' },
            { title: tr('ui.targetPath'), dataIndex: 'target_path' },
          ]}
        />
        <h3>{tr('ui.taskBindings')}</h3>
        <Table
          rowKey="id"
          size="small"
          dataSource={detail?.usage.tasks}
          columns={[
            { title: tr('ui.task'), dataIndex: 'task_id' },
            { title: tr('ui.targetBase'), dataIndex: 'target_base' },
            { title: tr('ui.targetPath'), dataIndex: 'target_path' },
          ]}
        />
      </Modal>
    </PageContainer>
  );
}
