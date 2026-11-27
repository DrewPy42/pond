import { definePadClient, type PadClientModule } from '@pond/sdk/client'
import BusinessWidget from './BusinessWidget.vue'
import DocumentsPage from './DocumentsPage.vue'
import PeoplePage from './PeoplePage.vue'
import ProfilePage from './ProfilePage.vue'
import ReportsPage from './ReportsPage.vue'

/** The web side of Business Manager. Everything but reports is shown to Space owners only. */
const module: PadClientModule = {
  id: 'business',
  client: definePadClient({
    sidebar: [
      { title: 'Business reports', icon: 'mdi-file-chart-outline', path: 'reports' },
      { title: 'People', icon: 'mdi-account-group-outline', path: 'people', role: 'owner' },
      { title: 'Documents', icon: 'mdi-folder-outline', path: 'documents', role: 'owner' },
      { title: 'Business profile', icon: 'mdi-briefcase-outline', path: 'profile', role: 'owner' },
    ],
    pages: [
      { path: 'reports', component: ReportsPage },
      { path: 'people', component: PeoplePage, role: 'owner' },
      { path: 'documents', component: DocumentsPage, role: 'owner' },
      { path: 'profile', component: ProfilePage, role: 'owner' },
    ],
    reportPages: [
      {
        title: 'Profit and loss and tax summary',
        description: 'By tax year or any dates, with an export for your accountant.',
        path: 'reports',
      },
    ],
    widgets: [{ title: 'This tax year', component: BusinessWidget }],
  }),
}
export default module
