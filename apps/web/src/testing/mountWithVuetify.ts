import { mount, type ComponentMountingOptions } from '@vue/test-utils'
import type { Component } from 'vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import { pondLight } from '../plugins/theme'

/** Mounts a component with Pond's Vuetify theme registered, like the real app. */
export function mountWithVuetify<T extends Component>(
  component: T,
  options: ComponentMountingOptions<T> = {},
) {
  const vuetify = createVuetify({
    components,
    directives,
    theme: { defaultTheme: 'light', themes: { light: pondLight } },
  })
  return mount(component, {
    ...options,
    global: { ...(options.global ?? {}), plugins: [vuetify, ...(options.global?.plugins ?? [])] },
  } as ComponentMountingOptions<T>)
}
