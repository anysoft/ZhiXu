import React, { useEffect, useState } from 'react';
import {
  Button,
  Collapse,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
} from 'antd';
import type { FormInstance } from 'antd';
import { t as tr, useLocale } from '@/utils/i18n';
import {
  isProviderFieldVisible,
  providerSchemas,
  ProviderField,
} from './providerSchemas';

export default function ProviderConfigForm({
  provider,
  form,
  validationAttempt = 0,
}: {
  provider: string;
  form: FormInstance;
  validationAttempt?: number;
}) {
  useLocale();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    if (validationAttempt > 0) setAdvancedOpen(true);
  }, [validationAttempt]);
  const values = Form.useWatch('providerConfig', form) || {};
  const schema = providerSchemas[provider];
  if (!schema) return null;
  const renderField = (field: ProviderField) => {
    if (!isProviderFieldVisible(field, values)) return null;
    const label = tr(field.labelKey);
    const placeholder = field.placeholderKey
      ? tr(field.placeholderKey)
      : undefined;
    const extra = field.descriptionKey ? tr(field.descriptionKey) : undefined;
    if (field.type === 'keyValue') {
      return (
        <Form.Item
          key={field.name}
          label={label}
          extra={extra}
          data-testid={`provider-field-${field.name}`}
        >
          <Form.List name={['providerConfig', field.name]}>
            {(rows, { add, remove }) => (
              <>
                {rows.map((row) => (
                  <Space key={row.key} align="baseline" wrap>
                    <Form.Item name={[row.name, 'key']}>
                      <Input
                        aria-label={tr('notifications.form.pairKey')}
                        placeholder={tr('notifications.form.pairKey')}
                        autoComplete="off"
                      />
                    </Form.Item>
                    <Form.Item name={[row.name, 'value']}>
                      <Input.Password
                        aria-label={tr('notifications.form.pairValue')}
                        placeholder={tr('notifications.form.pairValue')}
                        autoComplete="off"
                      />
                    </Form.Item>
                    <Button onClick={() => remove(row.name)}>
                      {tr('notifications.form.removePair')}
                    </Button>
                  </Space>
                ))}
                <Button onClick={() => add({ key: '', value: '' })}>
                  {tr('notifications.form.addPair')}
                </Button>
              </>
            )}
          </Form.List>
          <Form.Item noStyle shouldUpdate>
            {() => (
              <Form.ErrorList
                errors={form.getFieldError(['providerConfig', field.name])}
              />
            )}
          </Form.Item>
        </Form.Item>
      );
    }
    let control: React.ReactNode;
    switch (field.type) {
      case 'password':
        control = (
          <Input.Password
            autoComplete="new-password"
            placeholder={placeholder}
          />
        );
        break;
      case 'textarea':
        control = (
          <Input.TextArea
            autoComplete="off"
            rows={4}
            placeholder={placeholder}
          />
        );
        break;
      case 'number':
        control = (
          <InputNumber
            min={field.min}
            max={field.max}
            precision={0}
            style={{ width: '100%' }}
            placeholder={placeholder}
          />
        );
        break;
      case 'boolean':
        control = <Switch />;
        break;
      case 'select':
        control = (
          <Select
            options={field.options?.map((option) => ({
              value: option.value,
              label: tr(option.labelKey),
            }))}
          />
        );
        break;
      default:
        control = <Input autoComplete="off" placeholder={placeholder} />;
    }
    return (
      <Form.Item
        key={field.name}
        name={['providerConfig', field.name]}
        label={label}
        extra={extra}
        preserve={false}
        valuePropName={field.type === 'boolean' ? 'checked' : 'value'}
        data-testid={`provider-field-${field.name}`}
        rules={
          field.required
            ? [
                {
                  required: true,
                  message: tr('notifications.form.fieldRequired'),
                },
              ]
            : []
        }
      >
        {control}
      </Form.Item>
    );
  };
  const primary = schema.fields.filter((field) => !field.advanced);
  const advanced = schema.fields.filter(
    (field) => field.advanced && isProviderFieldVisible(field, values),
  );
  return (
    <div data-testid="provider-config">
      <p>{tr(schema.descriptionKey)}</p>
      {primary.map(renderField)}
      {advanced.length > 0 && (
        <Collapse
          ghost
          activeKey={advancedOpen ? ['advanced'] : []}
          onChange={(keys) => setAdvancedOpen(keys.length > 0)}
        >
          <Collapse.Panel
            header={tr('notifications.form.advanced')}
            key="advanced"
            forceRender
          >
            {advanced.map(renderField)}
          </Collapse.Panel>
        </Collapse>
      )}
    </div>
  );
}
