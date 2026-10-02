import { translateEnum, translateError } from '@/utils/i18n';
import { formatDateTime, formatDuration, formatBytes } from '@/utils/format';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import config from '@/utils/config';
import PythonEnvironments from '@/components/PythonEnvironments';
import NodeRuntime from '@/components/NodeRuntime';
const base = `${config.apiPrefix}runtime/python`;
const active = (row: any) => ['QUEUED', 'RUNNING'].includes(row.status);
const bytes = (value?: number) => formatBytes(value);
export default function PythonRuntimePage() {
  useI18nLocale();
  const [provider, setProvider] = useState<any>(),
    [catalog, setCatalog] = useState<string[]>([]),
    [rows, setRows] = useState<any[]>([]),
    [operations, setOperations] = useState<any[]>([]),
    [diagnostics, setDiagnostics] = useState<any>();
  const [install, setInstall] = useState(false),
    [selected, setSelected] = useState<number>(),
    [operation, setOperation] = useState<any>(),
    [log, setLog] = useState<any>(),
    [detail, setDetail] = useState<any>(),
    [submitting, setSubmitting] = useState(false),
    [error, setError] = useState('');
  const [language, setLanguage] = useState('PYTHON');
  const [form] = Form.useForm();
  const load = async () => {
    const responses = await Promise.all(
      ['provider', 'catalog', 'installations', 'operations', 'diagnostics'].map(
        (x) => request.get(`${base}/${x}`),
      ),
    );
    if (responses.some((x) => x.code !== 200))
      throw Error('RUNTIME_READ_FAILED');
    setProvider(responses[0].data);
    setCatalog(responses[1].data.versions);
    setRows(responses[2].data);
    setOperations(
      responses[3].data.filter(
        (x: any) => !x.operation_type.startsWith('NODE_'),
      ),
    );
    setDiagnostics(responses[4].data);
    setError('');
  };
  useEffect(() => {
    let live = true;
    const poll = () =>
      load().catch(() => {
        if (live) setError('RUNTIME_READ_FAILED');
      });
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    const poll = async () => {
      try {
        const [op, output] = await Promise.all([
          request.get(`${base}/operations/${selected}`),
          request.get(`${base}/operations/${selected}/log`),
        ]);
        if (live && op.code === 200 && output.code === 200) {
          setOperation(op.data);
          setLog(output.data);
        }
      } catch {}
    };
    setOperation(undefined);
    setLog(undefined);
    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selected]);
  const perform = async (url: string, payload: any = {}, remove = false) => {
    setSubmitting(true);
    try {
      const result = await request[remove ? 'delete' : 'post'](
        `${base}/${url}`,
        payload,
      );
      if (result.code !== 200) return false;
      if (!url.endsWith('/cancel')) setSelected(result.data.id);
      await load();
      return true;
    } catch {
      message.error(tr('ui.requestFailedCheckTheStatusBeforeRetrying'));
      return false;
    } finally {
      setSubmitting(false);
    }
  };
  const busy = submitting || operations.some(active);
  return (
    <PageContainer
      title={tr('ui.runtime')}
      extra={
        language === 'PYTHON' && (
          <Button
            type="primary"
            disabled={busy || provider?.state !== 'READY'}
            onClick={() => {
              form.resetFields();
              setInstall(true);
            }}
          >
            {tr('ui.installPython')}
          </Button>
        )
      }
    >
      {error && (
        <Alert
          type="error"
          message={translateError(error)}
          action={
            <Button onClick={() => load().catch(() => {})}>
              {tr('ui.retry')}
            </Button>
          }
        />
      )}
      <Tabs
        activeKey={language}
        onChange={setLanguage}
        items={[
          { key: 'PYTHON', label: 'Python' },
          { key: 'NODE', label: 'Node.js' },
        ]}
      />
      {language === 'NODE' && <NodeRuntime onOperation={setSelected} />}
      <div style={{ display: language === 'PYTHON' ? undefined : 'none' }}>
        <Tabs
          defaultActiveKey="versions"
          items={[
            {
              key: 'versions',
              label: tr('ui.versions'),
              children: (
                <>
                  <Card
                    title={tr('ui.pythonProvider')}
                    style={{ marginBottom: 16 }}
                    extra={
                      <Tag>
                        {provider
                          ? translateEnum('runtimeProvider', provider.state)
                          : tr('common.loading')}{' '}
                        · {translateEnum('health', provider?.health)}
                      </Tag>
                    }
                  >
                    <Descriptions size="small" column={2}>
                      <Descriptions.Item label={tr('ui.provider')}>
                        pyenv ·{' '}
                        {provider?.provider_version ??
                          tr('ui.extra.notInstalled')}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr('ui.revision')}>
                        <Typography.Text
                          copyable={!!provider?.provider_revision}
                        >
                          {provider?.provider_revision ?? '—'}
                        </Typography.Text>
                      </Descriptions.Item>
                      <Descriptions.Item label={tr('ui.catalogUpdated')}>
                        {formatDateTime(provider?.last_refresh_at)}
                      </Descriptions.Item>
                      <Descriptions.Item label={tr('ui.lastError')}>
                        {provider?.last_error
                          ? translateError(provider.last_error)
                          : '—'}
                      </Descriptions.Item>
                    </Descriptions>
                    <Space wrap>
                      <Button
                        disabled={busy || provider?.state === 'READY'}
                        onClick={() => perform('provider/setup')}
                      >
                        {tr('ui.configureProvider')}
                      </Button>
                      <Button
                        disabled={busy || !provider?.provider_revision}
                        onClick={() => perform('provider/update')}
                      >
                        {tr('ui.updateProvider')}
                      </Button>
                      <Button
                        disabled={busy || !provider?.provider_revision}
                        onClick={() => perform('provider/verify')}
                      >
                        {tr('ui.verifyProvider')}
                      </Button>
                      <Button
                        disabled={busy || !provider?.provider_revision}
                        onClick={() => perform('provider/catalog')}
                      >
                        {tr('ui.refreshVersionList')}
                      </Button>
                      <Popconfirm
                        title={tr(
                          'ui.fetchTheProviderAgainInstalledPythonVersionsWillBeRetained',
                        )}
                        onConfirm={() => perform('provider/repair')}
                      >
                        <Button disabled={busy}>
                          {tr('ui.repairProvider')}
                        </Button>
                      </Popconfirm>
                    </Space>
                  </Card>
                  <Table
                    rowKey="id"
                    dataSource={rows}
                    pagination={{ pageSize: 10 }}
                    scroll={{ x: 1050 }}
                    columns={[
                      { title: tr('ui.pythonVersion'), dataIndex: 'version' },
                      {
                        title: tr('ui.state'),
                        dataIndex: 'state',
                        render: (value) => (
                          <Tag>
                            {translateEnum('runtimeInstallation', value)}
                          </Tag>
                        ),
                      },
                      {
                        title: tr('ui.health'),
                        dataIndex: 'health',
                        render: (value: unknown) =>
                          translateEnum('health', value),
                      },
                      { title: tr('ui.provider'), render: () => 'pyenv' },
                      {
                        title: tr('ui.installedAt'),
                        dataIndex: 'installed_at',
                        render: (value: any) => formatDateTime(value),
                      },
                      {
                        title: tr('ui.diskUsage'),
                        render: (_, row) =>
                          bytes(row.metadata?.disk_usage_bytes),
                      },
                      {
                        title: tr('ui.action'),
                        render: (_, row) => (
                          <Space wrap>
                            <Button
                              disabled={busy}
                              onClick={() =>
                                perform(`installations/${row.id}/verify`)
                              }
                            >
                              {tr('ui.verifyTest')}
                            </Button>
                            <Button
                              onClick={async () => {
                                const r = await request.get(
                                  `${base}/installations/${row.id}/references`,
                                );
                                if (r.code === 200)
                                  setDetail({ ...row, references: r.data });
                              }}
                            >
                              {tr('ui.details')}
                            </Button>
                            <Popconfirm
                              title={tr(
                                'ui.template.repairPythonValueTheCurrentDirectoryWillBeQuarantinedBeforeReinstalling',
                                { p0: row.version },
                              )}
                              onConfirm={() =>
                                perform(`installations/${row.id}/repair`)
                              }
                            >
                              <Button
                                disabled={busy || provider?.state !== 'READY'}
                              >
                                {tr('ui.repair')}
                              </Button>
                            </Popconfirm>
                            <Popconfirm
                              title={tr(
                                'ui.template.deletePythonValueItsInstallationDirectoryWillBeRemovedReferencedInstallationsCannotBeDeleted',
                                { p0: row.version },
                              )}
                              onConfirm={() =>
                                perform(`installations/${row.id}`, {}, true)
                              }
                            >
                              <Button danger disabled={busy}>
                                {tr('ui.delete')}
                              </Button>
                            </Popconfirm>
                          </Space>
                        ),
                      },
                    ]}
                  />
                  <Card
                    title={tr('ui.runtimeOperations')}
                    style={{ marginTop: 16 }}
                  >
                    <Table
                      rowKey="id"
                      size="small"
                      dataSource={operations}
                      pagination={{ pageSize: 8 }}
                      scroll={{ x: 750 }}
                      columns={[
                        { title: 'ID', dataIndex: 'id' },
                        {
                          title: tr('ui.operation'),
                          dataIndex: 'operation_type',
                          render: (value: unknown) =>
                            translateEnum('runtimeOperationType', value),
                        },
                        {
                          title: tr('ui.status'),
                          dataIndex: 'status',
                          render: (value: unknown) =>
                            translateEnum('runtimeOperation', value),
                        },
                        {
                          title: tr('ui.stage'),
                          dataIndex: 'stage',
                          render: (value: unknown) =>
                            translateEnum('runtimeStage', value),
                        },
                        {
                          title: tr('ui.error'),
                          dataIndex: 'error_code',
                          render: (value: unknown) =>
                            value ? translateError(value) : '—',
                        },
                        {
                          title: tr('ui.action'),
                          render: (_, row) => (
                            <Space>
                              <Button onClick={() => setSelected(row.id)}>
                                {tr('ui.log')}
                              </Button>
                              {active(row) && (
                                <Button
                                  disabled={row.cancel_requested}
                                  onClick={() =>
                                    perform(`operations/${row.id}/cancel`)
                                  }
                                >
                                  {tr('ui.cancel')}
                                </Button>
                              )}
                            </Space>
                          ),
                        },
                      ]}
                    />
                  </Card>
                  <Card
                    title={tr('ui.buildDiagnostics')}
                    style={{ marginTop: 16 }}
                  >
                    <Alert
                      type={
                        diagnostics?.state === 'READY' ? 'success' : 'warning'
                      }
                      message={
                        diagnostics
                          ? translateEnum('runtimeProvider', diagnostics.state)
                          : tr('common.loading')
                      }
                      description={tr(
                        'ui.template.hostValueValueAvailableSpaceValue',
                        {
                          p0: diagnostics?.host_os ?? '—',
                          p1: diagnostics?.architecture ?? '—',
                          p2: bytes(
                            diagnostics?.available_disk_bytes ?? undefined,
                          ),
                        },
                      )}
                    />
                    <p>
                      {diagnostics?.tools?.map((x: any) => (
                        <Tag
                          color={x.available ? 'green' : 'orange'}
                          key={x.name}
                        >
                          {x.name}:{' '}
                          {x.available
                            ? tr('ui.presentation.available')
                            : tr('ui.presentation.missing')}
                        </Tag>
                      ))}
                    </p>
                    <p>
                      {tr('ui.runtimeWritable')}{' '}
                      {tr(
                        diagnostics?.runtime_root_writable
                          ? 'common.yes'
                          : 'common.no',
                      )}{' '}
                      {tr('ui.cacheWritable')}{' '}
                      {tr(
                        diagnostics?.cache_writable
                          ? 'common.yes'
                          : 'common.no',
                      )}
                    </p>
                    {diagnostics?.missing_requirements?.length > 0 && (
                      <Alert
                        type="warning"
                        message={diagnostics.missing_requirements.join(', ')}
                      />
                    )}
                    {diagnostics?.filesystem?.orphans?.length > 0 && (
                      <Alert
                        type="warning"
                        message={tr(
                          'ui.unregisteredDirectoriesFoundReviewThemManuallyThePlatformHasNotAdoptedThem',
                        )}
                        description={diagnostics.filesystem.orphans
                          .map(
                            (x: any) =>
                              x.version ?? tr('ui.extra.unknownEntry'),
                          )
                          .join(', ')}
                      />
                    )}
                    <Typography.Paragraph type="secondary">
                      {tr(
                        'ui.compilationRequiresNativeToolsAndDevelopmentLibrariesCheckBuildLogsForMissingRequirementsThePlatform',
                      )}
                    </Typography.Paragraph>
                  </Card>
                </>
              ),
            },
            {
              key: 'environments',
              label: tr('ui.environments'),
              children: (
                <PythonEnvironments
                  runtimes={rows}
                  busy={busy}
                  onOperation={setSelected}
                />
              ),
            },
          ]}
        />
      </div>
      <Modal
        title={tr('ui.installPython')}
        open={install}
        confirmLoading={submitting}
        onCancel={() => setInstall(false)}
        onOk={async () => {
          try {
            const values = await form.validateFields();
            if (await perform('installations', values)) setInstall(false);
          } catch {}
        }}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ jobs: 4, timeout_seconds: 3600 }}
        >
          <Form.Item
            name="version"
            label={tr('ui.exactPythonVersion')}
            rules={[{ required: true }]}
          >
            <Select
              showSearch
              options={catalog.map((value) => ({
                value,
                label: value,
                disabled: rows.some((x) => x.version === value),
              }))}
            />
          </Form.Item>
          <Form.Item
            name="jobs"
            label={tr('ui.buildJobs')}
            rules={[{ required: true }]}
          >
            <InputNumber min={1} max={16} />
          </Form.Item>
          <Form.Item
            name="timeout_seconds"
            label={tr('ui.timeoutSeconds')}
            rules={[{ required: true }]}
          >
            <InputNumber min={1} max={7200} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={tr('ui.template.runtimeOperationValue', { p0: selected ?? '' })}
        zIndex={1200}
        open={!!selected}
        onCancel={() => setSelected(undefined)}
        footer={null}
        width={900}
      >
        <p>
          {translateEnum('runtimeOperationType', operation?.operation_type)} ·{' '}
          {translateEnum('runtimeOperation', operation?.status)} ·{' '}
          {translateEnum('runtimeStage', operation?.stage)} {tr('ui.exit')}{' '}
          {operation?.exit_code ?? '—'}
        </p>
        {operation?.error_code && (
          <Alert
            type="warning"
            message={translateError(operation.error_code)}
          />
        )}
        {operation && active(operation) && (
          <Button
            disabled={operation.cancel_requested}
            onClick={() => perform(`operations/${operation.id}/cancel`)}
          >
            {tr('ui.cancelOperation')}
          </Button>
        )}
        {log?.truncated && (
          <Alert
            type="info"
            message={tr('ui.showingTheLast64KiBThePlatformRetainsTheFullLog')}
          />
        )}
        <pre
          aria-label={tr('ui.runtimeOperationLog')}
          style={{
            maxHeight: '55vh',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            padding: 12,
            background: '#111',
            color: '#ddd',
          }}
        >
          {log?.text ?? tr('ui.extra.loadingLogs')}
        </pre>
      </Modal>
      <Modal
        title={`Python ${detail?.version ?? ''}`}
        open={!!detail}
        onCancel={() => setDetail(undefined)}
        footer={null}
        width={760}
      >
        <Descriptions column={1} bordered>
          <Descriptions.Item label={tr('ui.stateHealth')}>
            {translateEnum('runtimeInstallation', detail?.state)} /{' '}
            {translateEnum('health', detail?.health)}
          </Descriptions.Item>
          <Descriptions.Item label={tr('ui.verifiedAt')}>
            {formatDateTime(detail?.verified_at)}
          </Descriptions.Item>
          <Descriptions.Item label={tr('ui.providerRevision')}>
            {detail?.metadata?.provider_revision}
          </Descriptions.Item>
          <Descriptions.Item label={tr('ui.buildTimestamp')}>
            {formatDateTime(detail?.metadata?.build_timestamp)}
          </Descriptions.Item>
          <Descriptions.Item label={tr('ui.platformArchitecture')}>
            {detail?.metadata?.platform} / {detail?.metadata?.architecture}
          </Descriptions.Item>
          <Descriptions.Item label={tr('ui.references')}>
            {detail?.references?.count ?? 0}
          </Descriptions.Item>
          <Descriptions.Item label={tr('ui.lastError')}>
            {detail?.last_error ? translateError(detail.last_error) : '—'}
          </Descriptions.Item>
        </Descriptions>
      </Modal>
    </PageContainer>
  );
}
