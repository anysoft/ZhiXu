import { translateEnum } from '@/utils/i18n';
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
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
const api = config.apiPrefix;
export function ConfigBindings({
  scope,
  id,
}: {
  scope: 'repository' | 'task';
  id: number;
}) {
  useI18nLocale();
  const [rows, setRows] = useState<any[]>([]),
    [assets, setAssets] = useState<any[]>([]),
    [inherited, setInherited] = useState<any[]>([]),
    [preview, setPreview] = useState<any[]>(),
    [editing, setEditing] = useState<any>();
  const [form] = Form.useForm();
  const operation = Form.useWatch('operation', form);
  const endpoint = `${api}${
    scope === 'repository' ? 'repositories' : 'tasks'
  }/${id}/config-bindings`;
  const load = async () => {
    const [bindings, library] = await Promise.all([
      request.get(endpoint),
      request.get(`${api}config-assets`),
    ]);
    if (bindings.code === 200) setRows(bindings.data);
    if (library.code === 200) setAssets(library.data);
    if (scope === 'task') {
      const context = await request.get(`${api}tasks/${id}/config-context`);
      if (context.code === 200) setInherited(context.data.inherited);
    }
  };
  useEffect(() => {
    load().catch(() => {});
    setPreview(undefined);
  }, [scope, id]);
  const open = (row: any = {}) => {
    setEditing(row);
    form.resetFields();
    form.setFieldsValue({
      operation: 'ATTACH',
      target_base: 'TASK_DIR',
      materialization_mode: 'COPY',
      conflict_policy: 'FAIL_IF_EXISTS',
      writable: false,
      enabled: true,
      ...row,
    });
  };
  const save = async () => {
    try {
      const values = await form.validateFields();
      const payload = {
        ...values,
        asset_id: values.operation === 'MASK' ? null : values.asset_id,
        expected_version: editing.version,
      };
      const r = await request[editing.id ? 'put' : 'post'](
        editing.id ? `${endpoint}/${editing.id}` : endpoint,
        payload,
      );
      if (r.code === 200) {
        setEditing(undefined);
        await load();
        setPreview(undefined);
        message.success(tr('ui.configBindingSaved'));
      }
    } catch {}
  };
  const columns: any[] = [
    {
      title: tr('ui.target'),
      render: (_: any, row: any) =>
        `${translateEnum('bindingBase', row.target_base)}/${row.target_path}`,
    },
    {
      title: tr('ui.action'),
      dataIndex: 'operation',
      render: (v: unknown) => translateEnum('bindingOperation', v),
    },
    {
      title: tr('ui.asset'),
      render: (_: any, row: any) =>
        assets.find((x) => x.id === row.asset_id)?.name ?? '—',
    },
    {
      title: tr('ui.mode'),
      dataIndex: 'materialization_mode',
      render: (v: unknown) => translateEnum('materialization', v),
    },
    {
      title: tr('ui.conflictPolicy'),
      dataIndex: 'conflict_policy',
      render: (v: unknown) => translateEnum('conflictPolicy', v),
    },
    {
      title: tr('ui.writable'),
      render: (_: any, row: any) =>
        row.writable ? tr('ui.extra.yes') : tr('ui.presentation.Readonly'),
    },
    {
      title: tr('ui.enabled'),
      render: (_: any, row: any) =>
        row.enabled ? tr('ui.extra.yes') : tr('ui.extra.no'),
    },
  ];
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {scope === 'task' && inherited.length > 0 && (
        <>
          <strong>{tr('ui.inheritedRepositoryBindings')}</strong>
          <Table
            rowKey="id"
            size="small"
            dataSource={inherited}
            columns={columns}
            pagination={false}
          />
        </>
      )}
      <strong>
        {scope === 'task'
          ? tr('ui.extra.taskOverridesAndMasks')
          : tr('ui.extra.repositoryConfigBindings')}
      </strong>
      <Button onClick={() => open()}>{tr('ui.addConfigBinding')}</Button>
      <Table
        rowKey="id"
        size="small"
        dataSource={rows}
        columns={[
          ...columns,
          {
            title: tr('ui.action'),
            render: (_: any, row: any) => (
              <Space>
                <Button size="small" onClick={() => open(row)}>
                  {tr('ui.edit')}
                </Button>
                <Popconfirm
                  title={tr('ui.deleteThisBinding')}
                  onConfirm={async () => {
                    await request.delete(
                      `${endpoint}/${row.id}?version=${row.version}`,
                    );
                    await load();
                    setPreview(undefined);
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
        pagination={false}
      />
      {scope === 'task' && (
        <Button
          onClick={async () => {
            const r = await request.get(`${api}tasks/${id}/config-preview`);
            if (r.code === 200) setPreview(r.data);
          }}
        >
          {tr('ui.previewEffectiveConfig')}
        </Button>
      )}
      {preview && (
        <>
          <Alert
            type="info"
            message={tr(
              'ui.effectiveConfigurationRevisionsArePinnedWhenExecutionStarts',
            )}
          />
          <Table
            rowKey={(row) =>
              `${translateEnum('bindingBase', row.binding.target_base)}:${
                row.binding.target_path
              }`
            }
            size="small"
            dataSource={preview}
            pagination={false}
            columns={[
              {
                title: tr('ui.target'),
                render: (_, row) =>
                  `${translateEnum('bindingBase', row.binding.target_base)}/${
                    row.binding.target_path
                  }`,
              },
              { title: tr('ui.asset'), dataIndex: 'asset_name' },
              {
                title: tr('ui.revision'),
                render: (_, row) => row.revision.revision_number,
              },
              { title: tr('ui.source'), dataIndex: 'source' },
              {
                title: tr('ui.mode'),
                render: (_, row) =>
                  translateEnum(
                    'materialization',
                    row.binding.materialization_mode,
                  ),
              },
              {
                title: tr('ui.conflictPolicy'),
                render: (_, row) =>
                  translateEnum('conflictPolicy', row.binding.conflict_policy),
              },
              {
                title: tr('ui.secret'),
                render: (_, row) =>
                  row.is_secret ? (
                    <Tag>{tr('ui.secret')}</Tag>
                  ) : (
                    tr('ui.extra.no')
                  ),
              },
            ]}
          />
        </>
      )}
      <Modal
        title={tr('ui.configBinding')}
        open={!!editing}
        onCancel={() => setEditing(undefined)}
        onOk={save}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="operation" label={tr('ui.bindingOperation')}>
            <Select
              options={(scope === 'task' ? ['ATTACH', 'MASK'] : ['ATTACH']).map(
                (value) => ({
                  value,
                  label: translateEnum('bindingOperation', value),
                }),
              )}
            />
          </Form.Item>
          <Form.Item
            name="asset_id"
            label={tr('ui.configAsset')}
            rules={operation === 'MASK' ? [] : [{ required: true }]}
          >
            <Select
              disabled={operation === 'MASK'}
              options={assets.map((asset) => ({
                value: asset.id,
                label: `${asset.name}${
                  asset.is_secret ? tr('common.secretSuffix') : ''
                }`,
              }))}
            />
          </Form.Item>
          <Form.Item name="target_base" label={tr('ui.targetBase')}>
            <Select
              options={['WORKSPACE_ROOT', 'TASK_DIR'].map((value) => ({
                value,
                label: translateEnum('bindingBase', value),
              }))}
            />
          </Form.Item>
          <Form.Item
            name="target_path"
            label={tr('ui.targetPath')}
            rules={[{ required: true }]}
          >
            <Input placeholder="config.yaml" />
          </Form.Item>
          <Form.Item
            name="materialization_mode"
            label={tr('ui.materializationMode')}
          >
            <Select
              options={['COPY', 'SYMLINK'].map((value) => ({
                value,
                label: translateEnum('materialization', value),
              }))}
            />
          </Form.Item>
          <Form.Item name="conflict_policy" label={tr('ui.conflictPolicy')}>
            <Select
              options={['FAIL_IF_EXISTS', 'REPLACE_RESTORE'].map((value) => ({
                value,
                label: translateEnum('conflictPolicy', value),
              }))}
            />
          </Form.Item>
          <Form.Item
            name="writable"
            label={tr('ui.writableExecutionCopyOnly')}
            valuePropName="checked"
          >
            <Switch />
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
