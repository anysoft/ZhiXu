import { PRODUCT_NAME } from '@/utils/brand';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import intl from 'react-intl-universal';
import React, { useEffect, useRef, useState } from 'react';
import { Button, Row, Input, Form, Typography, Steps } from 'antd';
import config from '@/utils/config';
import styles from './index.less';
import { request } from '@/utils/http';
import logo from '@/assets/zhixu-logo.svg';

const { Step } = Steps;
const { Link } = Typography;

const Initialization = () => {
  useI18nLocale();
  const [loading, setLoading] = useState(false);
  const [account, setAccount] = useState<Record<string, string>>({});
  const [completed, setCompleted] = useState(false);
  const submitting = useRef(false);
  const [current, setCurrent] = React.useState(0);

  const next = () => {
    setCurrent(current + 1);
  };

  const prev = () => {
    setCurrent(current - 1);
  };

  const submitAccountSetting = (values: Record<string, string>) => {
    setAccount(values);
    next();
  };

  const completeInstallation = () => {
    if (submitting.current || completed) return;
    submitting.current = true;
    setLoading(true);
    request
      .put(`${config.apiPrefix}user/init`, {
        username: account.username,
        password: account.password,
      })
      .then(({ code }) => {
        if (code === 200) {
          setCompleted(true);
          setAccount({});
        }
      })
      .catch(() => {
        /* The HTTP interceptor presents the request error. */
      })
      .finally(() => {
        submitting.current = false;
        setLoading(false);
      });
  };

  useEffect(() => {
    localStorage.removeItem(config.authKey);
  }, []);

  const steps = [
    {
      title: intl.get('欢迎使用'),
      content: (
        <div className={styles.top} style={{ marginTop: 30 }}>
          <div className={styles.header}>
            <span className={styles.title}>
              {intl.get('ui.brandWelcome', { productName: PRODUCT_NAME })}
            </span>
            <span className={styles.desc}>
              {intl.get(
                '支持python3、javascript、shell、typescript 的定时任务管理面板',
              )}
            </span>
          </div>
          <div className={styles.action}>
            <Button
              type="primary"
              onClick={() => {
                next();
              }}
            >
              {intl.get('开始安装')}
            </Button>
          </div>
        </div>
      ),
    },
    {
      title: intl.get('账户设置'),
      content: (
        <Form
          onFinish={submitAccountSetting}
          layout="vertical"
          initialValues={account}
          onValuesChange={(_, values) => setAccount(values)}
        >
          <Form.Item
            label={intl.get('用户名')}
            name="username"
            rules={[{ required: true }]}
            style={{ maxWidth: 350 }}
          >
            <Input placeholder={intl.get('用户名')} />
          </Form.Item>
          <Form.Item
            label={intl.get('密码')}
            name="password"
            rules={[
              { required: true },
              {
                pattern: /^(?!admin$).*$/,
                message: intl.get('密码不能为admin'),
              },
            ]}
            hasFeedback
            style={{ maxWidth: 350 }}
          >
            <Input type="password" placeholder={intl.get('密码')} />
          </Form.Item>
          <Form.Item
            name="confirm"
            label={intl.get('确认密码')}
            dependencies={['password']}
            hasFeedback
            style={{ maxWidth: 350 }}
            rules={[
              {
                required: true,
              },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(
                    new Error(intl.get('您输入的两个密码不匹配！')),
                  );
                },
              }),
            ]}
          >
            <Input.Password placeholder={intl.get('确认密码')} />
          </Form.Item>
          <Button onClick={prev} style={{ marginRight: 12 }}>
            {intl.get('ui.setup.previous')}
          </Button>
          <Button type="primary" htmlType="submit">
            {intl.get('ui.setup.next')}
          </Button>
        </Form>
      ),
    },
    {
      title: completed ? intl.get('完成安装') : intl.get('ui.setup.review'),
      content: !completed ? (
        <div style={{ marginTop: 30 }}>
          <Typography.Paragraph>
            {intl.get('ui.setup.reviewHint')}
          </Typography.Paragraph>
          <Form layout="vertical">
            <Form.Item label={intl.get('用户名')}>
              <Input value={account.username} readOnly />
            </Form.Item>
            <Form.Item label={intl.get('密码')}>
              <Input.Password
                value={account.password}
                readOnly
                visibilityToggle={false}
              />
            </Form.Item>
          </Form>
          <Button onClick={prev} disabled={loading} style={{ marginRight: 12 }}>
            {intl.get('ui.setup.previous')}
          </Button>
          <Button
            type="primary"
            onClick={completeInstallation}
            loading={loading}
          >
            {intl.get('ui.setup.confirm')}
          </Button>
        </div>
      ) : (
        <div className={styles.top} style={{ marginTop: 80 }}>
          <div className={styles.header}>
            <span className={styles.title}>{intl.get('恭喜安装完成！')}</span>
            <Link href="https://github.com/anysoft/ZhiXu" target="_blank">
              Github
            </Link>
            <Link href="https://t.me/jiao_long" target="_blank">
              {intl.get('Telegram频道')}
            </Link>
          </div>
          <div style={{ marginTop: 16 }}>
            <Button
              type="primary"
              onClick={() => {
                window.location.reload();
              }}
            >
              {intl.get('去登录')}
            </Button>
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className={styles.container}>
      <div className={styles.top}>
        <div className={styles.header}>
          <img alt="logo" className={styles.logo} src={logo} />
          <span className={styles.title}>{intl.get('初始化配置')}</span>
        </div>
      </div>
      <div className={styles.main}>
        <Steps
          current={current}
          direction="vertical"
          size="small"
          className={styles['ant-steps']}
        >
          {steps.map((item) => (
            <Step key={item.title} title={item.title} />
          ))}
        </Steps>
        <div className={styles['steps-container']}>
          {steps[current].content}
        </div>
      </div>
    </div>
  );
};

export default Initialization;
