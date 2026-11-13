import React from 'react';
import { Checkbox, Form, Input, Select } from 'antd';
import { ApiError, call, list, useResource } from '../api';
import { FormDialog, enumOptions, lines, required } from '../components';
import { useText } from '../i18n';
/** Definition changes create an immutable revision; a build is a separate operation. */
export function RuntimeRevision({
  kind,
  current,
  revision,
  onClose,
  onSaved,
}: {
  kind: string;
  current: any;
  revision: any;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useText(),
    runtimes = useResource(`/runtime/${kind}/installations`),
    tools = useResource(kind === 'node' ? '/runtime/node/toolchains' : null);
  return (
    <FormDialog
      title={t('createRevision')}
      initial={{
        ...current,
        ...revision,
        requirements: (revision?.dependencies || [])
          .map((r: any) => r.requirement)
          .join('\n'),
        dependencies: (revision?.dependencies || [])
          .filter((r: any) => r.type !== 'DEV_DEPENDENCY')
          .map((r: any) => `${r.name}@${r.specifier}`)
          .join('\n'),
        dev_dependencies: (revision?.dependencies || [])
          .filter((r: any) => r.type === 'DEV_DEPENDENCY')
          .map((r: any) => `${r.name}@${r.specifier}`)
          .join('\n'),
      }}
      onClose={onClose}
      onSubmit={async (v) => {
        const body: any = {
          expected_version: current.version,
          runtime_id: v.runtime_id,
        };
        if (kind === 'python') body.requirements = lines(v.requirements);
        else {
          const parse = (value: string, type: string) =>
            lines(value).map((value) => {
              const index = value.lastIndexOf('@');
              if (index <= 0)
                throw new ApiError(400, 'NODE_DEPENDENCY_INVALID');
              return {
                name: value.slice(0, index),
                specifier: value.slice(index + 1),
                type,
              };
            });
          Object.assign(body, {
            name: v.name,
            description: v.description || '',
            toolchain_id: v.toolchain_id,
            install_scripts_policy: v.install_scripts_policy,
            production_only: !!v.production_only,
            dependencies: [
              ...parse(v.dependencies, 'DEPENDENCY'),
              ...parse(v.dev_dependencies, 'DEV_DEPENDENCY'),
            ],
          });
        }
        await call(`/runtime/${kind}/environments/${current.id}/revisions`, {
          method: 'POST',
          body,
        });
        await onSaved();
      }}
    >
      <Form.Item name="runtime_id" label={t('runtime')} rules={[required()]}>
        <Select
          options={list(runtimes.data)
            .filter((r: any) => r.state === 'READY')
            .map((r: any) => ({ value: r.id, label: r.version }))}
        />
      </Form.Item>
      {kind === 'node' && (
        <>
          <Form.Item name="name" label={t('name')} rules={[required()]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('description')}>
            <Input />
          </Form.Item>
          <Form.Item
            name="toolchain_id"
            label={t('toolchain')}
            rules={[required()]}
          >
            <Select
              options={list(tools.data)
                .filter((r: any) => r.state === 'READY')
                .map((r: any) => ({
                  value: r.id,
                  label: `${r.manager_type} ${r.version}`,
                }))}
            />
          </Form.Item>
          <Form.Item name="install_scripts_policy" label={t('installScripts')}>
            <Select options={enumOptions(['IGNORE', 'ALLOW'])} />
          </Form.Item>
          <Form.Item name="production_only" valuePropName="checked">
            <Checkbox>{t('productionOnly')}</Checkbox>
          </Form.Item>
          <Form.Item name="dev_dependencies" label={t('devDependencies')}>
            <Input.TextArea rows={5} />
          </Form.Item>
        </>
      )}
      <Form.Item
        name={kind === 'python' ? 'requirements' : 'dependencies'}
        label={t(kind === 'python' ? 'requirements' : 'dependencies')}
      >
        <Input.TextArea rows={9} />
      </Form.Item>
    </FormDialog>
  );
}
