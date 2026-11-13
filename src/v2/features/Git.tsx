import React, { useRef, useState } from 'react';
import { Link } from '@umijs/max';
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Typography,
} from 'antd';
import { call, list, query, requestKey, useAction, useResource } from '../api';
import {
  Details,
  ErrorPanel,
  Fingerprint,
  FormDialog,
  Reload,
  State,
  Time,
  enumOptions,
  lines,
  required,
} from '../components';
import { useText, diagnostic } from '../i18n';
import { Logs } from './Logs';

export function GitPanel({
  workspace,
  onChanged,
}: {
  workspace: any;
  onChanged: () => void;
}) {
  const t = useText(),
    base = `/workspaces/${workspace.id}`,
    status = useResource(base + '/git/status'),
    policy = useResource(base + '/sync-policy'),
    identity = useResource('/system/git-identity'),
    action = useAction(),
    [dialog, setDialog] = useState<string>(),
    [preview, setPreview] = useState<any>(),
    [sync, setSync] = useState<any>(),
    [diff, setDiff] = useState<any>(),
    syncKey = useRef(requestKey());
  const writable = workspace.capabilities.write_files;
  const request = () => ({
    expected_version: workspace.version,
    expected_policy_version: policy.data?.version,
  });
  return (
    <>
      <ErrorPanel
        error={
          status.error ||
          policy.error ||
          action.error ||
          (dialog === 'identity' ? identity.error : undefined)
        }
      />
      <div className="v2-toolbar">
        <Space wrap>
          <Button
            type="primary"
            disabled={!workspace.capabilities.sync || !policy.data}
            loading={action.busy}
            onClick={() =>
              void action.run(async () => {
                setSync(
                  await call(base + '/sync', {
                    method: 'POST',
                    body: request(),
                    key: syncKey.current,
                  }),
                );
                syncKey.current = requestKey();
                onChanged();
              })
            }
          >
            {t('sync')}
          </Button>
          <Button
            disabled={!workspace.capabilities.sync || !policy.data}
            onClick={() =>
              void action.run(async () =>
                setPreview(
                  await call(base + '/sync/preview', {
                    method: 'POST',
                    body: request(),
                    key: requestKey(),
                  }),
                ),
              )
            }
          >
            {t('syncPreview')}
          </Button>
          <Button
            disabled={!writable || !identity.data}
            onClick={() => setDialog('identity')}
          >
            {t('gitIdentity')}
          </Button>
          <Button
            disabled={!writable || status.data?.clean}
            onClick={() => setDialog('commit')}
          >
            {t('commit')}
          </Button>
          <Button disabled={!writable} onClick={() => setDialog('push')}>
            {t('push')}
          </Button>
        </Space>
        <Reload
          onClick={() => {
            void status.reload();
            void policy.reload();
          }}
        />
      </div>
      {workspace.git?.ref_type !== 'branch' && (
        <Alert type="info" showIcon message={t('fixedRef')} />
      )}
      {status.data && (
        <>
          <Details
            values={[
              ['currentCommit', <Fingerprint value={status.data.head} />],
              ['refName', workspace.git?.ref_name],
              ['contentRevision', status.data.content_revision],
              [
                'status',
                status.data.clean ? (
                  <State value="READY" />
                ) : (
                  <State value="BLOCKED" />
                ),
              ],
            ]}
          />
          {!status.data.clean && (
            <Alert
              className="v2-section"
              showIcon
              type="warning"
              message={t('dirtyNotice')}
            />
          )}
          <Table
            className="v2-section"
            rowKey="path"
            pagination={false}
            dataSource={status.data.changed_files || []}
            columns={[
              { title: t('path'), dataIndex: 'path' },
              {
                title: t('status'),
                render: (_, row: any) => (
                  <code>
                    {row.index} {row.worktree}
                  </code>
                ),
              },
              {
                title: t('actions'),
                render: (_, row: any) => (
                  <Space>
                    <Button
                      onClick={() =>
                        void action.run(async () =>
                          setDiff(
                            await call(
                              query(base + '/git/diff', {
                                path: row.path,
                                staged: false,
                              }),
                            ),
                          ),
                        )
                      }
                    >
                      {t('details')}
                    </Button>
                    <Button
                      disabled={!writable}
                      onClick={() =>
                        void action.run(async () => {
                          await call(base + '/git/stage', {
                            method: 'POST',
                            body: {
                              paths: [row.path],
                              expected_content_revision:
                                workspace.content_revision,
                            },
                          });
                          await status.reload();
                          onChanged();
                        })
                      }
                    >
                      {t('stage')}
                    </Button>
                    <Button
                      disabled={!writable}
                      onClick={() =>
                        void action.run(async () => {
                          await call(base + '/git/unstage', {
                            method: 'POST',
                            body: {
                              paths: [row.path],
                              expected_content_revision:
                                workspace.content_revision,
                            },
                          });
                          await status.reload();
                          onChanged();
                        })
                      }
                    >
                      {t('unstage')}
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        </>
      )}
      {preview && (
        <Alert
          className="v2-section"
          type={preview.readiness === 'READY' ? 'info' : 'warning'}
          showIcon
          message={
            <Space>
              <State value={preview.readiness} />
              {preview.error_code && diagnostic(preview.error_code)}
            </Space>
          }
          description={
            <Details
              values={[
                ['currentCommit', preview.current_commit],
                ['targetCommit', preview.target_commit],
              ]}
            />
          }
          closable
          onClose={() => setPreview(undefined)}
        />
      )}
      {sync && (
        <Alert
          className="v2-section"
          type="info"
          showIcon
          message={
            <Space>
              {t('syncHistory')} #{sync.id}
              <State value={sync.status} />
              <Link to={`/workspaces/${workspace.id}?tab=sync-history`}>
                {t('details')}
              </Link>
            </Space>
          }
          closable
          onClose={() => setSync(undefined)}
        />
      )}
      {diff && (
        <Drawer
          width="75%"
          open
          title={diff.path}
          onClose={() => setDiff(undefined)}
        >
          <pre className="v2-log">{diff.text}</pre>
        </Drawer>
      )}
      {dialog && (
        <FormDialog
          title={t(dialog === 'identity' ? 'gitIdentity' : dialog)}
          initial={dialog === 'identity' ? identity.data : undefined}
          onClose={() => setDialog(undefined)}
          onSubmit={async (values) => {
            if (dialog === 'identity')
              await call('/system/git-identity', {
                method: 'PUT',
                body: { ...values, expected_version: identity.data.version },
              });
            else
              await call(base + '/git/' + dialog, {
                method: 'POST',
                body: {
                  ...values,
                  expected_content_revision: workspace.content_revision,
                },
              });
            await status.reload();
            if (dialog === 'identity') await identity.reload();
            onChanged();
          }}
        >
          {dialog === 'identity' ? (
            <>
              <Form.Item name="name" label={t('name')} rules={[required()]}>
                <Input />
              </Form.Item>
              <Form.Item name="email" label={t('email')} rules={[required()]}>
                <Input />
              </Form.Item>
            </>
          ) : (
            <Form.Item
              name={dialog === 'commit' ? 'message' : 'remote_branch'}
              label={t(dialog === 'commit' ? 'commitMessage' : 'remoteBranch')}
              rules={[required()]}
            >
              <Input />
            </Form.Item>
          )}
        </FormDialog>
      )}
    </>
  );
}
export function SyncPolicy({ workspace }: { workspace: any }) {
  const t = useText(),
    path = `/workspaces/${workspace.id}/sync-policy`,
    data = useResource(path),
    [editing, setEditing] = useState(false);
  return (
    <>
      <ErrorPanel error={data.error} />
      {data.data && (
        <>
          <Details
            values={[
              [
                'status',
                <State value={data.data.enabled ? 'enabled' : 'disabled'} />,
              ],
              ['schedule', <State value={data.data.mode} />],
              ['version', data.data.version],
              ['started', <Time value={data.data.next_due_at} />],
            ]}
          />
          <Button
            className="v2-section"
            disabled={!workspace.capabilities.sync}
            onClick={() => setEditing(true)}
          >
            {t('edit')}
          </Button>
        </>
      )}
      {editing && (
        <FormDialog
          title={t('syncPolicy')}
          initial={{
            enabled: data.data.enabled,
            mode: data.data.mode,
            ...(data.data.schedule || {}),
            schedule_type: data.data.schedule?.type || 'CRON',
            expression: data.data.schedule?.expression || '0 * * * *',
            timezone: data.data.schedule?.timezone || 'UTC',
            misfire_policy: data.data.schedule?.misfire_policy || 'SKIP',
            interval_ms: data.data.schedule?.interval_ms || 3600000,
            anchor_at:
              data.data.schedule?.anchor_at || new Date().toISOString(),
          }}
          onClose={() => setEditing(false)}
          onSubmit={async (values) => {
            const schedule =
              values.mode === 'MANUAL'
                ? null
                : values.schedule_type === 'CRON'
                ? {
                    type: 'CRON',
                    expression: values.expression,
                    timezone: values.timezone,
                    misfire_policy: values.misfire_policy,
                  }
                : {
                    type: 'INTERVAL',
                    interval_ms: values.interval_ms,
                    anchor_at: values.anchor_at,
                    misfire_policy: values.misfire_policy,
                  };
            await call(path, {
              method: 'PUT',
              body: {
                expected_version: data.data.version,
                enabled: values.enabled,
                mode: values.mode,
                schedule,
              },
            });
            await data.reload();
          }}
        >
          <Form.Item name="enabled" valuePropName="checked">
            <Checkbox>{t('enabled')}</Checkbox>
          </Form.Item>
          <Form.Item name="mode" label={t('schedule')}>
            <Select
              options={[
                { value: 'MANUAL', label: t('status.MANUAL') },
                {
                  value: 'SCHEDULED',
                  label: t('status.SCHEDULED'),
                  disabled: workspace.git?.ref_type !== 'branch',
                },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate>
            {({ getFieldValue }) =>
              getFieldValue('mode') === 'SCHEDULED' && (
                <>
                  <Form.Item name="schedule_type" label={t('type')}>
                    <Select options={enumOptions(['CRON', 'INTERVAL'])} />
                  </Form.Item>
                  {getFieldValue('schedule_type') === 'CRON' ? (
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
                    </>
                  ) : (
                    <>
                      <Form.Item
                        name="interval_ms"
                        label={t('intervalMs')}
                        rules={[required()]}
                      >
                        <InputNumber min={1} />
                      </Form.Item>
                      <Form.Item
                        name="anchor_at"
                        label={t('anchor')}
                        rules={[required()]}
                      >
                        <Input />
                      </Form.Item>
                    </>
                  )}
                  <Form.Item name="misfire_policy" label={t('misfire')}>
                    <Select options={enumOptions(['SKIP', 'FIRE_ONCE'])} />
                  </Form.Item>
                </>
              )
            }
          </Form.Item>
        </FormDialog>
      )}
    </>
  );
}
export function SyncHistory({ workspace }: { workspace: any }) {
  const t = useText(),
    base = `/workspaces/${workspace.id}`,
    data = useResource(base + '/sync-history?size=50', 2500),
    action = useAction(),
    [selected, setSelected] = useState<any>();
  const detail = useResource(
      selected ? `${base}/sync-runs/${selected.id}` : null,
      2000,
    ),
    row = detail.data || selected;
  return (
    <>
      <ErrorPanel error={data.error || action.error} />
      <Reload onClick={() => void data.reload()} />
      <Table
        className="v2-section"
        rowKey="id"
        dataSource={list(data.data)}
        pagination={false}
        columns={[
          {
            title: t('id'),
            dataIndex: 'id',
            render: (id, record: any) => (
              <Button type="link" onClick={() => setSelected(record)}>
                #{id}
              </Button>
            ),
          },
          {
            title: t('status'),
            dataIndex: 'status',
            render: (value) => <State value={value} />,
          },
          {
            title: t('gitUpdateStatus'),
            dataIndex: 'git_update_status',
            render: (value) => <State value={value} />,
          },
          {
            title: t('discoveryStatus'),
            dataIndex: 'discovery_status',
            render: (value) => <State value={value} />,
          },
          {
            title: t('eventStatus'),
            dataIndex: 'event_status',
            render: (value) => <State value={value} />,
          },
          {
            title: t('started'),
            dataIndex: 'started_at',
            render: (value) => <Time value={value} />,
          },
          {
            title: t('diagnostics'),
            dataIndex: 'error_code',
            render: (value) =>
              value ? (
                <Typography.Text title={value}>
                  {diagnostic(value)}
                </Typography.Text>
              ) : (
                '—'
              ),
          },
        ]}
      />
      {selected && (
        <Drawer
          width="80%"
          open
          title={`${t('syncHistory')} #${selected.id}`}
          onClose={() => setSelected(undefined)}
        >
          <ErrorPanel error={detail.error} />
          <Details
            values={[
              ['status', <State value={row.status} />],
              ['phase', row.phase],
              ['initial', row.initial ? t('yes') : t('no')],
              ['beforeCommit', <Fingerprint value={row.before_commit} />],
              ['targetCommit', <Fingerprint value={row.target_commit} />],
              ['actualCommit', <Fingerprint value={row.actual_commit} />],
              ['afterCommit', <Fingerprint value={row.after_commit} />],
            ]}
          />
          {row.error_code && (
            <Alert
              className="v2-section"
              showIcon
              type="warning"
              message={diagnostic(row.error_code)}
              description={row.error_code}
            />
          )}
          {['QUEUED', 'RUNNING'].includes(row.status) && (
            <Button
              danger
              className="v2-section"
              onClick={() =>
                void action.run(async () => {
                  await call(`${base}/sync-runs/${row.id}/cancel`, {
                    method: 'POST',
                    body: {},
                  });
                  await detail.reload();
                  await data.reload();
                })
              }
            >
              {t('stop')}
            </Button>
          )}
          <div className="v2-section">
            <Logs path={`${base}/sync-runs/${row.id}/log`} />
          </div>
        </Drawer>
      )}
    </>
  );
}
export function Discovery({
  workspace,
  onChanged,
}: {
  workspace: any;
  onChanged: () => void;
}) {
  const t = useText(),
    base = `/workspaces/${workspace.id}/discovery`,
    policy = useResource(base),
    suppression = useResource(base + '/suppressions?size=100'),
    action = useAction(),
    [editing, setEditing] = useState(false),
    [preview, setPreview] = useState<any>(),
    [applied, setApplied] = useState<any>();
  const writable = workspace.capabilities.discovery;
  const counts = (key: string) =>
    (preview?.actions || []).filter((item: any) => item.action === key).length;
  return (
    <>
      <Alert type="info" showIcon message={t('previewHelp')} />
      <ErrorPanel error={policy.error || action.error || suppression.error} />
      <div className="v2-toolbar v2-section">
        <Space>
          <State value={policy.data?.enabled ? 'enabled' : 'disabled'} />
          <Button
            disabled={!writable || !policy.data}
            onClick={() => setEditing(true)}
          >
            {t('edit')}
          </Button>
          <Button
            disabled={!writable}
            onClick={() =>
              void action.run(async () => {
                setApplied(undefined);
                setPreview(
                  await call(base + '/preview', {
                    method: 'POST',
                    body: {
                      expected_version: workspace.version,
                      expected_content_revision: workspace.content_revision,
                    },
                  }),
                );
              })
            }
          >
            {t('preview')}
          </Button>
          {preview && (
            <Popconfirm
              title={
                t('applyConfirm') +
                ' ' +
                t('previewCounts', {
                  create: counts('CREATE'),
                  update: counts('UPDATE'),
                  retire: counts('RETIRE'),
                  ignore: counts('IGNORE'),
                })
              }
              onConfirm={() =>
                action.run(async () => {
                  setApplied(
                    await call(base + '/apply', {
                      method: 'POST',
                      body: {
                        preview_token: preview.preview_token,
                        expected_version: workspace.version,
                      },
                    }),
                  );
                  setPreview(undefined);
                  onChanged();
                })
              }
            >
              <Button type="primary" disabled={!writable}>
                {t('apply')}
              </Button>
            </Popconfirm>
          )}
        </Space>
        <Reload
          onClick={() => {
            void policy.reload();
            void suppression.reload();
          }}
        />
      </div>
      {preview && (
        <>
          <Alert
            type="info"
            message={t('previewCounts', {
              create: counts('CREATE'),
              update: counts('UPDATE'),
              retire: counts('RETIRE'),
              ignore: counts('IGNORE'),
            })}
          />
          <Table
            rowKey="discovery_key"
            dataSource={preview.actions || []}
            pagination={false}
            columns={[
              { title: t('path'), dataIndex: 'path' },
              {
                title: t('actions'),
                dataIndex: 'action',
                render: (value) => <State value={value} />,
              },
              {
                title: t('actions'),
                key: 'ignore',
                render: (_, row: any) => (
                  <Button
                    disabled={!writable}
                    onClick={() =>
                      void action.run(async () => {
                        await call(base + '/suppressions', {
                          method: 'POST',
                          body: {
                            discovery_key: row.discovery_key,
                            expected_policy_version: policy.data.version,
                          },
                        });
                        setPreview(undefined);
                        await suppression.reload();
                        onChanged();
                      })
                    }
                  >
                    {t('suppress')}
                  </Button>
                ),
              },
            ]}
          />
        </>
      )}
      {applied && (
        <Alert
          type="success"
          showIcon
          message={t('previewCounts', {
            create: applied.created,
            update: applied.updated,
            retire: applied.retired,
            ignore: applied.ignored,
          })}
        />
      )}
      <Typography.Title level={5} className="v2-section">
        {t('suppressed')}
      </Typography.Title>
      <Table
        rowKey="discovery_key"
        dataSource={list(suppression.data)}
        pagination={false}
        columns={[
          {
            title: t('path'),
            dataIndex: 'relative_entrypoint',
            render: (value, row: any) => value || row.discovery_key,
          },
          { title: t('description'), dataIndex: 'reason' },
          {
            title: t('actions'),
            render: (_, row: any) => (
              <Button
                disabled={!writable}
                onClick={() =>
                  void action.run(async () => {
                    await call(base + '/suppressions/' + row.discovery_key, {
                      method: 'DELETE',
                      body: { expected_version: policy.data.version },
                    });
                    await suppression.reload();
                  })
                }
              >
                {t('unsuppress')}
              </Button>
            ),
          },
        ]}
      />
      {editing && (
        <FormDialog
          title={t('discovery')}
          initial={{
            enabled: policy.data.enabled,
            includes: policy.data.includes.join('\n'),
            excludes: policy.data.excludes.join('\n'),
            languages: policy.data.languages,
          }}
          onClose={() => setEditing(false)}
          onSubmit={async (values) => {
            await call(base, {
              method: 'PUT',
              body: {
                enabled: values.enabled,
                includes: lines(values.includes),
                excludes: lines(values.excludes),
                languages: values.languages,
                expected_version: policy.data.version,
              },
            });
            setPreview(undefined);
            await policy.reload();
          }}
        >
          <Form.Item name="enabled" valuePropName="checked">
            <Checkbox>{t('enabled')}</Checkbox>
          </Form.Item>
          <Form.Item name="includes" label={t('includes')} rules={[required()]}>
            <Input.TextArea />
          </Form.Item>
          <Form.Item name="excludes" label={t('excludes')}>
            <Input.TextArea />
          </Form.Item>
          <Form.Item
            name="languages"
            label={t('languages')}
            rules={[required()]}
          >
            <Select
              mode="multiple"
              options={enumOptions([
                'PYTHON',
                'JAVASCRIPT',
                'TYPESCRIPT',
                'SHELL',
              ])}
            />
          </Form.Item>
        </FormDialog>
      )}
    </>
  );
}
