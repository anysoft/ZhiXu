/** Selected only by the explicit ZHIXU_FRONTEND_MODE=v2 build. */
export const v2Routes = [
  {
    path: '/',
    component: '@/v2/App',
    layout: false,
    routes: [
      { path: '/', component: '@/v2/pages/Dashboard' },
      { path: '/login', component: '@/v2/pages/Dashboard' },
      { path: '/dashboard', component: '@/v2/pages/Dashboard' },
      { path: '/workspaces', component: '@/v2/pages/Workspaces' },
      { path: '/workspaces/:id', component: '@/v2/pages/Workspace' },
      { path: '/tasks', component: '@/v2/pages/Tasks' },
      { path: '/tasks/:id', component: '@/v2/pages/Task' },
      { path: '/runs', component: '@/v2/pages/Runs' },
      { path: '/runs/:id', component: '@/v2/pages/Run' },
      { path: '/repository', component: '@/v2/pages/Repositories' },
      { path: '/runtime-python', component: '@/v2/pages/Runtime' },
      { path: '/env', component: '@/v2/pages/Environment' },
      { path: '/config', component: '@/v2/pages/Config' },
      { path: '/notifications', component: '@/v2/pages/Notifications' },
      { path: '/setting', component: '@/v2/pages/Settings' },
      { path: '*', component: '@/v2/pages/NotFound' },
    ],
  },
];
