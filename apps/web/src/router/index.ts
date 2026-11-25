import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

declare module 'vue-router' {
  interface RouteMeta {
    /** Rendered in the centered auth layout instead of the app shell. */
    layout?: 'auth'
    /** Reachable without a session. */
    public?: boolean
  }
}

/** Core pages. LilyPad routes are mounted here in M5. */
export const coreNav = [
  { path: '/', name: 'dashboard', title: 'Dashboard', icon: 'mdi-view-dashboard-outline' },
  { path: '/accounts', name: 'accounts', title: 'Accounts', icon: 'mdi-bank-outline' },
  {
    path: '/transactions',
    name: 'transactions',
    title: 'Transactions',
    icon: 'mdi-swap-horizontal',
  },
  {
    path: '/categories',
    name: 'categories',
    title: 'Categories',
    icon: 'mdi-tag-multiple-outline',
  },
  { path: '/rules', name: 'rules', title: 'Rules', icon: 'mdi-filter-cog-outline' },
  { path: '/reports', name: 'reports', title: 'Reports', icon: 'mdi-chart-box-outline' },
  { path: '/settings', name: 'settings', title: 'Settings', icon: 'mdi-cog-outline' },
] as const

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: () => import('../views/DashboardView.vue') },
    { path: '/accounts', name: 'accounts', component: () => import('../views/AccountsView.vue') },
    {
      path: '/transactions',
      name: 'transactions',
      component: () => import('../views/TransactionsView.vue'),
    },
    {
      path: '/categories',
      name: 'categories',
      component: () => import('../views/CategoriesView.vue'),
    },
    { path: '/rules', name: 'rules', component: () => import('../views/RulesView.vue') },
    { path: '/reports', name: 'reports', component: () => import('../views/ReportsView.vue') },
    {
      path: '/p/:padId/:pagePath(.*)*',
      name: 'pad-page',
      component: () => import('../views/PadPageView.vue'),
    },
    { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
    {
      path: '/setup',
      name: 'setup',
      component: () => import('../views/SetupView.vue'),
      meta: { layout: 'auth', public: true },
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
      meta: { layout: 'auth', public: true },
    },
    {
      path: '/security/enroll',
      name: 'enroll-totp',
      component: () => import('../views/EnrollTotpView.vue'),
      meta: { layout: 'auth' },
    },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (!auth.loaded) await auth.load()

  if (!auth.isAuthenticated) {
    if (auth.setupRequired) return to.name === 'setup' ? true : { name: 'setup' }
    if (to.name === 'setup') return { name: 'login' }
    return to.meta.public
      ? true
      : { name: 'login', query: to.fullPath === '/' ? {} : { next: to.fullPath } }
  }
  // Signed in: keep admins on the enrollment page until TOTP is confirmed.
  if (auth.enrollmentRequired && to.name !== 'enroll-totp') return { name: 'enroll-totp' }
  if (to.name === 'login' || to.name === 'setup') return { name: 'dashboard' }
  return true
})

export default router
