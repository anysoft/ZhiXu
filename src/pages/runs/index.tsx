import { useLocale as useI18nLocale } from '@/utils/i18n';
import { t as tr } from '@/utils/i18n';
import React, { useState } from 'react';
import { Card } from 'antd';
import { RunsTable, RunDetail } from '@/components/observability';
export default function RunsPage() {
  useI18nLocale();
  const [id, setId] = useState<number | undefined>(() => {
    const n = Number(new URLSearchParams(location.search).get('run'));
    return n > 0 ? n : undefined;
  });
  return (
    <Card title={tr('ui.runs')}>
      <RunsTable />
      <RunDetail id={id} onClose={() => setId(undefined)} />
    </Card>
  );
}
