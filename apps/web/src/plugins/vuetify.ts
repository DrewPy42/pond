import '@mdi/font/css/materialdesignicons.css'
import 'vuetify/styles'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
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
  },
})
