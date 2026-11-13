import React, { useState } from 'react';
import { Button, Checkbox, Space, Typography } from 'antd';
import { query, useResource } from '../api';
import { ErrorPanel } from '../components';
import { useText } from '../i18n';
export function Logs({ path }: { path: string }) {
  const t = useText(),
    [cursor, setCursor] = useState<string>(),
    [live, setLive] = useState(true),
    resource = useResource(
      query(path, { cursor, limit_bytes: 65536 }),
      live ? 2000 : 0,
    );
  return (
    <>
      <div className="v2-toolbar">
        <Space>
          <Checkbox
            checked={live}
            onChange={(event) => setLive(event.target.checked)}
          >
            {t('live')}
          </Checkbox>
          <Button
            onClick={() => {
              setCursor(undefined);
              void resource.reload();
            }}
          >
            {t('refresh')}
          </Button>
        </Space>
        <Button
          disabled={
            !resource.data?.next_cursor || resource.data.next_cursor === cursor
          }
          onClick={() => setCursor(resource.data.next_cursor)}
        >
          {t('nextPage')}
        </Button>
      </div>
      <ErrorPanel error={resource.error} />
      <pre className="v2-log" data-testid="run-log">
        {resource.data?.text || t(resource.loading ? 'loading' : 'empty')}
      </pre>
      {resource.data?.truncated && (
        <Typography.Text type="secondary">{t('logsTruncated')}</Typography.Text>
      )}
    </>
  );
}
