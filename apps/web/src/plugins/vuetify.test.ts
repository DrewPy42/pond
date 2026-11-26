import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { h } from 'vue'
import { VBtn, VCardActions } from 'vuetify/components'
import vuetify from './vuetify'

const inCardActions = (props: Record<string, string>) =>
  mount(
    { render: () => h(VCardActions, null, { default: () => h(VBtn, props, () => 'Save') }) },
    { global: { plugins: [vuetify] } },
  ).get('button')

// Function: Vuetify defaults (apps/web/src/plugins/vuetify.ts)
describe('buttons in card actions', () => {
  // Inputs:   a v-btn with color="primary" and no variant, inside v-card-actions
  // Expected: filled (navy text on green), never green text on the card
  it('fills a coloured button', () => {
    const btn = inCardActions({ color: 'primary' })
    expect(btn.classes()).toContain('v-btn--variant-flat')
    expect(btn.classes()).toContain('bg-primary')
  })

  // Inputs:   a v-btn with variant="text" (such as Cancel), inside v-card-actions
  // Expected: stays a text button
  it('keeps an explicit text button', () => {
    expect(inCardActions({ variant: 'text' }).classes()).toContain('v-btn--variant-text')
  })
})
