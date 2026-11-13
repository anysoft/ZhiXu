import React, { useEffect, useState } from 'react';
import { Outlet, history, useLocation } from '@umijs/max';
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Form,
  Input,
  Layout,
  Menu,
  Select,
  Space,
  Spin,
  Typography,
} from 'antd';
import {
  AppstoreOutlined,
  ArrowLeftOutlined,
  BranchesOutlined,
  CodeOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  LogoutOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  SlidersOutlined,
  BellOutlined,
} from '@ant-design/icons';
import enUS from 'antd/es/locale/en_US';
import zhCN from 'antd/es/locale/zh_CN';
import { ApiError, call, setSession, setCsrf } from './api';
import {
  getLanguagePreference,
  setLanguagePreference,
  useLocale,
  useText,
} from './i18n';
import { ErrorPanel } from './components';
import logo from '../assets/zhixu-logo.svg';
import './style.less';

const navigation = [
  ['/dashboard', 'dashboard', <DashboardOutlined />],
  ['/tasks', 'tasks', <PlayCircleOutlined />],
  ['/runs', 'runs', <FileTextOutlined />],
  ['/workspaces', 'workspaces', <AppstoreOutlined />],
  ['/repository', 'repositories', <BranchesOutlined />],
  ['/runtime-python', 'runtime', <CodeOutlined />],
  ['/env', 'environment', <SlidersOutlined />],
  ['/config', 'config', <DatabaseOutlined />],
  ['/notifications', 'notifications', <BellOutlined />],
  ['/setting', 'settings', <SettingOutlined />],
] as const;
function LanguageSelect() {
  const t = useText();
  return (
    <>
      <label className="v2-sr-only" htmlFor="v2-language-picker">
        {t('languagePreference')}
      </label>
      <Select
        id="v2-language-picker"
        aria-label={t('languagePreference')}
        size="small"
        value={getLanguagePreference()}
        onChange={setLanguagePreference}
        options={[
          { value: 'system', label: t('systemLanguage') },
          { value: 'en-US', label: 'English' },
          { value: 'zh-CN', label: '简体中文' },
        ]}
        style={{ minWidth: 135 }}
      />
    </>
  );
}
export default function V2Application() {
  const locale = useLocale(),
    t = useText(),
    location = useLocation();
  const [user, setUser] = useState<any>(),
    [system, setSystem] = useState<any>(),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<any>();
  const [collapsed, setCollapsed] = useState(false),
    [loggingIn, setLoggingIn] = useState(false);
  const boot = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const initial = await call('/system');
      setSystem(initial);
      if (initial?.mode !== 'v2') {
        setSession();
        setUser(undefined);
        throw new ApiError(503, 'V2_BACKEND_REQUIRED');
      }
      try {
        const current = await call('/user');
        setCsrf(current.csrf_token || '');
        setUser(current);
      } catch (failure: any) {
        if (failure.status !== 401) throw failure;
        setSession();
        setCsrf(initial.csrf_token || '');
        setUser(undefined);
      }
    } catch (failure) {
      setError(failure);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void boot();
  }, []);
  useEffect(() => {
    if (user && ['/', '/login'].includes(location.pathname))
      history.replace('/dashboard');
  }, [user, location.pathname]);
  useEffect(() => {
    document.title = `ZhiXu · ${t(
      navigation.find(([path]) => location.pathname.startsWith(path))?.[1] ||
        'dashboard',
    )}`;
  }, [location.pathname, locale]);
  const login = async (values: any) => {
    if (system?.mode !== 'v2') {
      setError(new ApiError(503, 'V2_BACKEND_REQUIRED'));
      return;
    }
    setLoggingIn(true);
    setError(undefined);
    try {
      if (system?.initialized === false)
        await call('/user/init', {
          method: 'POST',
          body: { username: values.username, password: values.password },
        });
      let session;
      try {
        session = await call('/user/login', {
          method: 'POST',
          body: { username: values.username, password: values.password },
        });
      } catch (failure: any) {
        if (failure.code !== 'TWO_FACTOR_REQUIRED' || !values.code)
          throw failure;
        session = await call('/user/two-factor/login', {
          method: 'PUT',
          body: {
            username: values.username,
            password: values.password,
            code: values.code,
          },
        });
      }
      setSession(session);
      const current = await call('/user');
      setCsrf(current.csrf_token || session.csrf_token);
      setUser(current);
      setSystem(await call('/system'));
    } catch (failure) {
      setError(failure);
    } finally {
      setLoggingIn(false);
    }
  };
  const logout = async () => {
    try {
      await call('/user/logout', { method: 'POST', body: {} });
    } finally {
      setSession();
      setUser(undefined);
      history.replace('/login');
    }
  };
  return (
    <ConfigProvider locale={locale === 'zh-CN' ? zhCN : enUS}>
      {loading ? (
        <div className="v2-boot">
          <Spin size="large" />
        </div>
      ) : !user ? (
        <div className="v2-login">
          <div className="v2-login-language">
            <LanguageSelect />
          </div>
          <Card className="v2-login-card">
            <img src={logo} alt="ZhiXu" />
            <Typography.Title>ZhiXu</Typography.Title>
            <Typography.Paragraph type="secondary">
              {t(system?.initialized === false ? 'setupHelp' : 'loginHelp')}
            </Typography.Paragraph>
            <ErrorPanel error={error} reload={() => void boot()} />
            <Form
              layout="vertical"
              onFinish={login}
              disabled={system?.mode !== 'v2'}
            >
              <Form.Item
                name="username"
                label={t('username')}
                rules={[{ required: true, message: t('required') }]}
              >
                <Input autoComplete="username" autoFocus maxLength={100} />
              </Form.Item>
              <Form.Item
                name="password"
                label={t('password')}
                rules={[{ required: true, message: t('required') }]}
              >
                <Input.Password
                  autoComplete={
                    system?.initialized === false
                      ? 'new-password'
                      : 'current-password'
                  }
                />
              </Form.Item>
              {system?.initialized === false && (
                <Form.Item
                  name="confirm"
                  label={t('passwordConfirm')}
                  dependencies={['password']}
                  rules={[
                    { required: true, message: t('required') },
                    ({ getFieldValue }) => ({
                      validator: (_, value) =>
                        !value || value === getFieldValue('password')
                          ? Promise.resolve()
                          : Promise.reject(new Error(t('passwordMismatch'))),
                    }),
                  ]}
                >
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
              )}
              {system?.initialized !== false && (
                <Form.Item
                  name="code"
                  label={t('twoFactorCode')}
                  extra={t('twoFactorLoginHelp')}
                  rules={[
                    { pattern: /^\d{6}$/, message: t('twoFactorCodeInvalid') },
                  ]}
                >
                  <Input
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={6}
                  />
                </Form.Item>
              )}
              <Button
                type="primary"
                htmlType="submit"
                disabled={system?.mode !== 'v2'}
                loading={loggingIn}
                block
                size="large"
              >
                {t(system?.initialized === false ? 'setup' : 'signIn')}
              </Button>
            </Form>
          </Card>
        </div>
      ) : (
        <Layout className="v2-app">
          <Layout.Sider
            theme="light"
            collapsible
            collapsed={collapsed}
            onCollapse={setCollapsed}
            breakpoint="lg"
            width={236}
          >
            <a
              className="v2-brand"
              href="#"
              onClick={(event) => {
                event.preventDefault();
                history.push('/dashboard');
              }}
            >
              <img src={logo} alt="" />
              {!collapsed && (
                <span>
                  ZhiXu<small>{t('brandSubtitle')}</small>
                </span>
              )}
            </a>
            <Menu
              mode="inline"
              selectedKeys={[
                navigation.find(([path]) =>
                  location.pathname.startsWith(path),
                )?.[0] || '',
              ]}
              items={navigation.map(([key, name, icon]) => ({
                key,
                label: t(name),
                icon,
              }))}
              onClick={({ key }) => history.push(key)}
            />
          </Layout.Sider>
          <Layout>
            <Layout.Header className="v2-topbar">
              <Typography.Text type="secondary">
                {t('instance')} <span className="v2-mode">v2</span>
              </Typography.Text>
              <Space size="middle">
                <LanguageSelect />
                <Typography.Text>{user.username}</Typography.Text>
                <Button
                  type="text"
                  icon={<LogoutOutlined />}
                  onClick={() => void logout()}
                >
                  {t('signOut')}
                </Button>
              </Space>
            </Layout.Header>
            <Layout.Content>
              {system?.ready === false && (
                <Alert
                  showIcon
                  type="warning"
                  message={t('notReady')}
                  className="v2-system-banner"
                />
              )}
              <Outlet context={{ user, system, reloadSystem: boot }} />
            </Layout.Content>
          </Layout>
        </Layout>
      )}
    </ConfigProvider>
  );
}
