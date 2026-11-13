import React, { useState } from 'react';
import { Card, Select, Space, Tabs } from 'antd';
import { list, useResource } from '../api';
import { ErrorPanel, Page } from '../components';
import { useText } from '../i18n';
import { EnvironmentPanel, VariablesEditor } from '../features/Resources';
function Scope({ scope }: { scope: 'workspaces' | 'tasks' }) {
  const t = useText(),
    data = useResource('/' + scope + '?size=200'),
    [id, setId] = useState<number>();
  return (
    <>
      <ErrorPanel error={data.error} />
      <Select
        className="v2-section"
        style={{ width: 360, maxWidth: '100%' }}
        placeholder={t(scope === 'tasks' ? 'task' : 'workspace')}
        value={id}
        onChange={setId}
        options={list(data.data).map((r: any) => ({
          value: r.id,
          label: `${r.name} · #${r.id}`,
        }))}
      />
      {id && (
        <Card className="v2-section">
          <EnvironmentPanel
            key={id}
            scope={scope}
            id={id}
            editable={true}
            onChanged={() => {}}
          />
        </Card>
      )}
    </>
  );
}
export default function EnvironmentPage() {
  const t = useText();
  return (
    <Page title={t('environment')} subtitle={t('envPrecedence')}>
      <Tabs
        destroyInactiveTabPane
        items={[
          {
            key: 'global',
            label: t('global'),
            children: (
              <Card>
                <VariablesEditor
                  global
                  path="/scoped-env/global/variables"
                  onChanged={() => {}}
                />
              </Card>
            ),
          },
          {
            key: 'workspace',
            label: t('workspace'),
            children: <Scope scope="workspaces" />,
          },
          { key: 'task', label: t('task'), children: <Scope scope="tasks" /> },
        ]}
      />
    </Page>
  );
}
