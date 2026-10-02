import { translateEnum, translateError } from '@/utils/i18n';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Drawer,
  Input,
  List,
  Modal,
  Select,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import Editor from '@monaco-editor/react';
import * as Umi from '@umijs/max';
const history = (Umi as any).history;
import { request } from '@/utils/http';
import config from '@/utils/config';
import './workspace.less';
const languages: Record<string, string> = {
  py: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  sh: 'shell',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
};
type Tab = {
  path: string;
  content: string;
  saved: string;
  hash: string;
  editable: boolean;
  error_code?: string;
  mode: number;
  eol: string;
};
export default function CodeWorkspacePage() {
  useI18nLocale();
  const [id, setId] = useState(
      Number(new URLSearchParams(window.location.search).get('id')),
    ),
    [worktrees, setWorktrees] = useState<any[]>([]),
    [ready, setReady] = useState(false);
  const [info, setInfo] = useState<any>(),
    [tree, setTree] = useState<any>({ items: [] }),
    [directory, setDirectory] = useState(''),
    [offset, setOffset] = useState(0);
  const [tabs, setTabs] = useState<Tab[]>([]),
    [active, setActive] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [git, setGit] = useState<any>({ changed_files: [] }),
    [gitOffset, setGitOffset] = useState(0),
    [gitOpen, setGitOpen] = useState(false),
    [diff, setDiff] = useState<any>();
  const [message, setMessage] = useState(''),
    [identity, setIdentity] = useState({ name: '', email: '' }),
    [branch, setBranch] = useState('');
  const [newItem, setNewItem] = useState<'file' | 'directory' | null>(null),
    [newPath, setNewPath] = useState(''),
    [rename, setRename] = useState<any>(),
    [destination, setDestination] = useState('');
  const [query, setQuery] = useState(''),
    [searchContent, setSearchContent] = useState(false),
    [results, setResults] = useState<any>(),
    [stale, setStale] = useState(false),
    [subscription, setSubscription] = useState<number>();
  const dirty = tabs.some((t) => t.content !== t.saved),
    dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const api = `${config.apiPrefix}workspaces/${id}`;
  const tab = tabs.find((t) => t.path === active);
  const call = async (
    method: 'get' | 'post' | 'put' | 'delete',
    suffix: string,
    value?: any,
  ) => {
    const result =
      method === 'get'
        ? await request.get(api + suffix, { params: value })
        : method === 'delete'
        ? await request.delete(api + suffix, { data: value })
        : await request[method](api + suffix, value, { timeout: 330000 });
    return result.data;
  };
  const perform = async (action: () => Promise<any>) => {
    setBusy(true);
    setError('');
    try {
      return await action();
    } catch (e: any) {
      setError(
        e.response?.data?.error_code ||
          e.response?.data?.message ||
          'WORKSPACE_OPERATION_FAILED',
      );
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    const metadata = await call('get', '');
    setInfo(metadata);
    if (metadata.identity) setIdentity(metadata.identity);
    setTree(
      await call('get', '/tree', { path: directory, offset, limit: 200 }),
    );
    setGit(await call('get', '/git/status', { offset: gitOffset, limit: 100 }));
  };
  useEffect(() => {
    void request
      .get(`${config.apiPrefix}worktrees`)
      .then((r) => setWorktrees(r.data || []))
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (id > 0 && ready) void perform(reload);
  }, [id, directory, offset, gitOffset, ready]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    const unblock = (history as any).block?.((transition: any) => {
      if (!dirtyRef.current) {
        unblock?.();
        transition.retry();
        return;
      }
      Modal.confirm({
        title: tr('ui.discardUnsavedChanges'),
        content: tr('ui.extra.draftsAreKeptOnlyInThisPageSMemory'),
        onOk: () => {
          unblock?.();
          transition.retry();
        },
      });
    });
    return () => {
      window.removeEventListener('beforeunload', unload);
      unblock?.();
    };
  }, []);
  const confirmDirty = (action: () => void) =>
    dirty
      ? Modal.confirm({ title: tr('ui.discardUnsavedChanges'), onOk: action })
      : action();
  const open = async (file: string, reloadFile = false) => {
    if (!reloadFile && tabs.some((t) => t.path === file)) {
      setActive(file);
      return;
    }
    const data = await call('get', '/files', { path: file });
    const value = {
      ...data,
      content: data.content || '',
      saved: data.content || '',
    };
    setTabs((old) => [...old.filter((t) => t.path !== file), value]);
    setActive(file);
  };
  const save = async () => {
    if (!tab) return;
    setBusy(true);
    setError('');
    try {
      const data = await call('put', '/files', {
        path: tab.path,
        content: tab.content,
        expected_hash: tab.hash,
      });
      setTabs((old) =>
        old.map((t) =>
          t.path === tab.path ? { ...data, saved: data.content } : t,
        ),
      );
      await reload();
    } catch (e: any) {
      const code = e.response?.data?.error_code;
      if (code === 'WORKSPACE_FILE_CONFLICT')
        Modal.confirm({
          title: tr('ui.fileChangedOnDisk'),
          content: tr(
            'ui.extra.theFileOnDiskChangedReloadDiscardsTheCurrentDraftCancelKeepsItForManualComparison',
          ),
          okText: tr('ui.reload'),
          cancelText: tr('ui.cancel'),
          onOk: () => perform(() => open(tab.path, true)),
        });
      else setError(code || 'WORKSPACE_SAVE_FAILED');
    } finally {
      setBusy(false);
    }
  };
  const close = (file: string) => {
    const t = tabs.find((t) => t.path === file);
    const action = () => {
      setTabs((old) => old.filter((t) => t.path !== file));
      if (active === file)
        setActive(tabs.find((t) => t.path !== file)?.path || '');
    };
    if (t?.content !== t?.saved)
      Modal.confirm({
        title: tr('ui.discardUnsavedChangesToThisFile'),
        onOk: action,
      });
    else action();
  };
  const entryIdentity = async (entry: any) =>
    entry.kind === 'directory'
      ? entry.identity
      : await call('get', '/files', { path: entry.path }).then(
          (f) => f.hash || f.identity,
        );
  const gitPanel = (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Typography.Title level={4}>{tr('ui.gitChanges')}</Typography.Title>
      <div>
        {tr('ui.staged')} {git.staged || 0} {tr('ui.unstaged')}{' '}
        {git.modified || 0} {tr('ui.untracked')} {git.untracked || 0}
      </div>
      <List
        size="small"
        dataSource={git.changed_files}
        renderItem={(file: any) => (
          <List.Item>
            <div style={{ width: '100%' }}>
              <Typography.Text code>
                {file.index}
                {file.worktree}
              </Typography.Text>{' '}
              {file.path}
              <Space wrap>
                <Button
                  size="small"
                  onClick={() =>
                    perform(async () =>
                      setDiff(
                        await call('get', '/git/diff', {
                          path: file.path,
                          staged: false,
                        }),
                      ),
                    )
                  }
                >
                  {tr('ui.diff')}
                </Button>
                <Button
                  size="small"
                  onClick={() =>
                    perform(async () =>
                      setDiff(
                        await call('get', '/git/diff', {
                          path: file.path,
                          staged: true,
                        }),
                      ),
                    )
                  }
                >
                  {tr('ui.stagedDiff')}
                </Button>
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      await call('post', '/git/stage', { paths: [file.path] });
                      await reload();
                    })
                  }
                >
                  {tr('ui.stage')}
                </Button>
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      await call('post', '/git/unstage', {
                        paths: [file.path],
                      });
                      await reload();
                    })
                  }
                >
                  {tr('ui.unstage')}
                </Button>
              </Space>
            </div>
          </List.Item>
        )}
      />
      <Space>
        <Button
          disabled={!gitOffset}
          onClick={() => setGitOffset(Math.max(0, gitOffset - 100))}
        >
          {tr('ui.previousChanges')}
        </Button>
        <Button
          disabled={git.next === null || git.next === undefined}
          onClick={() => setGitOffset(git.next)}
        >
          {tr('ui.moreChanges')}
        </Button>
      </Space>
      <Input
        aria-label={tr('ui.gitAuthorName')}
        placeholder={tr('ui.gitAuthorName')}
        value={identity.name}
        onChange={(e) => setIdentity({ ...identity, name: e.target.value })}
      />
      <Input
        aria-label={tr('ui.gitAuthorEmail')}
        placeholder={tr('ui.gitAuthorEmail')}
        value={identity.email}
        onChange={(e) => setIdentity({ ...identity, email: e.target.value })}
      />
      <Button
        disabled={busy}
        onClick={() => perform(() => call('put', '/git/identity', identity))}
      >
        {tr('ui.saveGitIdentity')}
      </Button>
      <Input.TextArea
        aria-label={tr('ui.commitMessage')}
        placeholder={tr('ui.commitMessage')}
        value={message}
        maxLength={8192}
        onChange={(e) => setMessage(e.target.value)}
      />
      <Button
        type="primary"
        disabled={busy || !message.trim() || !git.staged}
        onClick={() =>
          perform(async () => {
            await call('post', '/git/commit', { message });
            setMessage('');
            await reload();
          })
        }
      >
        {tr('ui.commitStaged')} {git.staged || 0})
      </Button>
      <div>
        {tr('ui.pushVariant250')}{' '}
        {info?.upstream || tr('ui.extra.originSelectBranch')} {tr('ui.ahead')}{' '}
        {info?.ahead ?? '—'}
      </div>
      {!info?.upstream && (
        <Input
          aria-label={tr('ui.pushBranch')}
          placeholder={tr('ui.remoteBranch')}
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />
      )}
      <Button
        disabled={busy || !info?.branch}
        onClick={() =>
          Modal.confirm({
            title: tr('ui.pushToOrigin'),
            content: info?.upstream || branch,
            onOk: () =>
              perform(async () => {
                await call(
                  'post',
                  '/git/push',
                  info?.upstream ? {} : { branch },
                );
                await reload();
              }),
          })
        }
      >
        {tr('ui.push')}
      </Button>
    </Space>
  );
  return (
    <div className="code-workspace">
      <Space wrap>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {tr('ui.codeWorkspace')}
        </Typography.Title>
        <Select
          aria-label="Worktree"
          value={id || undefined}
          placeholder={tr('ui.selectWorktree')}
          style={{ minWidth: 220 }}
          options={worktrees.map((w) => ({
            value: w.id,
            label: `${w.name} (#${w.id})`,
          }))}
          onChange={(value) =>
            confirmDirty(() => {
              setTabs([]);
              setActive('');
              setDirectory('');
              setOffset(0);
              setGitOffset(0);
              setStale(false);
              setId(value);
              window.history.replaceState(
                null,
                '',
                `${config.baseUrl}workspace?id=${value}`,
              );
            })
          }
        />
        <Button disabled={!id || busy} onClick={() => perform(reload)}>
          {tr('ui.refresh')}
        </Button>
        <Button
          className="workspace-git-toggle"
          onClick={() => setGitOpen(true)}
        >
          Git
        </Button>
      </Space>
      {info?.subscriptions?.length > 0 && (
        <Space>
          <Select
            aria-label={tr('ui.workspaceSubscription')}
            placeholder={tr('ui.subscription')}
            value={subscription || info.subscriptions[0].id}
            options={info.subscriptions.map((s: any) => ({
              value: s.id,
              label: s.name,
            }))}
            onChange={setSubscription}
          />
          <Button
            disabled={busy}
            onClick={() =>
              perform(async () => {
                await request.put(`${config.apiPrefix}subscriptions/run`, [
                  subscription || info.subscriptions[0].id,
                ]);
              })
            }
          >
            {tr('ui.sync')}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              perform(async () => {
                await request.post(
                  `${config.apiPrefix}subscriptions/${
                    subscription || info.subscriptions[0].id
                  }/discovery/apply`,
                  {},
                );
                setStale(false);
                await reload();
              })
            }
          >
            {tr('ui.applyDiscovery')}
          </Button>
        </Space>
      )}
      {info && (
        <p>
          {info.repository.name} / {info.name} ·{' '}
          <Tag>{info.branch || tr('ui.extra.detachedHEAD')}</Tag>
          <code data-testid="workspace-head">{info.head}</code> {tr('ui.ahead')}{' '}
          {info.ahead ?? '—'} {tr('ui.behind')} {info.behind ?? '—'} ·{' '}
          {git.total || 0} {tr('ui.changedUsedBy')} {info.tasks_count}{' '}
          {tr('ui.tasksVariant362')}{' '}
          <a href={`${config.baseUrl}subscription`}>{tr('ui.syncDiscovery')}</a>
        </p>
      )}
      {error && (
        <Alert
          type="error"
          message={
            error === 'WORKTREE_BUSY'
              ? tr('ui.extra.theWorktreeIsInUseByATaskOrSyncTryAgainLater')
              : translateError(error)
          }
          closable
          onClose={() => setError('')}
        />
      )}
      {stale && (
        <Alert
          type="info"
          message={tr('ui.discoveryChangesAvailable')}
          description={
            <span>
              {tr(
                'ui.theFileStructureHasChangedApplyDiscoveryExplicitlyInTheLinkedSubscriptionSavingFilesDoesNotRunTasksA',
              )}{' '}
              <a href={`${config.baseUrl}subscription`}>
                {tr('ui.openSubscription')}
              </a>
            </span>
          }
        />
      )}
      <p>
        {tr(
          'ui.draftsAreStoredOnlyInPageMemoryAndAreLostIfThePageClosesOrTheBrowserCrashesCtrlCmdFToFindCtrlCmdHToR',
        )}
      </p>
      {!!id && (
        <div className="workspace-columns">
          <aside className="workspace-tree">
            <Space wrap>
              <Button
                onClick={() => {
                  setNewPath(directory ? directory + '/' : '');
                  setNewItem('file');
                }}
              >
                {tr('ui.newFile')}
              </Button>
              <Button
                onClick={() => {
                  setNewPath(directory ? directory + '/' : '');
                  setNewItem('directory');
                }}
              >
                {tr('ui.newDirectory')}
              </Button>
            </Space>
            <p>
              <Button
                disabled={!directory}
                onClick={() => {
                  setDirectory(directory.split('/').slice(0, -1).join('/'));
                  setOffset(0);
                }}
              >
                ↑
              </Button>{' '}
              /{directory}
            </p>
            <List
              size="small"
              dataSource={tree.items}
              renderItem={(entry: any) => (
                <List.Item>
                  <div>
                    <Button
                      type="link"
                      onClick={() =>
                        entry.kind === 'directory'
                          ? (setDirectory(entry.path), setOffset(0))
                          : perform(() => open(entry.path))
                      }
                    >
                      {entry.kind === 'directory' ? '📁 ' : ''}
                      {entry.name}
                    </Button>
                    {entry.kind === 'special' && <Tag>{tr('ui.special')}</Tag>}
                    {entry.kind !== 'symlink' && entry.kind !== 'special' && (
                      <Space>
                        <Button
                          size="small"
                          onClick={() =>
                            perform(async () => {
                              setRename({
                                ...entry,
                                expected_hash: await entryIdentity(entry),
                              });
                              setDestination(entry.path);
                            })
                          }
                        >
                          {tr('ui.rename')}
                        </Button>
                        <Button
                          size="small"
                          danger
                          onClick={() =>
                            perform(async () => {
                              const expected_hash = await entryIdentity(entry);
                              Modal.confirm({
                                title: tr('ui.template.deleteValue', {
                                  p0: entry.path,
                                }),
                                content: tr(
                                  'ui.extra.onlyFilesOrEmptyDirectoriesCanBeDeleted',
                                ),
                                onOk: () =>
                                  perform(async () => {
                                    await call('delete', '/files', {
                                      path: entry.path,
                                      expected_hash,
                                    });
                                    setTabs((old) =>
                                      old.filter((t) => t.path !== entry.path),
                                    );
                                    setStale(true);
                                    await reload();
                                  }),
                              });
                            })
                          }
                        >
                          {tr('ui.delete')}
                        </Button>
                      </Space>
                    )}
                  </div>
                </List.Item>
              )}
            />
            <Space>
              <Button
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 200))}
              >
                {tr('ui.previous')}
              </Button>
              <Button
                disabled={tree.next === null || tree.next === undefined}
                onClick={() => setOffset(tree.next)}
              >
                {tr('ui.moreFiles')}
              </Button>
            </Space>
            <Input.Search
              aria-label={tr('ui.workspaceSearch')}
              placeholder={tr('ui.searchWorkspace')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onSearch={() =>
                perform(async () =>
                  setResults(
                    await call('get', '/search', {
                      query,
                      content: searchContent,
                    }),
                  ),
                )
              }
            />
            <Select
              value={searchContent ? 'content' : 'filename'}
              onChange={(v) => setSearchContent(v === 'content')}
              options={[
                { value: 'filename', label: tr('ui.filename') },
                { value: 'content', label: tr('ui.content') },
              ]}
            />
            {results && (
              <>
                <p>
                  {results.items.length} {tr('ui.results')}{' '}
                  {results.truncated ? tr('ui.extra.truncated') : ''}
                </p>
                <List
                  size="small"
                  dataSource={results.items}
                  renderItem={(r: any) => (
                    <List.Item>
                      <Button
                        type="link"
                        onClick={() => perform(() => open(r.path))}
                      >
                        {r.path}
                        {r.line ? `:${r.line}` : ''}
                      </Button>
                    </List.Item>
                  )}
                />
              </>
            )}
          </aside>
          <main className="workspace-editor">
            <Tabs
              type="editable-card"
              hideAdd
              activeKey={active}
              onChange={setActive}
              onEdit={(key, action) => {
                if (action === 'remove') close(String(key));
              }}
              items={tabs.map((t) => ({
                key: t.path,
                label: t.path + (t.content !== t.saved ? ' •' : ''),
                children: null,
              }))}
            />
            {tab ? (
              <>
                <Space>
                  <Button
                    type="primary"
                    disabled={
                      busy || !tab.editable || tab.content === tab.saved
                    }
                    onClick={save}
                  >
                    {tr('ui.save')}
                  </Button>
                  <span>
                    {tab.eol} {tr('ui.modeVariant416')} {tab.mode?.toString(8)}
                  </span>
                </Space>
                {tab.error_code && (
                  <Alert message={translateError(tab.error_code)} />
                )}
                <Editor
                  height="65vh"
                  path={`${id}/${tab.path}`}
                  language={
                    languages[tab.path.split('.').pop() || ''] || 'plaintext'
                  }
                  value={tab.content}
                  onChange={(value) =>
                    setTabs((old) =>
                      old.map((t) =>
                        t.path === tab.path
                          ? { ...t, content: value || '' }
                          : t,
                      ),
                    )
                  }
                  options={{
                    readOnly: !tab.editable,
                    minimap: { enabled: false },
                    automaticLayout: true,
                  }}
                />
              </>
            ) : (
              <p>{tr('ui.selectAFileToStartEditing')}</p>
            )}
          </main>
          <aside className="workspace-git">{gitPanel}</aside>
        </div>
      )}
      <Drawer
        title="Git"
        open={gitOpen}
        onClose={() => setGitOpen(false)}
        width="min(100vw, 480px)"
      >
        {gitPanel}
      </Drawer>
      <Modal
        width="90vw"
        title={tr('ui.template.valueDiffValue', {
          p0: diff?.staged ? tr('ui.staged') : tr('ui.working'),
          p1: diff?.path || '',
        })}
        open={!!diff}
        footer={null}
        onCancel={() => setDiff(undefined)}
      >
        {diff?.truncated && (
          <Alert message={tr('ui.diffTruncated256KiB4000Lines')} />
        )}
        <pre
          style={{
            maxHeight: '70vh',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {diff?.text || tr('ui.extra.noDiff')}
        </pre>
      </Modal>
      <Modal
        title={newItem === 'file' ? tr('ui.newFile') : tr('ui.newDirectory')}
        open={!!newItem}
        onCancel={() => setNewItem(null)}
        onOk={() =>
          perform(async () => {
            await call(
              'post',
              newItem === 'file' ? '/files' : '/directories',
              newItem === 'file'
                ? { path: newPath, content: '', must_not_exist: true }
                : { path: newPath },
            );
            setNewItem(null);
            setStale(true);
            await reload();
            if (newItem === 'file') await open(newPath);
          })
        }
      >
        <Input
          aria-label={tr('ui.newPath')}
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
        />
      </Modal>
      <Modal
        title={tr('ui.rename')}
        open={!!rename}
        onCancel={() => setRename(undefined)}
        onOk={() =>
          perform(async () => {
            await call('post', '/rename', {
              path: rename.path,
              destination,
              expected_hash: rename.expected_hash,
            });
            const renamed = (file: string) =>
              file === rename.path || file.startsWith(rename.path + '/')
                ? destination + file.slice(rename.path.length)
                : file;
            setTabs((old) => old.map((t) => ({ ...t, path: renamed(t.path) })));
            setActive(renamed(active));
            setRename(undefined);
            setStale(true);
            await reload();
          })
        }
      >
        <Input
          aria-label={tr('ui.destinationPath')}
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
        />
      </Modal>
    </div>
  );
}
