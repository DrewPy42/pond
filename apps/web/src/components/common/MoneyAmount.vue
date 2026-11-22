<script setup lang="ts">
import { formatMoney } from '@pond/shared'
import { computed } from 'vue'

/**
 * Shows an amount in integer cents. Direction is never colour alone: a sign and an arrow icon
 * always accompany the colour (CLAUDE.md contrast rule). Positive = money in.
 */
const props = withDefaults(
  defineProps<{ cents: number; currency?: string; plain?: boolean; muted?: boolean }>(),
  { currency: 'USD', plain: false, muted: false },
)

const direction = computed(() => (props.cents > 0 ? 'in' : props.cents < 0 ? 'out' : 'zero'))
// "plain" is for balances and totals: a minus sign for negatives, but no "+" on positives.
const text = computed(() => {
  const abs = formatMoney(Math.abs(props.cents), props.currency)
  if (direction.value === 'out') return `-${abs}`
  return direction.value === 'in' && !props.plain ? `+${abs}` : abs
})
const label = computed(
  () =>
    `${direction.value === 'in' ? 'Money in' : direction.value === 'out' ? 'Money out' : 'Zero'}: ${text.value}`,
)
const icon = computed(() =>
  direction.value === 'in'
    ? 'mdi-arrow-bottom-left'
    : direction.value === 'out'
      ? 'mdi-arrow-top-right'
      : 'mdi-minus',
)
const color = computed(() =>
  props.plain || props.muted || direction.value === 'zero'
    ? ''
    : direction.value === 'in'
      ? 'text-money-in'
      : 'text-money-out',
)
</script>

<template>
  <span :class="['money-amount', color]" :aria-label="label" data-testid="money">
    <v-icon v-if="!plain" :icon="icon" size="x-small" class="mr-1" aria-hidden="true" />
    <span aria-hidden="true">{{ text }}</span>
  </span>
</template>

<style scoped>
.money-amount {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
</style>
