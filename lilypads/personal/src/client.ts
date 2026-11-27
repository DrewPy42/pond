import { definePadClient, type PadClientModule } from '@pond/sdk/client'
import BudgetPage from './BudgetPage.vue'
import BudgetWidget from './BudgetWidget.vue'
import GoalsPage from './GoalsPage.vue'
import GoalsWidget from './GoalsWidget.vue'
import TransactionBudget from './TransactionBudget.vue'

/** The web side of the Personal Finance pad: two pages, two dashboard cards, a transaction panel. */
const module: PadClientModule = {
  id: 'personal',
  client: definePadClient({
    sidebar: [
      { title: 'Budget', icon: 'mdi-wallet-outline', path: 'budget' },
      { title: 'Goals', icon: 'mdi-piggy-bank-outline', path: 'goals' },
    ],
    pages: [
      { path: 'budget', component: BudgetPage },
      { path: 'goals', component: GoalsPage },
    ],
    reportPages: [
      {
        title: 'Budget',
        description: 'Budgeted, spent and left for each category, month by month.',
        path: 'budget',
      },
    ],
    widgets: [
      { title: 'Budget this month', component: BudgetWidget },
      { title: 'Goals', component: GoalsWidget },
    ],
    transactionPanels: [{ component: TransactionBudget }],
  }),
}
export default module
