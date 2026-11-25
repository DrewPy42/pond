<script setup lang="ts">
import { formatMoney, type CashFlowMonth } from '@pond/shared'
import { computed } from 'vue'
import { axisLabels, monthLabel, niceScale, position } from '../../composables/charts'
import ChartFrame from './ChartFrame.vue'

/** Money in and money out, side by side for each month. The table below carries every value. */
const props = defineProps<{ months: CashFlowMonth[]; currency: string }>()
const scale = computed(() => niceScale(props.months.flatMap((m) => [m.inCents, m.outCents])))
const labels = computed(() => axisLabels(props.months.map((m) => m.month)))
// A month where refunds outweighed spending has no bar; the table shows the figure.
const height = (cents: number) => Math.max(0, position(cents, scale.value))
const money = (cents: number) => formatMoney(cents, props.currency)
const describe = (m: CashFlowMonth) =>
  `${monthLabel(m.month, true)}: money in ${money(m.inCents)}, money out ${money(m.outCents)}, difference ${money(m.netCents)}`
</script>

<template>
  <div class="legend mb-1">
    <span><i class="in" aria-hidden="true" /> Money in</span>
    <span><i class="out" aria-hidden="true" /> Money out</span>
  </div>
  <ChartFrame :scale="scale" :currency="currency" :labels="labels">
    <div class="columns" role="list">
      <div
        v-for="m in months"
        :key="m.month"
        class="column"
        role="listitem"
        tabindex="0"
        :aria-label="describe(m)"
      >
        <span class="bar in" :style="{ height: `${height(m.inCents)}%` }" />
        <span class="bar out" :style="{ height: `${height(m.outCents)}%` }" />
        <v-tooltip activator="parent" location="top">
          <div class="font-weight-bold">{{ monthLabel(m.month, true) }}</div>
          <div>Money in: {{ money(m.inCents) }}</div>
          <div>Money out: {{ money(m.outCents) }}</div>
          <div>Difference: {{ money(m.netCents) }}</div>
        </v-tooltip>
      </div>
    </div>
  </ChartFrame>
</template>

<style scoped>
.legend {
  display: flex;
  gap: 16px;
  font-size: 0.85rem;
}
.legend i {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
}
.columns {
  position: absolute;
  inset: 0;
  display: flex;
}
.column {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 2px;
  /* More room between months than between a month's two bars, so pairs read as pairs. */
  padding: 0 4px;
}
@media (max-width: 600px) {
  .column {
    gap: 1px;
    padding: 0 2px;
  }
}
.column:hover,
.column:focus-visible {
  background: rgba(var(--v-theme-on-surface), 0.06);
}
.bar {
  flex: 1;
  max-width: 24px;
  border-radius: 4px 4px 0 0;
}
.in {
  background: rgb(var(--v-theme-chart-1));
}
.out {
  background: rgb(var(--v-theme-chart-2));
}
</style>
