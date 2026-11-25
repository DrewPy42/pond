import '@mdi/font/css/materialdesignicons.css'
import 'vuetify/styles'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import './contrast.css'
import { pondDark, pondLight } from './theme'

export default createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: 'system',
    themes: { light: pondLight, dark: pondDark },
  },
  defaults: {
    VBtn: { variant: 'flat' },
    // Vuetify makes buttons in card actions text-only, which draws color="primary" as green text
    // on white. Keep them filled; quiet buttons such as Cancel say variant="text".
    VCardActions: { VBtn: { variant: 'flat', slim: false } },
  },
})
