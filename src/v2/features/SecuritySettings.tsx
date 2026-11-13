import React, { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Popconfirm,
  Space,
  Typography,
} from 'antd';
import QRCode from 'qrcode.react';
import { call, setSession, useAction, useResource } from '../api';
import {
  Details,
  ErrorPanel,
  FormDialog,
  State,
  required,
} from '../components';
import { useText } from '../i18n';
function signInAgain() {
  setSession();
  window.location.assign('/login');
}
export function SecuritySettings() {
  const t = useText(),
    user = useResource('/user'),
    action = useAction(),
    [editing, setEditing] = useState(false),
    [setup, setSetup] = useState<any>();
  return (
    <>
      <Card title={t('sessionSecurity')}>
        <ErrorPanel error={user.error || action.error} />
        <Details
          values={[
            ['username', user.data?.username],
            [
              'twoFactor',
              <State
                value={user.data?.twoFactorActivated ? 'enabled' : 'disabled'}
              />,
            ],
          ]}
        />
        <Typography.Paragraph className="v2-section">
          {t('sessionHelp')}
        </Typography.Paragraph>
        <Typography.Paragraph>{t('sessionMemory')}</Typography.Paragraph>
        <Space wrap>
          <Button onClick={() => setEditing(true)} disabled={!user.data}>
            {t('changeAccount')}
          </Button>
          {user.data?.twoFactorActivated ? (
            <Popconfirm
              title={t('confirmTwoFactorDisable')}
              onConfirm={() =>
                action.run(async () => {
                  await call('/user/two-factor/deactivate', {
                    method: 'PUT',
                    body: {},
                  });
                  signInAgain();
                })
              }
            >
              <Button danger>{t('disableTwoFactor')}</Button>
            </Popconfirm>
          ) : (
            <Button
              disabled={!user.data}
              loading={action.busy}
              onClick={() =>
                void action.run(async () =>
                  setSetup(await call('/user/two-factor/init')),
                )
              }
            >
              {t('enableTwoFactor')}
            </Button>
          )}
        </Space>
      </Card>
      {editing && (
        <FormDialog
          title={t('changeAccount')}
          initial={{ username: user.data.username, password: '', confirm: '' }}
          onClose={() => setEditing(false)}
          onSubmit={async (v) => {
            await call('/user', {
              method: 'PUT',
              body: { username: v.username, password: v.password },
            });
            signInAgain();
          }}
        >
          <Alert
            className="v2-section"
            type="warning"
            message={t('sessionsRevoked')}
          />
          <Form.Item name="username" label={t('username')} rules={[required()]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item
            name="password"
            label={t('newPassword')}
            rules={[required()]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label={t('passwordConfirm')}
            dependencies={['password']}
            rules={[
              required(),
              ({ getFieldValue }) => ({
                validator: (_, v) =>
                  v === getFieldValue('password')
                    ? Promise.resolve()
                    : Promise.reject(new Error(t('passwordMismatch'))),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </FormDialog>
      )}
      {setup && (
        <FormDialog
          title={t('enableTwoFactor')}
          initial={{ code: '' }}
          onClose={() => setSetup(undefined)}
          onSubmit={async (v) => {
            await call('/user/two-factor/active', {
              method: 'PUT',
              body: { code: v.code },
            });
            setSetup(undefined);
            signInAgain();
          }}
        >
          <Alert type="warning" showIcon message={t('twoFactorSecretHelp')} />
          <Space direction="vertical" className="v2-section">
            <QRCode value={setup.url} size={180} />
            <Typography.Text code copyable>
              {setup.secret}
            </Typography.Text>
          </Space>
          <Form.Item
            name="code"
            label={t('twoFactorCode')}
            rules={[
              required(),
              { pattern: /^\d{6}$/, message: t('twoFactorCodeInvalid') },
            ]}
          >
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
            />
          </Form.Item>
        </FormDialog>
      )}
    </>
  );
}
