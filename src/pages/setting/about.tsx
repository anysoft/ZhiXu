import { PRODUCT_NAME } from '@/utils/brand';
import { formatDateTime } from '@/utils/format';
import { useLocale as useI18nLocale } from '@/utils/i18n';
import intl from 'react-intl-universal';
import React, { useEffect, useState } from 'react';
import { Typography, Input, Form, Button, message, Descriptions } from 'antd';
import styles from './index.less';
import { SharedContext } from '@/layouts';
import dayjs from 'dayjs';
import logo from '@/assets/zhixu-logo.svg';

const { Link } = Typography;

const About = ({ systemInfo }: { systemInfo: SharedContext['systemInfo'] }) => {
  useI18nLocale();
  return (
    <div className={styles.container}>
      <img alt="logo" style={{ width: 140, marginRight: 20 }} src={logo} />
      <div className={styles.right}>
        <span className={styles.title}>{PRODUCT_NAME}</span>
        <span className={styles.desc}>
          {intl.get(
            '支持python3、javascript、shell、typescript 的定时任务管理面板',
          )}
        </span>
        <Descriptions>
          <Descriptions.Item label={intl.get('版本')} span={3}>
            {systemInfo?.branch === 'develop'
              ? intl.get('开发版')
              : intl.get('正式版')}{' '}
            v{systemInfo.version}
          </Descriptions.Item>
          <Descriptions.Item label={intl.get('更新时间')} span={3}>
            {formatDateTime(systemInfo.publishTime * 1000)}
          </Descriptions.Item>
          <Descriptions.Item label={intl.get('更新日志')} span={3}>
            <Link
              href={`https://raw.githubusercontent.com/anysoft/ZhiXu/develop/version.yaml?t=${Date.now()}`}
              target="_blank"
            >
              {intl.get('查看')}
            </Link>
          </Descriptions.Item>
        </Descriptions>
        <div>
          <Link
            href="https://github.com/anysoft/ZhiXu"
            target="_blank"
            style={{ marginRight: 15 }}
          >
            Github
          </Link>
          <Link
            href="https://t.me/jiao_long"
            target="_blank"
            style={{ marginRight: 15 }}
          >
            {intl.get('Telegram频道')}
          </Link>
          <Link href="https://github.com/anysoft/ZhiXu/issues" target="_blank">
            {intl.get('提交BUG')}
          </Link>
        </div>
      </div>
    </div>
  );
};

export default About;
