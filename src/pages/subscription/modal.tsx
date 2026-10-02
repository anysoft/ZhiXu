import { translateEnum } from '@/utils/i18n';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import DiscoveryPolicy from './discovery';
import intl from 'react-intl-universal';
import React, { useEffect, useState } from 'react';
import {
  Modal,
  message,
  InputNumber,
  Form,
  Radio,
  Select,
  Input,
  Switch,
  Button,
  Alert,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import { TaskEnvironment } from '@/components/scoped-environment';
import CronExpressionParser from 'cron-parser';

const SubscriptionModal = ({
  subscription,
  handleCancel,
}: {
  subscription?: any;
  handleCancel: (updated?: any) => void;
}) => {
  useI18nLocale();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [repositories, setRepositories] = useState<any[]>([]);
  const [refs, setRefs] = useState<string[]>([]);
  const [refsLoading, setRefsLoading] = useState(true);
  const scheduleType = Form.useWatch('schedule_type', form);
  const repositoryId =
    Form.useWatch('repository_id', form) ?? subscription?.repository_id;
  useEffect(() => {
    request
      .get(`${config.apiPrefix}repositories`)
      .then((r) => {
        if (r.code === 200) setRepositories(r.data);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    let current = true;
    setRefs([]);
    setRefsLoading(true);
    const finish = () => {
      if (current) setRefsLoading(false);
    };
    if (repositoryId)
      request
        .get(`${config.apiPrefix}repositories/${repositoryId}/refs`)
        .then((r) => {
          if (current && r.code === 200)
            setRefs(
              (Array.isArray(r.data) ? r.data : [])
                .filter((x: any) => x.type === 'branch')
                .map((x: any) => x.name),
            );
        })
        .catch(() => {})
        .finally(finish);
    else finish();
    return () => {
      current = false;
    };
  }, [repositoryId]);
  const handleOk = async () => {
    const values = await form.validateFields();
    setLoading(true);
    try {
      const payload = {
        ...values,
        ...(subscription ? { id: subscription.id } : {}),
        is_disabled: values.is_disabled ? 1 : 0,
      };
      if (payload.schedule_type === 'crontab') delete payload.interval_schedule;
      else delete payload.schedule;
      const result = await request[subscription ? 'put' : 'post'](
        `${config.apiPrefix}subscriptions`,
        payload,
      );
      if (result.code === 200) {
        message.success(
          subscription
            ? tr('ui.extra.subscriptionUpdated')
            : tr('ui.extra.subscriptionCreated'),
        );
        handleCancel(result.data);
      }
    } finally {
      setLoading(false);
    }
  };
  return (
    <Modal
      title={
        subscription
          ? tr('ui.extra.editSubscription')
          : tr('ui.extra.createSubscription')
      }
      open
      centered
      maskClosable={false}
      onOk={() => handleOk().catch(() => {})}
      onCancel={() => handleCancel()}
      confirmLoading={loading}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          schedule_type: 'crontab',
          ...subscription,
          is_disabled: !!subscription?.is_disabled,
        }}
      >
        <Form.Item
          name="name"
          label={intl.get('名称')}
          rules={[{ required: true }]}
        >
          <Input />
        </Form.Item>
        <Form.Item
          name="repository_id"
          label={tr('ui.repository')}
          rules={[{ required: true }]}
          extra={
            <a href={`${config.baseUrl}repository`}>
              {tr('ui.manageRepositoriesAndCredentials')}
            </a>
          }
        >
          <Select
            showSearch
            optionFilterProp="label"
            options={repositories.map((r) => ({
              value: r.id,
              label: r.name + ' · ' + r.remote_url,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="branch"
          label={tr('ui.branch')}
          extra={tr(
            'ui.branchesOnlyLeaveBlankToUseTheRepositorySDefaultBranch',
          )}
        >
          <Input list="subscription-branches" />
        </Form.Item>
        <datalist id="subscription-branches">
          {refs.map((ref) => (
            <option key={ref} value={ref} />
          ))}
        </datalist>
        <Form.Item name="schedule_type" label={intl.get('定时类型')}>
          <Radio.Group>
            <Radio value="crontab">Cron</Radio>
            <Radio value="interval">{tr('ui.interval')}</Radio>
          </Radio.Group>
        </Form.Item>
        {scheduleType === 'interval' ? (
          <Input.Group compact>
            <Form.Item
              name={['interval_schedule', 'value']}
              label={tr('ui.every')}
              rules={[{ required: true }]}
            >
              <InputNumber min={1} precision={0} />
            </Form.Item>
            <Form.Item
              name={['interval_schedule', 'type']}
              label={tr('ui.unit')}
              rules={[{ required: true }]}
            >
              <Select
                style={{ width: 120 }}
                options={['days', 'hours', 'minutes', 'seconds'].map(
                  (value) => ({
                    value,
                    label: translateEnum('timeUnit', value),
                  }),
                )}
              />
            </Form.Item>
          </Input.Group>
        ) : (
          <Form.Item
            name="schedule"
            label="Cron"
            rules={[
              {
                validator: async (_, value) => {
                  if (value) {
                    try {
                      CronExpressionParser.parse(value);
                    } catch {
                      throw new Error(tr('validation.cron'));
                    }
                  }
                },
              },
            ]}
            extra={tr('ui.leaveBlankForManualRuns')}
          >
            <Input />
          </Form.Item>
        )}
        <Form.Item
          name="is_disabled"
          label={tr('ui.disableVariant535')}
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
      </Form>
      {subscription?.id && (
        <>
          <Button
            loading={loading}
            disabled={refsLoading}
            onClick={async () => {
              setLoading(true);
              try {
                const r = await request.post(
                  `${config.apiPrefix}subscriptions/${subscription.id}/prepare`,
                  {},
                );
                if (r.code === 200)
                  message.success(
                    tr('ui.template.worktreeValueIsReady', {
                      p0: r.data.worktree_id,
                    }),
                  );
              } finally {
                setLoading(false);
              }
            }}
          >
            {tr('ui.prepareSavedSubscription')}
          </Button>
          {subscription.worktree_id && (
            <Alert
              message={tr('ui.worktreeStatus', {
                id: subscription.worktree_id,
                status: subscription.last_sync_state
                  ? translateEnum(
                      'subscriptionState',
                      subscription.last_sync_state,
                    )
                  : tr('ui.extra.notSynced'),
              })}
            />
          )}
          <TaskEnvironment id={subscription.id} subscription />
          <DiscoveryPolicy subscriptionId={subscription.id} />
        </>
      )}
    </Modal>
  );
};
export default SubscriptionModal;
