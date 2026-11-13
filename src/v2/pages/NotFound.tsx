import React from 'react';
import { Result, Button } from 'antd';
import { Link } from '@umijs/max';
import { useText } from '../i18n';
export default function NotFoundPage() {
  const t = useText();
  return (
    <Result
      status="404"
      title="404"
      subTitle={t('notFound')}
      extra={
        <Link to="/dashboard">
          <Button type="primary">{t('returnHome')}</Button>
        </Link>
      }
    />
  );
}
