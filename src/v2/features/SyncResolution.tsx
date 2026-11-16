import React, { useRef, useState } from 'react';
import { Link } from '@umijs/max';
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Modal,
  Radio,
  Space,
  Typography,
} from 'antd';
import { ApiError, call, requestKey, useAction, useResource } from '../api';
import { ErrorPanel, Fingerprint, State } from '../components';
import { diagnostic, useText } from '../i18n';

export const needsSyncResolution = (code?: string) =>
  [
    'DIVERGED',
    'DIVERGED_BRANCH',
    'LOCAL_ONLY_COMMITS',
    'GIT_CONFLICT',
  ].includes(code || '');

export function SyncResolution({
  workspace,
  run,
  onClose,
}: {
  workspace: any;
  run: any;
  onClose: () => void;
}) {
  const t = useText(),
    action = useAction(),
    key = useRef(requestKey());
  const [choice, setChoice] = useState('keep'),
    [name, setName] = useState(`${workspace.name.slice(0, 240)} — remote`),
    [confirmed, setConfirmed] = useState(false),
    [backupId, setBackupId] = useState<string>(),
    [created, setCreated] = useState<any>();
  const backup = useResource(
    backupId ? `/backups/operations/${backupId}` : null,
    1500,
  );
  const creation = useResource(
    created
      ? `/workspaces/${created.workspace.id}/operations/${created.operation.id}`
      : null,
    1500,
  );
  const snapshot =
    backup.data?.status === 'SUCCESS' ? backup.data.result : undefined;
  const busy =
    action.busy ||
    ['QUEUED', 'RUNNING'].includes(backup.data?.status) ||
    (!!backupId && !backup.data) ||
    (!!created &&
      ![
        'SUCCESS',
        'FAILED',
        'CANCELLED',
        'INTERRUPTED',
        'RECOVERY_REQUIRED',
      ].includes(creation.data?.status));
  return (
    <Modal
      open
      width={720}
      title={t('syncResolution')}
      footer={null}
      maskClosable={false}
      closable={!action.busy}
      onCancel={() => !action.busy && onClose()}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Alert
          type="warning"
          showIcon
          message={diagnostic(run.error_code)}
          description={t('syncResolutionHelp')}
        />
        <Typography.Text>
          {t('currentCommit')}:{' '}
          <Fingerprint value={run.before_commit || run.current_commit} />
        </Typography.Text>
        <Typography.Text>
          {t('targetCommit')}: <Fingerprint value={run.target_commit} />
        </Typography.Text>
        <Radio.Group
          value={choice}
          disabled={busy || !!backupId || !!created}
          onChange={(e) => setChoice(e.target.value)}
        >
          <Space direction="vertical">
            <Radio value="keep">{t('syncKeepLocal')}</Radio>
            <Radio value="remote">{t('syncRemoteCopy')}</Radio>
            <Radio value="manual">{t('syncManualMerge')}</Radio>
          </Space>
        </Radio.Group>
        {choice === 'keep' ? (
          <>
            <Typography.Paragraph>{t('syncKeepHelp')}</Typography.Paragraph>
            <Button onClick={onClose}>{t('syncKeepLocal')}</Button>
          </>
        ) : (
          <>
            <Typography.Paragraph>
              {t(choice === 'remote' ? 'syncRemoteHelp' : 'syncManualHelp')}
            </Typography.Paragraph>
            <ErrorPanel
              error={action.error || backup.error || creation.error}
            />
            {!backupId && (
              <Button
                loading={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const operation = await call('/backups', {
                      method: 'POST',
                      body: {},
                    });
                    setBackupId(operation.id);
                  })
                }
              >
                {t('syncBackupFirst')}
              </Button>
            )}
            {backup.data && (
              <Alert
                type={
                  snapshot
                    ? 'success'
                    : backup.data.status === 'FAILED'
                    ? 'error'
                    : 'info'
                }
                message={
                  <Space>
                    {t('backup')} <State value={backup.data.status} />
                  </Space>
                }
                description={
                  backup.data.error_code ||
                  (snapshot ? `${t('id')}: ${snapshot}` : undefined)
                }
              />
            )}
            {snapshot && <Link to="/settings">{t('syncExportBackup')}</Link>}
            {snapshot && choice === 'remote' && !created && (
              <>
                <label htmlFor="sync-copy-name">{t('name')}</label>
                <Input
                  id="sync-copy-name"
                  value={name}
                  maxLength={255}
                  onChange={(e) => setName(e.target.value)}
                />
                <Checkbox
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                >
                  {t('syncCopyConfirm')}
                </Checkbox>
                <Button
                  type="primary"
                  disabled={!confirmed || !name.trim()}
                  loading={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      const current = await call(`/workspaces/${workspace.id}`);
                      const manifest = await call(`/backups/${snapshot}`);
                      const saved = manifest.workspaces?.find(
                        (w: any) => w.workspace_id === workspace.id,
                      );
                      if (
                        current.version !== workspace.version ||
                        current.source_generation !==
                          workspace.source_generation ||
                        current.content_revision !==
                          workspace.content_revision ||
                        !saved ||
                        saved.source_generation !== current.source_generation ||
                        saved.content_revision !== current.content_revision ||
                        saved.content_inventory_hash !==
                          current.content_inventory_hash
                      )
                        throw new ApiError(409, 'SOURCE_SUPERSEDED');
                      setCreated(
                        await call('/workspaces', {
                          method: 'POST',
                          key: key.current,
                          body: {
                            type: 'GIT',
                            name: name.trim(),
                            git: {
                              repository_id: current.git.repository_id,
                              ref_type: current.git.ref_type,
                              ref_name: current.git.ref_name,
                            },
                            sync_policy: {
                              enabled: true,
                              mode: 'MANUAL',
                              schedule: null,
                            },
                            discovery: {
                              enabled: false,
                              includes: ['**/*'],
                              excludes: [],
                              languages: [
                                'PYTHON',
                                'JAVASCRIPT',
                                'TYPESCRIPT',
                                'SHELL',
                              ],
                            },
                          },
                        }),
                      );
                    })
                  }
                >
                  {t('syncCreateRemote')}
                </Button>
              </>
            )}
            {created && (
              <Alert
                type={
                  creation.data?.status === 'SUCCESS'
                    ? 'success'
                    : creation.data?.error_code
                    ? 'error'
                    : 'info'
                }
                message={
                  <Space>
                    {t('syncRemoteCopy')}{' '}
                    <State
                      value={creation.data?.status || created.operation.status}
                    />
                  </Space>
                }
                description={
                  <Space direction="vertical">
                    {creation.data?.error_code}
                    <Link to={`/workspaces/${created.workspace.id}`}>
                      {t('syncOpenCopy')}
                    </Link>
                    <span>{t('syncTaskSwitchHelp')}</span>
                  </Space>
                }
              />
            )}
            {!action.busy && <Button onClick={onClose}>{t('close')}</Button>}
          </>
        )}
      </Space>
    </Modal>
  );
}
