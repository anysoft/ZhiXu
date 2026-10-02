import { translateEnum, translateError } from '@/utils/i18n';
import { formatDateTime, formatDuration, formatBytes } from '@/utils/format';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import React, { useEffect, useState } from 'react';
import {
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import {
  ScopedVariables,
  TaskEnvironment,
} from '@/components/scoped-environment';
const api = `${config.apiPrefix}scoped-env/`;

export default function ScopedEnvironmentPage() {
  useI18nLocale();
  const params = new URLSearchParams(window.location.search);
  const [repositories, setRepositories] = useState<any[]>([]),
    [tasks, setTasks] = useState<any[]>([]),
    [profiles, setProfiles] = useState<any[]>([]);
  const [repository, setRepository] = useState<number | undefined>(
    Number(params.get('repository')) || undefined,
  );
  const [task, setTask] = useState<number | undefined>(
    Number(params.get('task')) || undefined,
  );
  const [selected, setSelected] = useState<any>(),
    [editor, setEditor] = useState<any>(),
    [clone, setClone] = useState<any>();
  const [form] = Form.useForm(),
    [cloneName, setCloneName] = useState('');
  const load = async () => {
    const [r, t] = await Promise.all([
      request.get(`${api}repositories`),
      request.get(`${api}tasks`),
    ]);
    if (r.code === 200) setRepositories(r.data);
    if (t.code === 200) setTasks(t.data);
  };
  const loadProfiles = async () => {
    if (repository) {
      const r = await request.get(`${api}repositories/${repository}/profiles`);
      if (r.code === 200) setProfiles(r.data);
    }
  };
  useEffect(() => {
    load().catch(() => {});
  }, []);
  useEffect(() => {
    setSelected(undefined);
    loadProfiles().catch(() => {});
  }, [repository]);
  const edit = (row: any = {}) => {
    setEditor(row);
    form.resetFields();
    form.setFieldsValue({
      name: row.name,
      description: row.description || '',
      status: row.status || 'enabled',
    });
  };
  const refresh = async () => {
    await load();
    await loadProfiles();
  };
  return (
    <div style={{ padding: 24 }}>
      <h2>{tr('ui.environmentVariable')}</h2>
      <Tabs
        defaultActiveKey={
          task ? 'tasks' : repository ? 'repositories' : 'global'
        }
        items={[
          {
            key: 'global',
            label: tr('ui.global'),
            children: <ScopedVariables resource="global" id={0} />,
          },
          {
            key: 'repositories',
            label: tr('ui.repository'),
            children: (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Select
                  aria-label={tr('ui.repository')}
                  placeholder={tr('ui.selectRepository')}
                  style={{ width: 420 }}
                  value={repository}
                  onChange={setRepository}
                  options={repositories.map((r) => ({
                    value: r.id,
                    label: tr('ui.template.valueValueProfiles', {
                      p0: r.name,
                      p1: r.profiles_count,
                    }),
                  }))}
                />
                <Button disabled={!repository} onClick={() => edit()}>
                  {tr('ui.createProfile')}
                </Button>
                <Table
                  rowKey="id"
                  dataSource={profiles}
                  columns={[
                    { title: tr('ui.profile'), dataIndex: 'name' },
                    { title: tr('ui.description'), dataIndex: 'description' },
                    {
                      title: tr('ui.status'),
                      dataIndex: 'status',
                      render: (value: unknown) =>
                        translateEnum('credentialState', value),
                    },
                    {
                      title: tr('ui.default'),
                      render: (_: any, r: any) =>
                        r.is_default && <Tag>{tr('ui.default')}</Tag>,
                    },
                    { title: tr('ui.variables'), dataIndex: 'variables_count' },
                    {
                      title: tr('ui.usedBy'),
                      render: (_: any, r: any) =>
                        tr('ui.presentation.references', {
                          a: r.used_by.subscriptions,
                          b: r.used_by.tasks,
                        }),
                    },
                    {
                      title: tr('ui.action'),
                      render: (_: any, r: any) => (
                        <Space wrap>
                          <Button type="link" onClick={() => setSelected(r)}>
                            {tr('ui.variables')}
                          </Button>
                          <Button type="link" onClick={() => edit(r)}>
                            {tr('ui.editProfile')}
                          </Button>
                          <Button
                            type="link"
                            onClick={() => {
                              setClone(r);
                              setCloneName(`${r.name}-copy`);
                            }}
                          >
                            {tr('ui.clone')}
                          </Button>
                          <Button
                            type="link"
                            onClick={async () => {
                              await request.put(`${api}profiles`, {
                                id: r.id,
                                is_default: !r.is_default,
                              });
                              await refresh();
                            }}
                          >
                            {r.is_default
                              ? tr('ui.extra.clearDefault')
                              : tr('ui.extra.setAsDefault')}
                          </Button>
                          <Popconfirm
                            title={tr('ui.deleteThisUnreferencedProfile')}
                            onConfirm={async () => {
                              await request.delete(`${api}profiles/${r.id}`);
                              setSelected(undefined);
                              await refresh();
                            }}
                          >
                            <Button type="link" danger>
                              {tr('ui.deleteProfile')}
                            </Button>
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]}
                />
                {selected && (
                  <>
                    <h3>
                      {selected.name} {tr('ui.variablesVariant414')}
                    </h3>
                    <ScopedVariables
                      key={selected.id}
                      resource="profiles"
                      id={selected.id}
                    />
                  </>
                )}
              </Space>
            ),
          },
          {
            key: 'tasks',
            label: tr('ui.task'),
            children: (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Select
                  aria-label={tr('ui.task')}
                  placeholder={tr('ui.selectTask')}
                  style={{ width: 420 }}
                  value={task}
                  onChange={setTask}
                  options={tasks.map((t) => ({
                    value: t.id,
                    label: tr('ui.template.valueValueOverrides', {
                      p0: t.name || t.id,
                      p1: t.variables_count,
                    }),
                  }))}
                />
                {task && <TaskEnvironment id={task} />}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={tr('ui.profile')}
        open={editor !== undefined}
        destroyOnClose
        onCancel={() => setEditor(undefined)}
        onOk={async () => {
          try {
            const values = await form.validateFields();
            const r = await request[editor.id ? 'put' : 'post'](
              `${api}profiles`,
              {
                ...values,
                ...(editor.id
                  ? { id: editor.id }
                  : { repository_id: repository }),
              },
            );
            if (r.code === 200) {
              setEditor(undefined);
              await refresh();
            }
          } catch {}
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label={tr('ui.profileName')}
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="description" label={tr('ui.description')}>
            <Input.TextArea />
          </Form.Item>
          <Form.Item name="status" label={tr('ui.status')}>
            <Select
              options={[
                { value: 'enabled', label: tr('ui.enabled') },
                { value: 'disabled', label: tr('ui.disabled') },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={tr('ui.cloneProfile')}
        open={!!clone}
        onCancel={() => setClone(undefined)}
        onOk={async () => {
          const r = await request.post(`${api}profiles/${clone.id}/clone`, {
            name: cloneName,
          });
          if (r.code === 200) {
            setClone(undefined);
            await refresh();
          }
        }}
      >
        <Input
          aria-label={tr('ui.cloneName')}
          value={cloneName}
          onChange={(e) => setCloneName(e.target.value)}
        />
      </Modal>
    </div>
  );
}
