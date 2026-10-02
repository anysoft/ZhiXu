import { translateEnum, translateError } from '@/utils/i18n';
import { formatDateTime, formatDuration, formatBytes } from '@/utils/format';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import { ConfigBindings } from '@/components/config-bindings';
import { TaskResourceReferences } from '@/components/task-resource-references';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import RepositoryEnvironment from '@/components/repository-environment';
export default function RepositoryWorkspacePage() {
  useI18nLocale();
  const id = Number(new URLSearchParams(window.location.search).get('id'));
  const [repo, setRepo] = useState<any>(),
    [diagnostics, setDiagnostics] = useState<any>(),
    [refs, setRefs] = useState<any[]>([]),
    [trees, setTrees] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [detail, setDetail] = useState<any>(),
    [creating, setCreating] = useState(false),
    [refType, setRefType] = useState<'branch' | 'tag' | 'commit'>('branch'),
    [activities, setActivities] = useState<any[]>([]),
    [remoteEdit, setRemoteEdit] = useState(false),
    [remote, setRemote] = useState('');
  const [form] = Form.useForm();
  const reload = async () => {
    const [metadata, status, worktrees] = await Promise.all([
      request.get(`${config.apiPrefix}repositories/${id}`),
      request.get(`${config.apiPrefix}repositories/${id}/status`),
      request.get(`${config.apiPrefix}repositories/${id}/worktrees`),
    ]);
    if (metadata.code === 200) setRepo(metadata.data);
    if (status.code === 200) {
      setDiagnostics(status.data);
      if (status.data.repository)
        setRepo({ ...metadata.data, ...status.data.repository });
    }
    if (worktrees.code === 200) setTrees(worktrees.data);
    if (
      status.data?.repository?.storage_state === 'READY' &&
      !status.data?.lock?.busy
    ) {
      const r = await request.get(`${config.apiPrefix}repositories/${id}/refs`);
      if (r.code === 200) setRefs(r.data);
    } else setRefs([]);
  };
  useEffect(() => {
    reload().catch(() => {});
  }, [id]);
  const perform = async (
    label: string,
    url: string,
    method: 'post' | 'delete' | 'put' = 'post',
    body: any = {},
  ) => {
    setBusy(true);
    setError('');
    try {
      const endpoint = `${config.apiPrefix}${url}`;
      const result =
        method === 'delete'
          ? await request.delete(endpoint)
          : await request[method](endpoint, body, { timeout: 330000 });
      if (result.code === 200) {
        setActivities((a) => [
          { at: new Date().toISOString(), action: label, result: 'SUCCESS' },
          ...a,
        ]);
        await reload();
        message.success(tr('ui.template.valueCompleted', { p0: tr(label) }));
        return result.data;
      }
    } catch (e: any) {
      const code = e.response?.data?.error_code;
      setError(code || 'REPOSITORY_OPERATION_FAILED');
      setActivities((a) => [
        {
          at: new Date().toISOString(),
          action: label,
          result: code || 'REPOSITORY_OPERATION_FAILED',
        },
        ...a,
      ]);
      await reload().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  const openTree = async (treeId: number) => {
    try {
      const result = await request.get(
        `${config.apiPrefix}worktrees/${treeId}`,
      );
      if (result.code === 200) {
        setDetail(result.data);
        await reload();
      }
    } catch {}
  };
  const startCreate = (
    type: 'branch' | 'tag' | 'commit' = 'branch',
    ref = repo?.default_branch || '',
  ) => {
    setRefType(type);
    form.setFieldsValue({ name: ref, ref_name: ref });
    setCreating(true);
  };
  const create = async () => {
    try {
      const values = await form.validateFields();
      const result = await perform(
        'ui.extra.createWorktree',
        'worktrees',
        'post',
        {
          ...values,
          repository_id: id,
          ref_type: refType,
        },
      );
      if (result) setCreating(false);
    } catch {}
  };
  const git = detail?.git || detail?.status_snapshot;
  return (
    <div style={{ padding: 24 }}>
      <Space>
        <a href={`${config.baseUrl}repository`}>
          {tr('ui.repositoriesVariant417')}
        </a>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {repo?.name || tr('ui.extra.repositoryWorkspace')}
        </Typography.Title>
        <Tag>
          {repo
            ? translateEnum('repositoryStorage', repo.storage_state)
            : tr('common.loading')}
        </Tag>
      </Space>
      <p style={{ marginTop: 12 }}>
        {tr(
          'ui.persistentGitWorktreesFetchUpdatesRemoteReferencesUpdateWorktreeFastForwardsTheLocalBranchTasksAndTh',
        )}
      </p>
      {error && (
        <Alert
          type="error"
          showIcon
          message={translateError(error)}
          closable
          onClose={() => setError('')}
          style={{ marginBottom: 16 }}
        />
      )}
      {diagnostics?.lock?.busy && (
        <Alert
          type="info"
          message={tr('ui.template.repositoryIsBusyValue', {
            p0: diagnostics.lock.owner?.operation || 'operation',
          })}
          description={`PID ${diagnostics.lock.owner?.pid || '—'}`}
        />
      )}
      {id > 0 && <TaskResourceReferences kind="repository" id={id} />}
      <Tabs
        defaultActiveKey="overview"
        items={[
          {
            key: 'config',
            label: tr('ui.config'),
            children: <ConfigBindings scope="repository" id={id} />,
          },
          {
            key: 'environment',
            label: tr('ui.environment'),
            children: <RepositoryEnvironment id={id} />,
          },
          {
            key: 'overview',
            label: tr('ui.overview'),
            children: (
              <>
                <Descriptions bordered column={2} size="small">
                  <Descriptions.Item label={tr('ui.remote')} span={2}>
                    {repo?.remote_url}
                  </Descriptions.Item>
                  <Descriptions.Item label={tr('ui.defaultCredential')}>
                    {repo?.default_credential_id || tr('ui.extra.anonymous')}
                  </Descriptions.Item>
                  <Descriptions.Item label={tr('ui.storageState')}>
                    {repo?.storage_state}
                  </Descriptions.Item>
                  <Descriptions.Item label={tr('ui.localStorage')} span={2}>
                    <Typography.Text copyable={!!repo?.storage_path}>
                      {repo?.storage_path || tr('ui.extra.notInitialized')}
                    </Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label={tr('ui.defaultBranch')}>
                    {repo?.default_branch || '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label={tr('ui.lastFetch')}>
                    {repo?.last_fetch_at
                      ? formatDateTime(repo.last_fetch_at)
                      : '—'}{' '}
                    · {repo?.last_fetch_status || '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label={tr('ui.lastError')} span={2}>
                    {repo?.last_error ? translateError(repo.last_error) : '—'}
                  </Descriptions.Item>
                </Descriptions>
                <Space wrap style={{ marginTop: 16 }}>
                  <Button
                    loading={busy}
                    onClick={() =>
                      perform('ui.initialize', `repositories/${id}/initialize`)
                    }
                  >
                    {tr('ui.initialize')}
                  </Button>
                  <Button
                    loading={busy}
                    disabled={!repo?.storage_path}
                    onClick={() =>
                      perform('ui.fetch', `repositories/${id}/fetch`)
                    }
                  >
                    {tr('ui.fetch')}
                  </Button>
                  <Button
                    loading={busy}
                    onClick={() => {
                      setBusy(true);
                      reload()
                        .catch(() => {})
                        .finally(() => setBusy(false));
                    }}
                  >
                    {tr('ui.diagnostics')}
                  </Button>
                  <Button
                    loading={busy}
                    disabled={!repo?.storage_path}
                    onClick={() =>
                      perform('ui.repairMetadata', `repositories/${id}/repair`)
                    }
                  >
                    {tr('ui.repairMetadata')}
                  </Button>
                  <Popconfirm
                    title={tr(
                      'ui.removeGitWorktreeRecordsOnlyWhenTheirDirectoriesAreMissingStopsIfResourcesAreBusy',
                    )}
                    onConfirm={() =>
                      perform('ui.prune', `repositories/${id}/prune`)
                    }
                  >
                    <Button disabled={busy || !repo?.storage_path}>
                      {tr('ui.prune')}
                    </Button>
                  </Popconfirm>
                  <Button
                    disabled={busy || !!repo?.subscriptions_count}
                    onClick={() => {
                      setRemote(repo.remote_url);
                      setRemoteEdit(true);
                    }}
                  >
                    {tr('ui.changeRemoteURL')}
                  </Button>
                </Space>
                {!!repo?.subscriptions_count && (
                  <p>
                    {tr(
                      'ui.remoteURLsRemainFixedWhileReferencedByOlderSubscriptionsProtectingExistingClonePathsCredentialsCanBe',
                    )}
                  </p>
                )}
                {!!diagnostics?.orphans?.length && (
                  <Alert
                    style={{ marginTop: 16 }}
                    type="warning"
                    message={tr('ui.unregisteredGitWorktreesFound')}
                    description={diagnostics.orphans.map((o: any) => (
                      <div key={o.path}>{o.path}</div>
                    ))}
                  />
                )}
              </>
            ),
          },
          {
            key: 'refs',
            label: tr('ui.refsBranches'),
            children: (
              <>
                <Button
                  onClick={() => startCreate('commit', '')}
                  disabled={busy || repo?.storage_state !== 'READY'}
                >
                  {tr('ui.createWorktreeFromCommit')}
                </Button>
                <Table
                  rowKey="ref"
                  dataSource={refs}
                  columns={[
                    { title: tr('ui.type'), dataIndex: 'type' },
                    { title: tr('ui.branchTag'), dataIndex: 'name' },
                    {
                      title: tr('ui.commit'),
                      dataIndex: 'commit',
                      render: (v: string) => (
                        <Typography.Text copyable>
                          {v?.slice(0, 12)}
                        </Typography.Text>
                      ),
                    },
                    {
                      title: tr('ui.updated'),
                      dataIndex: 'updated',
                      render: (value: any) => formatDateTime(value),
                    },
                    {
                      title: tr('ui.action'),
                      render: (_: any, r: any) => (
                        <Button
                          disabled={busy}
                          onClick={() => startCreate(r.type, r.name)}
                        >
                          {tr('ui.createWorktree')}
                        </Button>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'worktrees',
            label: tr('ui.worktrees'),
            children: (
              <>
                <Button
                  type="primary"
                  disabled={busy || repo?.storage_state !== 'READY'}
                  onClick={() => startCreate()}
                >
                  {tr('ui.createWorktree')}
                </Button>
                <Table
                  rowKey="id"
                  dataSource={trees}
                  scroll={{ x: 1200 }}
                  columns={[
                    { title: tr('ui.name'), dataIndex: 'name' },
                    {
                      title: tr('ui.purpose'),
                      dataIndex: 'purpose',
                      render: (value: string) =>
                        value === 'SUBSCRIPTION'
                          ? tr('ui.extra.subscriptionWorktree')
                          : tr('ui.extra.userWorktree'),
                    },
                    {
                      title: tr('ui.subscriptionReferences'),
                      render: (_: any, row: any) =>
                        row.subscriptions?.length
                          ? row.subscriptions
                              .map(
                                (sub: any) =>
                                  `${sub.name || 'Subscription'} #${sub.id}`,
                              )
                              .join(', ')
                          : tr('ui.extra.unboundWorktreeRetained'),
                    },
                    {
                      title: tr('ui.branchRef'),
                      render: (_: any, r: any) =>
                        `${translateEnum('refType', r.ref_type)}: ${
                          r.ref_name
                        }`,
                    },
                    {
                      title: 'HEAD',
                      dataIndex: 'commit',
                      render: (v: string) => v?.slice(0, 10) || '—',
                    },
                    {
                      title: tr('ui.status'),
                      dataIndex: 'lifecycle_state',
                      render: (value: unknown) =>
                        translateEnum('worktreeLifecycle', value),
                    },
                    {
                      title: tr('ui.dirty'),
                      dataIndex: 'dirty_state',
                      render: (value: unknown) =>
                        translateEnum('worktreeDirty', value),
                    },
                    {
                      title: tr('ui.busy'),
                      render: (_: any, r: any) =>
                        r.lease?.busy
                          ? r.lease.owner?.operation ||
                            tr('ui.presentation.Busy')
                          : '—',
                    },
                    {
                      title: tr('ui.aheadBehind'),
                      render: (_: any, r: any) =>
                        `${r.status_snapshot?.ahead ?? '—'} / ${
                          r.status_snapshot?.behind ?? '—'
                        }`,
                    },
                    {
                      title: tr('ui.path'),
                      dataIndex: 'local_path',
                      ellipsis: true,
                    },
                    {
                      title: tr('ui.lastUpdated'),
                      dataIndex: 'last_update_at',
                      render: (v: string) => (v ? formatDateTime(v) : '—'),
                    },
                    {
                      title: tr('ui.action'),
                      fixed: 'right' as const,
                      render: (_: any, r: any) => (
                        <Space wrap>
                          <Button
                            size="small"
                            href={`${config.baseUrl}workspace?id=${r.id}`}
                          >
                            {tr('ui.openWorkspace')}
                          </Button>
                          <Button size="small" onClick={() => openTree(r.id)}>
                            {tr('ui.open')}
                          </Button>
                          <Button
                            size="small"
                            disabled={busy}
                            onClick={async () => {
                              const result = await perform(
                                'ui.refresh',
                                `worktrees/${r.id}/refresh`,
                              );
                              if (result) setDetail(result);
                            }}
                          >
                            {tr('ui.refresh')}
                          </Button>
                          <Button
                            size="small"
                            disabled={busy}
                            onClick={() =>
                              perform(
                                'ui.extra.updateWorktree',
                                `worktrees/${r.id}/update`,
                              )
                            }
                          >
                            {tr('ui.update')}
                          </Button>
                          <Popconfirm
                            title={tr(
                              'ui.deleteThisWorktreeLocalChangesCommitsOrActiveUseWillPreventDeletion',
                            )}
                            onConfirm={() =>
                              perform(
                                'ui.extra.deleteWorktree',
                                `worktrees/${r.id}`,
                                'delete',
                              )
                            }
                          >
                            <Button danger size="small" disabled={busy}>
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
          },
          {
            key: 'activity',
            label: tr('ui.activity'),
            children: (
              <>
                <p>
                  {tr(
                    'ui.resultsFromThisPageSessionBackendSystemLogsRetainResourceOperationRecords',
                  )}
                </p>
                <Table
                  rowKey={(_, i) => String(i)}
                  dataSource={activities}
                  columns={[
                    {
                      title: tr('ui.time'),
                      dataIndex: 'at',
                      render: (value: string) => formatDateTime(value),
                    },
                    {
                      title: tr('ui.action'),
                      dataIndex: 'action',
                      render: (key: string) => tr(key),
                    },
                    {
                      title: tr('ui.result'),
                      dataIndex: 'result',
                      render: (value: string) =>
                        value === 'SUCCESS'
                          ? tr('ui.extra.completed')
                          : translateError(value),
                    },
                  ]}
                />
              </>
            ),
          },
        ]}
      />
      <Modal
        open={creating}
        title={tr('ui.createWorktree')}
        onCancel={() => setCreating(false)}
        onOk={create}
        confirmLoading={busy}
        forceRender
      >
        <Form form={form} layout="vertical">
          <Form.Item label={tr('ui.refType')}>
            <Radio.Group
              value={refType}
              onChange={(e) => {
                setRefType(e.target.value);
                form.setFieldsValue({ ref_name: '' });
              }}
            >
              <Radio value="branch">{tr('ui.branch')}</Radio>
              <Radio value="tag">{tr('ui.tag')}</Radio>
              <Radio value="commit">{tr('ui.commit')}</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item
            label={tr('ui.name')}
            name="name"
            rules={[{ required: true }]}
          >
            <Input maxLength={255} />
          </Form.Item>
          <Form.Item
            label={tr('ui.ref')}
            name="ref_name"
            rules={[{ required: true }]}
          >
            {refType === 'commit' ? (
              <Input placeholder={tr('ui.fullCommitSHA')} />
            ) : (
              <Select
                showSearch
                options={refs
                  .filter((r) => r.type === refType)
                  .map((r) => ({ value: r.name, label: r.name }))}
              />
            )}
          </Form.Item>
          <p>
            {tr(
              'ui.pathsAreGeneratedByTheSystemEachRemoteBranchHasOneManagedWorktreeByDefaultCommitsAndTagsUseDetachedH',
            )}
          </p>
        </Form>
      </Modal>
      <Modal
        width={880}
        open={!!detail}
        title={tr('ui.template.worktreeValue', { p0: detail?.name || '' })}
        onCancel={() => setDetail(undefined)}
        footer={
          <Space>
            <Button onClick={() => openTree(detail.id)}>
              {tr('ui.refresh')}
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                const result = await perform(
                  'ui.extra.repairWorktree',
                  `worktrees/${detail.id}/repair`,
                );
                if (result) setDetail(result);
              }}
            >
              {tr('ui.repair')}
            </Button>
            {detail?.lifecycle_state === 'MISSING' && (
              <Popconfirm
                title={tr(
                  'ui.recordsCanBeRemovedAfterMissingDirectoriesArePrunedFromGitLocalCommitsRemainProtected',
                )}
                onConfirm={async () => {
                  await perform(
                    'ui.extra.removeRecord',
                    `worktrees/${detail.id}/remove-record`,
                  );
                  setDetail(undefined);
                }}
              >
                <Button danger>{tr('ui.removeRecord')}</Button>
              </Popconfirm>
            )}
          </Space>
        }
      >
        {detail?.id && (
          <TaskResourceReferences kind="worktree" id={detail.id} />
        )}
        <Descriptions column={2} bordered size="small">
          <Descriptions.Item label={tr('ui.repository')}>
            {repo?.name}
          </Descriptions.Item>
          <Descriptions.Item label={tr('ui.ref')}>
            {detail?.ref_type}: {detail?.ref_name}
          </Descriptions.Item>
          <Descriptions.Item label={tr('ui.branch')}>
            {git?.branch || tr('ui.extra.detached')}
          </Descriptions.Item>
          <Descriptions.Item label="HEAD">
            {git?.head || detail?.commit}
          </Descriptions.Item>
          <Descriptions.Item label={tr('ui.localPath')} span={2}>
            {detail?.local_path}
          </Descriptions.Item>
          <Descriptions.Item label={tr('ui.status')}>
            {detail?.lifecycle_state} / {detail?.dirty_state}
          </Descriptions.Item>
          <Descriptions.Item label={tr('ui.aheadBehind')}>
            {git?.ahead ?? '—'} / {git?.behind ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label={tr('ui.activeLease')} span={2}>
            {detail?.lease?.busy
              ? `${detail.lease.owner?.operation} · ${detail.lease.owner?.owner_type}/${detail.lease.owner?.owner_id} · PID ${detail.lease.owner?.pid}`
              : tr('ui.extra.notInUse')}
          </Descriptions.Item>
        </Descriptions>
        <h4>{tr('ui.changedFiles')}</h4>
        <Table
          size="small"
          rowKey="path"
          dataSource={git?.changed_files || []}
          columns={[
            { title: tr('ui.file'), dataIndex: 'path' },
            { title: tr('ui.index'), dataIndex: 'index' },
            { title: 'Worktree', dataIndex: 'worktree' },
          ]}
        />
      </Modal>
      <Modal
        title={tr('ui.changeTheRemoteURLForThisRepository')}
        open={remoteEdit}
        onCancel={() => setRemoteEdit(false)}
        onOk={async () => {
          const result = await perform(
            'ui.extra.changeRemote',
            `repositories/${id}/remote`,
            'post',
            { remote_url: remote },
          );
          if (result) setRemoteEdit(false);
        }}
        confirmLoading={busy}
      >
        <Input value={remote} onChange={(e) => setRemote(e.target.value)} />
        <p>
          {tr(
            'ui.onlySafeURLsWithTheSameNormalizedRepositoryIdentityAreAcceptedChangingCredentialsDoesNotRequireChang',
          )}
        </p>
      </Modal>
    </div>
  );
}
