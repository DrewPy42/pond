import { createRouter, createWebHistory } from 'vue-router'

/** Core pages. LilyPad routes are mounted here in M5. Auth guards arrive in M1. */
export const coreNav = [
  { path: '/', name: 'dashboard', title: 'Dashboard', icon: 'mdi-view-dashboard-outline' },
  { path: '/accounts', name: 'accounts', title: 'Accounts', icon: 'mdi-bank-outline' },
  {
    path: '/transactions',
    name: 'transactions',
    title: 'Transactions',
    icon: 'mdi-swap-horizontal',
  },
  { path: '/reports', name: 'reports', title: 'Reports', icon: 'mdi-chart-box-outline' },
  { path: '/settings', name: 'settings', title: 'Settings', icon: 'mdi-cog-outline' },
] as const

export default createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'dashboard',
      component: () => import('../views/DashboardView.vue'),
    },
    ...coreNav
      .filter((n) => n.path !== '/')
      .map((n) => ({
        path: n.path,
        name: n.name,
        component: () => import('../views/ComingSoonView.vue'),
        props: { title: n.title },
      })),
  ],
})
