import { t as tr } from '@/utils/i18n';
import intl from 'react-intl-universal';
import { SettingOutlined, DashboardOutlined } from '@ant-design/icons';
import IconFont from '@/components/iconfont';
import { BasicLayoutProps } from '@ant-design/pro-layout';

export default function getDefaultProps(): BasicLayoutProps {
  return {
    route: {
      routes: [
        {
          name: intl.get('登录'),
          path: '/login',
          hideInMenu: true,
          component: '@/pages/login/index',
        },
        {
          name: intl.get('初始化'),
          path: '/initialization',
          hideInMenu: true,
          component: '@/pages/initialization/index',
        },
        {
          name: intl.get('错误'),
          path: '/error',
          hideInMenu: true,
          component: '@/pages/error/index',
        },
        {
          path: '/dashboard',
          name: intl.get('仪表盘'),
          icon: <DashboardOutlined />,
          component: '@/pages/dashboard/index',
        },
        {
          path: '/runs',
          name: tr('ui.runs'),
          icon: <DashboardOutlined />,
          component: '@/pages/runs/index',
        },
        {
          path: '/notifications',
          name: tr('ui.notifications'),
          icon: <SettingOutlined />,
          component: '@/pages/notifications/index',
        },
        {
          path: '/tasks',
          name: tr('ui.tasks'),
          icon: <IconFont type="ql-icon-crontab" />,
          component: '@/pages/tasks/index',
        },
        {
          path: '/subscription',
          name: intl.get('订阅管理'),
          icon: <IconFont type="ql-icon-subs" />,
          component: '@/pages/subscription/index',
        },
        {
          path: '/repository',
          name: tr('ui.repositoriesVariant425'),
          icon: <IconFont type="ql-icon-subs" />,
          component: '@/pages/repository/index',
        },
        {
          path: '/env',
          name: intl.get('环境变量'),
          icon: <IconFont type="ql-icon-env" />,
          component: '@/pages/env/index',
        },
        {
          path: '/config',
          name: tr('ui.extra.configAssets'),
          icon: <IconFont type="ql-icon-config" />,
          component: '@/pages/config/index',
        },
        {
          path: '/workspace',
          name: tr('ui.codeWorkspace'),
          icon: <IconFont type="ql-icon-script" />,
          component: '@/pages/workspace',
        },
        {
          path: '/runtime-python',
          name: tr('ui.runtime'),
          icon: <SettingOutlined />,
          component: '@/pages/runtime-python',
        },
        {
          path: '/log',
          name: intl.get('日志管理'),
          icon: <IconFont type="ql-icon-log" />,
          component: '@/pages/log/index',
        },
        {
          path: '/setting',
          name: intl.get('系统设置'),
          icon: <SettingOutlined />,
          component: '@/pages/password/index',
        },
      ],
    },
    navTheme: 'light',
    fixSiderbar: true,
    contentWidth: 'Fixed',
    splitMenus: false,
    siderWidth: 180,
  } as BasicLayoutProps;
}
