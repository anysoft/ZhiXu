import React, { useState } from 'react';
import { Link, history } from '@umijs/max';
import {
  Alert,
  Button,
  Form,
  Input,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import {
  call,
  list,
  query,
  useResource,
  WorkspaceDto,
  Page as PageDto,
} from '../api';
import {
  Details,
  ErrorPanel,
  FormDialog,
  Page,
  Reload,
  State,
  enumOptions,
  required,
} from '../components';
import { useText } from '../i18n';

function GitFields() {
  const t = useText(),
    repositories = useResource('/repositories');
  return (
    <>
      <ErrorPanel error={repositories.error} />
      <Form.Item
        name={['git', 'repository_id']}
        label={t('repository')}
        rules={[required()]}
      >
        <Select
          loading={repositories.loading}
          options={list(repositories.data).map((item: any) => ({
            value: item.id,
            label: item.name,
          }))}
        />
      </Form.Item>
      <Form.Item
        name={['git', 'ref_type']}
        label={t('refType')}
        rules={[required()]}
      >
        <Select options={enumOptions(['branch', 'tag', 'commit'])} />
      </Form.Item>
      <Form.Item
        name={['git', 'ref_name']}
        label={t('refName')}
        rules={[required()]}
      >
        <Input maxLength={255} />
      </Form.Item>
      <Alert type="info" showIcon message={t('gitHelp')} />
    </>
  );
}
export default function WorkspacesPage() {
  const t = useText(),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(''),
    [type, setType] = useState<string>();
  const data = useResource<PageDto<WorkspaceDto>>(
    query('/workspaces', { page, size: 20, search, type }),
    3000,
  );
  const [dialog, setDialog] = useState<{
      action: string;
      row?: WorkspaceDto;
    }>(),
    [lastOperation, setLastOperation] = useState<any>();
  const references = useResource(
    dialog?.action === 'delete'
      ? `/workspaces/${dialog.row!.id}/references`
      : null,
  );
  const perform = async (values: any, key: string) => {
    let result: any;
    if (dialog?.action === 'create') {
      const body =
        values.type === 'LOCAL'
          ? { type: 'LOCAL', name: values.name }
          : { type: 'GIT', name: values.name, git: values.git };
      result = await call('/workspaces', { method: 'POST', body, key });
      history.push(
        `/workspaces/${
          result.workspace.id
        }?tab=files&operation=${encodeURIComponent(result.operation.id)}`,
      );
    } else {
      const row = dialog!.row!,
        action = dialog!.action;
      result = await call(
        `/workspaces/${row.id}${
          action === 'rename' || action === 'delete' ? '' : '/' + action
        }`,
        {
          method:
            action === 'rename'
              ? 'PATCH'
              : action === 'delete'
              ? 'DELETE'
              : 'POST',
          key,
          body: {
            expected_version: row.version,
            ...(action === 'rename'
              ? { name: values.name }
              : action === 'delete'
              ? {
                  confirm_reclaim: true,
                  preservation_backup_id: values.preservation_backup_id || null,
                }
              : {}),
          },
        },
      );
      if (result?.operation) setLastOperation(result);
    }
    await data.reload();
  };
  return (
    <Page
      title={t('workspaces')}
      actions={
        <>
          <Reload onClick={() => void data.reload()} loading={data.loading} />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setDialog({ action: 'create' })}
          >
            {t('newWorkspace')}
          </Button>
        </>
      }
    >
      <div className="v2-toolbar">
        <Input.Search
          placeholder={t('search')}
          allowClear
          onSearch={(value) => {
            setSearch(value);
            setPage(1);
          }}
          style={{ maxWidth: 340 }}
        />
        <Select
          allowClear
          placeholder={t('type')}
          options={enumOptions(['LOCAL', 'GIT'])}
          value={type}
          onChange={(value) => {
            setType(value);
            setPage(1);
          }}
          style={{ width: 140 }}
        />
      </div>
      <ErrorPanel error={data.error} reload={() => void data.reload()} />
      {lastOperation && (
        <Alert
          closable
          type="info"
          showIcon
          className="v2-error"
          message={
            <Space>
              {t('operationId')}
              <Typography.Text code copyable>
                {lastOperation.operation.id}
              </Typography.Text>
              <State value={lastOperation.operation.status} />
              <Link
                to={`/workspaces/${lastOperation.workspace.id}?operation=${lastOperation.operation.id}`}
              >
                {t('details')}
              </Link>
            </Space>
          }
        />
      )}
      <Table
        rowKey="id"
        loading={data.loading && !data.data}
        dataSource={data.data?.items || []}
        pagination={{
          current: page,
          pageSize: 20,
          total: data.data?.total || 0,
          onChange: setPage,
        }}
        columns={[
          {
            title: t('name'),
            key: 'name',
            render: (_, row) => (
              <Link to={`/workspaces/${row.id}`}>{row.name}</Link>
            ),
          },
          {
            title: t('type'),
            dataIndex: 'type',
            render: (value) => <State value={value} />,
          },
          {
            title: t('status'),
            key: 'state',
            render: (_, row) => (
              <Space wrap>
                <State value={row.lifecycle_state} />
                <State value={row.storage_state} />
              </Space>
            ),
          },
          {
            title: t('repository'),
            key: 'git',
            render: (_, row) =>
              row.git ? `${row.git.repository_id} · ${row.git.ref_name}` : '—',
          },
          { title: t('contentRevision'), dataIndex: 'content_revision' },
          { title: t('tasks'), dataIndex: 'task_count' },
          {
            title: t('actions'),
            key: 'actions',
            render: (_, row) => (
              <Space wrap>
                <Button
                  size="small"
                  onClick={() => setDialog({ action: 'rename', row })}
                >
                  {t('rename')}
                </Button>
                {row.lifecycle_state === 'READY' && (
                  <Button
                    size="small"
                    onClick={() => setDialog({ action: 'archive', row })}
                  >
                    {t('archive')}
                  </Button>
                )}
                {row.lifecycle_state === 'ARCHIVED' && (
                  <>
                    <Button
                      size="small"
                      onClick={() => setDialog({ action: 'unarchive', row })}
                    >
                      {t('unarchive')}
                    </Button>
                    <Button
                      size="small"
                      danger
                      onClick={() => setDialog({ action: 'delete', row })}
                    >
                      {t('delete')}
                    </Button>
                  </>
                )}
                {['RECOVERY_REQUIRED', 'ERROR'].includes(
                  row.lifecycle_state,
                ) && (
                  <Button
                    size="small"
                    onClick={() => setDialog({ action: 'recover', row })}
                  >
                    {t('recover')}
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      {dialog && (
        <FormDialog
          key={`${dialog.action}-${dialog.row?.id || ''}`}
          title={t(dialog.action === 'create' ? 'newWorkspace' : dialog.action)}
          initial={
            dialog.action === 'create'
              ? { type: 'LOCAL', git: { ref_type: 'branch', ref_name: 'main' } }
              : { name: dialog.row?.name }
          }
          onClose={() => setDialog(undefined)}
          onSubmit={perform}
        >
          {dialog.action === 'create' ? (
            <>
              <Form.Item name="type" label={t('type')}>
                <Select options={enumOptions(['LOCAL', 'GIT'])} />
              </Form.Item>
              <Form.Item name="name" label={t('name')} rules={[required()]}>
                <Input maxLength={255} />
              </Form.Item>
              <Form.Item noStyle shouldUpdate={(a, b) => a.type !== b.type}>
                {({ getFieldValue }) =>
                  getFieldValue('type') === 'GIT' ? (
                    <GitFields />
                  ) : (
                    <Alert type="info" showIcon message={t('localHelp')} />
                  )
                }
              </Form.Item>
            </>
          ) : dialog.action === 'rename' ? (
            <Form.Item name="name" label={t('name')} rules={[required()]}>
              <Input maxLength={255} />
            </Form.Item>
          ) : dialog.action === 'delete' ? (
            <>
              <Alert type="warning" showIcon message={t('deleteHelp')} />
              <ErrorPanel error={references.error} />
              {references.data && (
                <Details
                  values={[
                    ['tasks', references.data.tasks_count],
                    ['runs', references.data.historical_runs_count],
                    ['syncHistory', references.data.sync_runs_count],
                  ]}
                />
              )}
              <Form.Item
                label={t('preservationBackup')}
                name="preservation_backup_id"
              >
                <Input />
              </Form.Item>
              <Form.Item
                label={t('confirmName')}
                name="confirm_name"
                rules={[
                  required(),
                  {
                    validator: (_, value) =>
                      value === dialog.row?.name
                        ? Promise.resolve()
                        : Promise.reject(new Error(t('confirmName'))),
                  },
                ]}
              >
                <Input autoComplete="off" />
              </Form.Item>
            </>
          ) : (
            <Alert
              type="warning"
              showIcon
              message={t(
                dialog.action === 'archive'
                  ? 'archiveHelp'
                  : dialog.action === 'unarchive'
                  ? 'unarchiveHelp'
                  : 'error.recovery',
              )}
            />
          )}
        </FormDialog>
      )}
    </Page>
  );
}
