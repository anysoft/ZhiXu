import { PRODUCT_NAME } from '@/utils/brand';
import { formatBytes } from '@/utils/format';
import { t as tr } from '@/utils/i18n';
import {
  getLanguagePreference,
  setLanguagePreference,
  LanguagePreference,
  useLocale,
} from '@/utils/i18n';
import intl from 'react-intl-universal';
import React, { useState, useEffect, useRef } from 'react';
import {
  Button,
  Checkbox,
  InputNumber,
  Form,
  Radio,
  message,
  Input,
  Modal,
  Select,
} from 'antd';
import * as DarkReader from '@umijs/ssr-darkreader';
import config from '@/utils/config';
import { request } from '@/utils/http';
import { SharedContext } from '@/layouts';
import './index.less';
import pick from 'lodash/pick';
import { TIMEZONES } from '@/utils/const';

const dataMap = {
  'panel-title': 'panelTitle',
  'log-remove-frequency': 'logRemoveFrequency',
  timezone: 'timezone',
};

const Other = ({
  systemInfo,
  reloadSystemConfig,
  reloadTheme,
}: Pick<
  SharedContext,
  'reloadSystemConfig' | 'reloadTheme' | 'systemInfo'
>) => {
  useLocale();
  const defaultTheme = localStorage.getItem('zhixu_dark_theme') || 'auto';
  const [systemConfig, setSystemConfig] = useState<{
    panelTitle?: string | null;
    logRemoveFrequency?: number | null;
    timezone?: string | null;
  }>();
  const [form] = Form.useForm();
  const [cleanupLoading, setCleanupLoading] = useState(false);

  const {
    enable: enableDarkMode,
    disable: disableDarkMode,
    exportGeneratedCSS: collectCSS,
    setFetchMethod,
    auto: followSystemColorScheme,
  } = DarkReader || {};

  const themeChange = (e: any) => {
    const _theme = e.target.value;
    localStorage.setItem('zhixu_dark_theme', e.target.value);
    setFetchMethod(fetch);

    if (_theme === 'dark') {
      enableDarkMode({});
    } else if (_theme === 'light') {
      disableDarkMode();
    } else {
      followSystemColorScheme({});
    }
    reloadTheme();
  };

  const handleLangChange = (value: LanguagePreference) =>
    setLanguagePreference(value);

  const getSystemConfig = () => {
    request
      .get(`${config.apiPrefix}system/config`)
      .then(({ code, data }) => {
        if (code === 200 && data.info) {
          setSystemConfig(data.info);
        }
      })
      .catch((error: any) => {
        console.log(error);
      });
  };

  const updateSystemConfig = (path: keyof typeof dataMap) => {
    request
      .put(
        `${config.apiPrefix}system/config/${path}`,
        pick(systemConfig, dataMap[path]),
      )
      .then(({ code, data }) => {
        if (code === 200) {
          message.success(intl.get('更新成功'));
          if (path === 'panel-title') {
            reloadSystemConfig();
          }
        }
      })
      .catch((error: any) => {
        console.log(error);
      });
  };

  const previewStorageCleanup = () => {
    setCleanupLoading(true);
    const payload = {
      logRetentionDays: systemConfig?.logRemoveFrequency || 0,
    };
    request
      .post(`${config.apiPrefix}system/storage-retention/preview`, payload)
      .then(({ code, data }) => {
        if (code !== 200) return;
        Modal.confirm({
          width: 560,
          centered: true,
          title: intl.get('确认清理存储数据'),
          okText: intl.get('确认清理'),
          cancelText: intl.get('取消'),
          okButtonProps: { danger: true },
          content: (
            <div>
              <p>
                {tr('ui.cleanupPreviewSummary', {
                  count: data.files.length,
                  size: formatBytes(data.bytes),
                })}
              </p>
              <p>
                {tr(
                  'ui.runLogsAreRetainedSeparatelyServiceLogRotationManagesSystemLogs',
                )}
              </p>
              <p>{intl.get('此操作不可恢复，请确认已完成必要备份')}</p>
            </div>
          ),
          onOk: () => {
            setCleanupLoading(true);
            return request
              .post(`${config.apiPrefix}system/storage-retention/cleanup`, {
                ...payload,
                confirmation: 'CLEAN',
              })
              .then(({ code }) => {
                if (code === 200) {
                  message.success(intl.get('清理完成'));
                }
              })
              .finally(() => setCleanupLoading(false));
          },
        });
      })
      .finally(() => setCleanupLoading(false));
  };

  useEffect(() => {
    getSystemConfig();
  }, []);

  return (
    <>
      <Form layout="vertical" form={form}>
        <Form.Item
          label={intl.get('主题')}
          name="theme"
          initialValue={defaultTheme}
        >
          <Radio.Group
            onChange={themeChange}
            value={defaultTheme}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button
              value="light"
              style={{ width: 70, textAlign: 'center' }}
            >
              {intl.get('亮色')}
            </Radio.Button>
            <Radio.Button
              value="dark"
              style={{ width: 66, textAlign: 'center' }}
            >
              {intl.get('暗色')}
            </Radio.Button>
            <Radio.Button
              value="auto"
              style={{ width: 129, textAlign: 'center' }}
            >
              {intl.get('跟随系统')}
            </Radio.Button>
          </Radio.Group>
        </Form.Item>
        <Form.Item
          label={intl.get('面板标题')}
          name="panelTitle"
          tooltip={intl.get('ui.brandTitleHelp', { productName: PRODUCT_NAME })}
        >
          <Input.Group compact>
            <Input
              style={{ width: 180 }}
              maxLength={100}
              value={systemConfig?.panelTitle || ''}
              placeholder={intl.get('ui.brandDefaultTitle', { productName: PRODUCT_NAME })}
              onChange={(e) => {
                setSystemConfig({
                  ...systemConfig,
                  panelTitle: e.target.value,
                });
              }}
            />
            <Button
              type="primary"
              onClick={() => {
                updateSystemConfig('panel-title');
              }}
              style={{ width: 84 }}
            >
              {intl.get('确认')}
            </Button>
          </Input.Group>
        </Form.Item>
        <Form.Item
          label={intl.get('日志删除频率')}
          name="frequency"
          tooltip={tr(
            'ui.subscriptionSyncLogRetentionInDaysZeroDisablesCleanupRunLogsAreExcluded',
          )}
        >
          <Input.Group compact>
            <InputNumber
              addonBefore={intl.get('每')}
              addonAfter={intl.get('天')}
              style={{ width: 180 }}
              placeholder={intl.get('未启用')}
              min={0}
              value={systemConfig?.logRemoveFrequency}
              onChange={(value) => {
                setSystemConfig({ ...systemConfig, logRemoveFrequency: value });
              }}
            />
            <Button
              type="primary"
              onClick={() => {
                updateSystemConfig('log-remove-frequency');
              }}
              style={{ width: 84 }}
            >
              {intl.get('确认')}
            </Button>
          </Input.Group>
        </Form.Item>
        <Form.Item
          label={tr('ui.subscriptionSyncLogCleanup')}
          tooltip={tr(
            'ui.previewUsingTheRetentionPeriodAboveZeroDisablesCleanupCheckedHourly',
          )}
        >
          <Button
            danger
            loading={cleanupLoading}
            onClick={previewStorageCleanup}
          >
            {tr('ui.previewCleanup')}
          </Button>
        </Form.Item>
        <Form.Item label={intl.get('时区')} name="timezone">
          <Input.Group compact>
            <Select
              value={systemConfig?.timezone}
              style={{ width: 180 }}
              onChange={(value) => {
                setSystemConfig({ ...systemConfig, timezone: value });
              }}
              options={TIMEZONES.map((timezone) => ({
                value: timezone,
                label: timezone,
              }))}
              showSearch
              filterOption={(input, option) =>
                (option?.value || '')
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
            />
            <Button
              type="primary"
              onClick={() => {
                updateSystemConfig('timezone');
              }}
              style={{ width: 84 }}
            >
              {intl.get('确认')}
            </Button>
          </Input.Group>
        </Form.Item>

        <Form.Item label={intl.get('语言')} htmlFor="language-preference">
          <Select
            id="language-preference"
            aria-label={intl.get('语言')}
            value={getLanguagePreference()}
            style={{ width: 264 }}
            onChange={handleLangChange}
            options={[
              { value: 'system', label: intl.get('跟随系统') },
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en-US', label: 'English' },
            ]}
          />
        </Form.Item>
      </Form>
    </>
  );
};

export default Other;
