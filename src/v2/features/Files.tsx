import React, { useEffect, useMemo, useRef, useState } from 'react';
import { history, Link } from '@umijs/max';
import {
  Alert,
  Breadcrumb,
  Button,
  Checkbox,
  Form,
  Input,
  List,
  Modal,
  Pagination,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { FileOutlined, FolderOutlined, SaveOutlined } from '@ant-design/icons';
import CodeMirror from '@uiw/react-codemirror';
import { loadLanguage } from '@uiw/codemirror-extensions-langs';
import {
  ApiError,
  FileEntry,
  FileRead,
  WorkspaceDto,
  call,
  query,
  useAction,
  useResource,
} from '../api';
import { ErrorPanel, FormDialog, Reload, State, required } from '../components';
import { useText } from '../i18n';
type Buffer = FileRead & { saved: string; conflict?: boolean };
const language = (name: string): any =>
  ({
    py: 'python',
    js: 'javascript',
    cjs: 'javascript',
    mjs: 'javascript',
    ts: 'typescript',
    sh: 'shell',
    json: 'json',
    md: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
  }[name.split('.').pop() || ''] || null);

export function WorkspaceFiles({
  workspace,
  onChanged,
  onDirty,
}: {
  workspace: WorkspaceDto;
  onChanged: () => void;
  onDirty: (value: boolean) => void;
}) {
  const t = useText(),
    id = workspace.id,
    base = `/workspaces/${id}`;
  const [directory, setDirectory] = useState(''),
    [offset, setOffset] = useState(0),
    [buffers, setBuffers] = useState<Buffer[]>([]),
    [active, setActive] = useState('');
  const [dialog, setDialog] = useState<{ action: string; entry?: FileEntry }>(),
    [search, setSearch] = useState(''),
    [contentSearch, setContentSearch] = useState(false),
    [results, setResults] = useState<any>();
  const resource = useResource<any>(
      workspace.capabilities.read_files
        ? query(base + '/tree', { path: directory, offset, limit: 200 })
        : null,
    ),
    action = useAction();
  const dirty = buffers.some((item) => item.content !== item.saved),
    dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const current = buffers.find((item) => item.path === active),
    live = useRef(true);
  const extensions = useMemo(() => {
    const selected = active && language(active);
    const extension = selected && loadLanguage(selected);
    return extension ? [extension] : [];
  }, [active]);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      onDirty(false);
    };
  }, []);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const unblock = (history as any).block?.((transition: any) => {
      Modal.confirm({
        title: t('discardTitle'),
        content: t('discardHelp'),
        okText: t('confirm'),
        cancelText: t('cancel'),
        onOk: () => {
          unblock?.();
          transition.retry();
        },
      });
    });
    return () => unblock?.();
  }, [dirty, t]);
  const confirmDiscard = (callback: () => void) =>
    dirty
      ? Modal.confirm({
          title: t('discardTitle'),
          content: t('discardHelp'),
          onOk: callback,
          okText: t('confirm'),
          cancelText: t('cancel'),
        })
      : callback();
  const openFile = async (path: string, reload = false) => {
    if (!reload && buffers.some((item) => item.path === path)) {
      setActive(path);
      return;
    }
    const file = await call<FileRead>(query(base + '/files', { path }));
    if (typeof file.content !== 'string')
      throw new ApiError(422, 'WORKSPACE_FILE_NOT_TEXT');
    if (live.current) {
      setBuffers((old) => [
        ...old.filter((item) => item.path !== path),
        { ...file, saved: file.content },
      ]);
      setActive(path);
    }
  };
  const save = () =>
    current &&
    action.run(async () => {
      const captured = { ...current };
      try {
        const result = await call<any>(base + '/files', {
          method: 'PUT',
          body: {
            path: captured.path,
            content: captured.content,
            expected_hash: captured.hash,
          },
        });
        if (live.current)
          setBuffers((old) =>
            old.map((item) =>
              item.path === captured.path
                ? {
                    ...item,
                    hash: result.entry.hash,
                    saved: captured.content,
                    conflict: false,
                  }
                : item,
            ),
          );
        await resource.reload();
        onChanged();
      } catch (error: any) {
        if (error.code === 'WORKSPACE_FILE_CONFLICT' && live.current)
          setBuffers((old) =>
            old.map((item) =>
              item.path === captured.path ? { ...item, conflict: true } : item,
            ),
          );
        throw error;
      }
    });
  const close = (path: string) => {
    const selected = buffers.find((item) => item.path === path),
      perform = () => {
        setBuffers((old) => old.filter((item) => item.path !== path));
        if (active === path)
          setActive(buffers.find((item) => item.path !== path)?.path || '');
      };
    selected && selected.content !== selected.saved
      ? Modal.confirm({
          title: t('discardTitle'),
          onOk: perform,
          okText: t('confirm'),
          cancelText: t('cancel'),
        })
      : perform();
  };
  const mutate = async (values: any) => {
    const selected = dialog!,
      entry = selected.entry;
    if (selected.action === 'file')
      await call(base + '/files', {
        method: 'POST',
        body: {
          path: values.path,
          content: values.content || '',
          must_not_exist: true,
        },
      });
    if (selected.action === 'directory')
      await call(base + '/directories', {
        method: 'POST',
        body: { path: values.path, must_not_exist: true },
      });
    if (selected.action === 'rename' && entry) {
      const identity =
        entry.kind === 'FILE' ? entry.hash : entry.identity_token;
      if (!identity) throw new ApiError(409, 'SOURCE_UNVERIFIED');
      await call(base + '/rename', {
        method: 'POST',
        body: {
          path: entry.path,
          destination: values.destination,
          kind: entry.kind,
          ...(entry.kind === 'FILE'
            ? { expected_hash: identity }
            : { expected_identity: identity }),
        },
      });
      setBuffers((old) =>
        old.filter(
          (item) =>
            item.path !== entry.path && !item.path.startsWith(entry.path + '/'),
        ),
      );
    }
    if (selected.action === 'delete' && entry) {
      if (!entry.hash) throw new ApiError(409, 'SOURCE_UNVERIFIED');
      await call(base + '/files', {
        method: 'DELETE',
        body: { path: entry.path, expected_hash: entry.hash },
      });
      setBuffers((old) => old.filter((item) => item.path !== entry.path));
      if (active === entry.path) setActive('');
    }
    await resource.reload();
    onChanged();
  };
  const writable = workspace.capabilities.write_files;
  return (
    <>
      <div className="v2-toolbar">
        <Space wrap>
          <Button
            disabled={!writable || action.busy}
            onClick={() => setDialog({ action: 'file' })}
          >
            {t('newFile')}
          </Button>
          <Button
            disabled={!writable || action.busy}
            onClick={() => setDialog({ action: 'directory' })}
          >
            {t('newDirectory')}
          </Button>
          <Reload
            onClick={() => void resource.reload()}
            loading={resource.loading}
          />
          {!writable && <Tag>{t('readOnly')}</Tag>}
        </Space>
        <Space wrap>
          <Checkbox
            checked={contentSearch}
            onChange={(event) => setContentSearch(event.target.checked)}
          >
            {t('searchContent')}
          </Checkbox>
          <Input.Search
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onSearch={() =>
              void action.run(async () =>
                setResults(
                  await call(
                    query(base + '/search', {
                      query: search,
                      content: contentSearch,
                      limit: 100,
                    }),
                  ),
                ),
              )
            }
            placeholder={t('search')}
            style={{ width: 230 }}
            disabled={!workspace.capabilities.read_files}
          />
        </Space>
      </div>
      <ErrorPanel error={action.error || resource.error} />
      {results && (
        <List
          size="small"
          bordered
          dataSource={results.matches || []}
          renderItem={(item: any) => (
            <List.Item
              onClick={() => void action.run(() => openFile(item.path))}
              style={{ cursor: 'pointer' }}
            >
              {item.path}
              {item.line ? `:${item.line}` : ''}{' '}
              <Typography.Text type="secondary">{item.preview}</Typography.Text>
            </List.Item>
          )}
        />
      )}
      <div className="v2-editor">
        <div className="v2-file-browser">
          <Breadcrumb>
            <Breadcrumb.Item>
              <Button
                size="small"
                type="link"
                onClick={() => {
                  setDirectory('');
                  setOffset(0);
                }}
              >
                {t('files')}
              </Button>
            </Breadcrumb.Item>
            {directory && <Breadcrumb.Item>{directory}</Breadcrumb.Item>}
          </Breadcrumb>
          {directory && (
            <Button
              size="small"
              block
              onClick={() => {
                setDirectory(directory.split('/').slice(0, -1).join('/'));
                setOffset(0);
              }}
            >
              {t('parentDirectory')}
            </Button>
          )}
          {(resource.data?.entries || []).map((entry: FileEntry) => (
            <div
              key={entry.path}
              className={
                'v2-file-item' + (entry.path === active ? ' active' : '')
              }
            >
              <span
                onClick={() =>
                  entry.kind === 'DIRECTORY'
                    ? (setDirectory(entry.path), setOffset(0))
                    : void action.run(() => openFile(entry.path))
                }
                style={{ flex: 1 }}
              >
                {entry.kind === 'DIRECTORY' ? (
                  <FolderOutlined />
                ) : (
                  <FileOutlined />
                )}{' '}
                {entry.path.split('/').pop()}
              </span>
              <Button
                type="text"
                size="small"
                disabled={!writable}
                aria-label={t('rename') + ' ' + entry.path}
                onClick={() =>
                  confirmDiscard(() => setDialog({ action: 'rename', entry }))
                }
              >
                ↗
              </Button>
              {entry.kind === 'FILE' && (
                <Button
                  type="text"
                  danger
                  size="small"
                  disabled={!writable}
                  aria-label={t('delete') + ' ' + entry.path}
                  onClick={() =>
                    confirmDiscard(() => setDialog({ action: 'delete', entry }))
                  }
                >
                  ×
                </Button>
              )}
            </div>
          ))}
          {resource.data?.total > 200 && (
            <Pagination
              simple
              current={offset / 200 + 1}
              pageSize={200}
              total={resource.data.total}
              onChange={(value) => setOffset((value - 1) * 200)}
            />
          )}
        </div>
        <div className="v2-editor-pane">
          {buffers.length ? (
            <>
              <Tabs
                type="editable-card"
                hideAdd
                activeKey={active}
                onChange={setActive}
                onEdit={(key, operation) =>
                  operation === 'remove' && close(String(key))
                }
                items={buffers.map((item) => ({
                  key: item.path,
                  label: (item.content !== item.saved ? '● ' : '') + item.path,
                  children: null,
                }))}
              />
              {current && (
                <>
                  <div className="v2-editor-bar">
                    <Space wrap>
                      <Typography.Text code>{current.path}</Typography.Text>
                      {current.content !== current.saved && (
                        <Tag color="orange">{t('unsaved')}</Tag>
                      )}
                    </Space>
                    <Space wrap>
                      <Link
                        to={`/tasks?workspace_id=${id}&entrypoint=${encodeURIComponent(
                          current.path,
                        )}`}
                      >
                        {t('createTaskFromFile')}
                      </Link>
                      <Button
                        onClick={() =>
                          confirmDiscard(
                            () =>
                              void action.run(() =>
                                openFile(current.path, true),
                              ),
                          )
                        }
                      >
                        {t('reload')}
                      </Button>
                      <Button
                        type="primary"
                        icon={<SaveOutlined />}
                        loading={action.busy}
                        disabled={
                          !writable ||
                          current.conflict ||
                          current.size_bytes > 2 * 1024 * 1024 ||
                          current.content === current.saved
                        }
                        onClick={() => void save()}
                      >
                        {t('save')}
                      </Button>
                    </Space>
                  </div>
                  {current.conflict && (
                    <Alert
                      type="error"
                      showIcon
                      message={t('fileConflict')}
                      description={t('fileConflictHelp')}
                    />
                  )}
                  {current.size_bytes > 2 * 1024 * 1024 && (
                    <Alert type="info" message={t('fileGuard')} />
                  )}
                  <div data-testid="source-editor">
                    <CodeMirror
                      value={current.content}
                      height="470px"
                      extensions={extensions}
                      editable={
                        writable &&
                        !current.conflict &&
                        current.size_bytes <= 2 * 1024 * 1024
                      }
                      onChange={(value) =>
                        setBuffers((old) =>
                          old.map((item) =>
                            item.path === active
                              ? { ...item, content: value }
                              : item,
                          ),
                        )
                      }
                      basicSetup={{
                        lineNumbers: true,
                        foldGutter: true,
                        highlightActiveLine: true,
                      }}
                    />
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="v2-boot" style={{ height: 450 }}>
              <Typography.Text type="secondary">
                {t('selectFile')}
              </Typography.Text>
            </div>
          )}
        </div>
      </div>
      {dialog && (
        <FormDialog
          title={t(
            dialog.action === 'file'
              ? 'newFile'
              : dialog.action === 'directory'
              ? 'newDirectory'
              : dialog.action,
          )}
          initial={{
            path: directory ? directory + '/' : '',
            destination: dialog.entry?.path,
            content: '',
          }}
          onClose={() => setDialog(undefined)}
          onSubmit={mutate}
        >
          {['file', 'directory'].includes(dialog.action) ? (
            <>
              <Form.Item name="path" label={t('path')} rules={[required()]}>
                <Input />
              </Form.Item>
              {dialog.action === 'file' && (
                <Form.Item name="content" label={t('content')}>
                  <Input.TextArea rows={7} spellCheck={false} />
                </Form.Item>
              )}
            </>
          ) : dialog.action === 'rename' ? (
            <Form.Item
              name="destination"
              label={t('destination')}
              rules={[required()]}
            >
              <Input />
            </Form.Item>
          ) : (
            <Alert
              type="warning"
              showIcon
              message={t('confirmDelete')}
              description={dialog.entry?.path}
            />
          )}
        </FormDialog>
      )}
    </>
  );
}
