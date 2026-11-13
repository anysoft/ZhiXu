import React, { useState } from 'react';
import {
  Button,
  Checkbox,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Space,
  Table,
  Tabs,
  Typography,
} from 'antd';
import { call, list, useAction, useResource } from '../api';
import {
  Details,
  ErrorPanel,
  Fingerprint,
  FormDialog,
  Page,
  Reload,
  State,
  Time,
  required,
} from '../components';
import { useText } from '../i18n';
function AssetDetails({ asset }: { asset: any }) {
  const t = useText(),
    revisions = useResource(`/config-assets/${asset.id}/revisions`),
    usage = useResource(`/config-assets/${asset.id}/usage`);
  return (
    <>
      <ErrorPanel error={revisions.error || usage.error} />
      <Details
        values={[
          ['version', asset.version],
          ['secret', t(asset.is_secret ? 'yes' : 'no')],
          ['currentRevision', asset.current_revision_id],
          ['usage', asset.usage_count],
        ]}
      />
      <Tabs
        items={[
          {
            key: 'revisions',
            label: t('revisions'),
            children: (
              <Table
                rowKey="id"
                dataSource={list(revisions.data)}
                pagination={false}
                columns={[
                  { title: t('id'), dataIndex: 'id' },
                  { title: t('version'), dataIndex: 'revision_number' },
                  { title: t('size'), dataIndex: 'size' },
                  {
                    title: t('checksum'),
                    dataIndex: 'checksum',
                    render: (v) => <Fingerprint value={v} />,
                  },
                  {
                    title: t('createdAt'),
                    dataIndex: 'createdAt',
                    render: (v) => <Time value={v} />,
                  },
                ]}
              />
            ),
          },
          {
            key: 'usage',
            label: t('usage'),
            children: (
              <>
                <Table
                  rowKey="id"
                  dataSource={usage.data?.workspaces || []}
                  columns={[
                    { title: t('workspace'), dataIndex: 'workspace_id' },
                    { title: t('assetRevision'), dataIndex: 'revision_id' },
                  ]}
                />
                <Table
                  rowKey="id"
                  dataSource={usage.data?.tasks || []}
                  columns={[
                    { title: t('task'), dataIndex: 'task_id' },
                    { title: t('assetRevision'), dataIndex: 'revision_id' },
                  ]}
                />
                <Typography.Paragraph>
                  {t('historicalReferences')}:{' '}
                  {usage.data?.history_count ?? '—'}
                </Typography.Paragraph>
              </>
            ),
          },
        ]}
      />
    </>
  );
}
export default function ConfigPage() {
  const t = useText(),
    data = useResource('/config-assets'),
    action = useAction(),
    [editing, setEditing] = useState<any>(),
    [selected, setSelected] = useState<any>();
  const edit = async (row: any) =>
    setEditing({
      ...row,
      content: row.is_secret
        ? undefined
        : await call(`/config-assets/${row.id}/content`),
      replace_content: false,
    });
  return (
    <Page
      title={t('config')}
      subtitle={t('configImmutableHelp')}
      actions={
        <>
          <Reload onClick={() => void data.reload()} />
          <Button
            type="primary"
            onClick={() =>
              setEditing({
                name: '',
                description: '',
                is_secret: false,
                content: '',
                replace_content: true,
              })
            }
          >
            {t('newAsset')}
          </Button>
        </>
      }
    >
      <ErrorPanel error={data.error || action.error} />
      <Table
        rowKey="id"
        dataSource={list(data.data)}
        loading={data.loading}
        columns={[
          {
            title: t('name'),
            dataIndex: 'name',
            render: (v, r: any) => (
              <Button type="link" onClick={() => setSelected(r)}>
                {v}
              </Button>
            ),
          },
          { title: t('description'), dataIndex: 'description' },
          {
            title: t('secret'),
            dataIndex: 'is_secret',
            render: (v) => t(v ? 'yes' : 'no'),
          },
          { title: t('currentRevision'), dataIndex: 'current_revision_id' },
          { title: t('version'), dataIndex: 'version' },
          { title: t('usage'), dataIndex: 'usage_count' },
          {
            title: t('actions'),
            render: (_, r: any) => (
              <Space>
                <Button onClick={() => void action.run(() => edit(r))}>
                  {t('edit')}
                </Button>
                <Popconfirm
                  title={t('confirmDelete')}
                  onConfirm={() =>
                    action.run(async () => {
                      await call(
                        `/config-assets/${r.id}?version=${r.version}`,
                        { method: 'DELETE' },
                      );
                      await data.reload();
                    })
                  }
                >
                  <Button danger>{t('delete')}</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      {selected && (
        <Drawer
          open
          title={selected.name}
          width={800}
          onClose={() => setSelected(undefined)}
        >
          <AssetDetails asset={selected} />
        </Drawer>
      )}
      {editing && (
        <FormDialog
          title={t(editing.id ? 'edit' : 'newAsset')}
          initial={editing}
          width={760}
          onClose={() => setEditing(undefined)}
          onSubmit={async (v) => {
            await call(
              '/config-assets' + (editing.id ? '/' + editing.id : ''),
              {
                method: editing.id ? 'PUT' : 'POST',
                body: {
                  name: v.name,
                  description: v.description || '',
                  is_secret: !!v.is_secret,
                  content_type: 'TEXT',
                  ...(v.replace_content ? { content: v.content || '' } : {}),
                  ...(editing.id ? { expected_version: editing.version } : {}),
                },
              },
            );
            await data.reload();
          }}
        >
          <Form.Item name="name" label={t('name')} rules={[required()]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('description')}>
            <Input />
          </Form.Item>
          <Form.Item name="is_secret" valuePropName="checked">
            <Checkbox disabled={!!editing.is_secret}>{t('secret')}</Checkbox>
          </Form.Item>
          {editing.id && (
            <Form.Item name="replace_content" valuePropName="checked">
              <Checkbox>{t('createRevision')}</Checkbox>
            </Form.Item>
          )}
          <Form.Item noStyle shouldUpdate>
            {({ getFieldValue }) =>
              getFieldValue('replace_content') && (
                <Form.Item
                  name="content"
                  label={t('content')}
                  extra={editing.is_secret ? t('secretWriteOnly') : undefined}
                >
                  <Input.TextArea
                    rows={14}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Form.Item>
              )
            }
          </Form.Item>
        </FormDialog>
      )}
    </Page>
  );
}
