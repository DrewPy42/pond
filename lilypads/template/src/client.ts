import { definePadClient, type PadClientModule } from '@pond/sdk/client'
import NotesPage from './NotesPage.vue'
import NotesWidget from './NotesWidget.vue'
import TransactionNote from './TransactionNote.vue'

/**
 * The web side. A pad adds to the places Pond offers (never replaces core screens): a sidebar entry
 * and page, a dashboard card, and a panel on the transaction dialog. Components reach their server
 * routes only through `usePadHost().api`.
 */
const module: PadClientModule = {
  id: 'template',
  client: definePadClient({
    sidebar: [{ title: 'Notes', icon: 'mdi-note-text-outline', path: 'notes' }],
    pages: [{ path: 'notes', component: NotesPage }],
    widgets: [{ title: 'Notes', component: NotesWidget }],
    transactionPanels: [{ component: TransactionNote }],
  }),
}
export default module
