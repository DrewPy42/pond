import { flushPromises } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { mountWithVuetify } from '../../testing/mountWithVuetify'
import MoneyAmount from './MoneyAmount.vue'
import MoneyInput from './MoneyInput.vue'

describe('<MoneyAmount cents currency />', () => {
  /**
   * Function: MoneyAmount (money in)
   * Inputs:   cents = 123456 (USD)
   * Expected: text "+$1,234.56" in the money-in colour class, with a screen-reader label
   *           "Money in: +$1,234.56" (direction is never colour alone)
   */
  it('shows money in with a plus sign and the money-in colour', () => {
    const w = mountWithVuetify(MoneyAmount, { props: { cents: 123456 } })
    expect(w.text()).toBe('+$1,234.56')
    expect(w.classes()).toContain('text-money-in')
    expect(w.attributes('aria-label')).toBe('Money in: +$1,234.56')
  })

  /**
   * Function: MoneyAmount (money out)
   * Inputs:   cents = -500
   * Expected: text "-$5.00" in the money-out colour class; label "Money out: -$5.00"
   */
  it('shows money out with a minus sign and the money-out colour', () => {
    const w = mountWithVuetify(MoneyAmount, { props: { cents: -500 } })
    expect(w.text()).toBe('-$5.00')
    expect(w.classes()).toContain('text-money-out')
    expect(w.attributes('aria-label')).toBe('Money out: -$5.00')
  })

  /**
   * Function: MoneyAmount (zero, plain)
   * Inputs:   cents = 0; cents = -500 with plain; cents = 250000 with plain (a balance)
   * Expected: zero has no colour class; plain removes colour and the icon, keeps the minus sign
   *           on negatives, and shows no "+" on positives
   */
  it('uses no colour for zero or when plain', () => {
    const zero = mountWithVuetify(MoneyAmount, { props: { cents: 0 } })
    expect(zero.classes()).not.toContain('text-money-in')
    expect(zero.classes()).not.toContain('text-money-out')
    const plain = mountWithVuetify(MoneyAmount, { props: { cents: -500, plain: true } })
    expect(plain.classes()).not.toContain('text-money-out')
    expect(plain.text()).toBe('-$5.00')
    expect(plain.find('.v-icon').exists()).toBe(false)
    expect(mountWithVuetify(MoneyAmount, { props: { cents: 250000, plain: true } }).text()).toBe(
      '$2,500.00',
    )
  })
})

describe('<MoneyInput v-model="cents" />', () => {
  /**
   * Function: MoneyInput (typing)
   * Inputs:   the user types "$1,234.50", then "12.3", then clears the box
   * Expected: it emits update:modelValue with 123450, then 1230, then null
   */
  it('emits integer cents as the user types, and null when empty', async () => {
    const w = mountWithVuetify(MoneyInput, { props: { modelValue: null } })
    const input = w.find('input')
    for (const [typed, expected] of [
      ['$1,234.50', 123450],
      ['12.3', 1230],
      ['', null],
    ] as const) {
      await input.setValue(typed)
      expect(w.emitted('update:modelValue')!.at(-1)).toEqual([expected])
    }
  })

  /**
   * Function: MoneyInput (invalid text)
   * Inputs:   "abc", and "1.234" (a fraction of a cent)
   * Expected: emits null (never a guessed number) and shows "Enter an amount like 12.34"
   */
  it('rejects text that is not whole cents', async () => {
    const w = mountWithVuetify(MoneyInput, { props: { modelValue: null } })
    for (const bad of ['abc', '1.234']) {
      await w.find('input').setValue(bad)
      await flushPromises()
      expect(w.emitted('update:modelValue')!.at(-1)).toEqual([null])
      expect(w.text()).toContain('Enter an amount like 12.34')
    }
  })

  /**
   * Function: MoneyInput with allowNegative = false
   * Inputs:   "-5.00"
   * Expected: emits null and asks for a positive amount
   */
  it('can refuse negative amounts', async () => {
    const w = mountWithVuetify(MoneyInput, { props: { modelValue: null, allowNegative: false } })
    await w.find('input').setValue('-5.00')
    await flushPromises()
    expect(w.emitted('update:modelValue')!.at(-1)).toEqual([null])
    expect(w.text()).toContain('positive')
  })

  /**
   * Function: MoneyInput (outside value changes)
   * Inputs:   modelValue 250 set from outside (e.g. a form reset)
   * Expected: the box shows "2.50"
   */
  it('shows a value set from outside', async () => {
    const w = mountWithVuetify(MoneyInput, { props: { modelValue: null } })
    await w.setProps({ modelValue: 250 })
    expect((w.find('input').element as HTMLInputElement).value).toBe('2.50')
  })
})
