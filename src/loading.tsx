import { useLocale as useI18nLocale } from '@/utils/i18n';
import { PageLoading } from '@ant-design/pro-layout';

const NewPageLoading = () => {
  useI18nLocale();
  return <PageLoading delay={1}></PageLoading>;
};

export default NewPageLoading;
