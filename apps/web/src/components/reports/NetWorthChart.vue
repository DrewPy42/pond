<script setup lang="ts">
import { formatMoney, type NetWorthPoint } from '@pond/shared'
import { computed } from 'vue'
import { axisLabels, niceScale, position } from '../../composables/charts'
import ChartFrame from './ChartFrame.vue'

/** Net worth at the end of each month, as one line. Hover or tab to a month for its figures. */
const props = defineProps<{ points: NetWorthPoint[]; currency: string }>()
const scale = computed(() => niceScale(props.points.map((p) => p.netCents)))
const labels = computed(() => axisLabels(props.points.map((p) => p.date)))
// Each point sits in the middle of its column, so the line, the labels and the hover areas agree.
const x = (i: number) => ((i + 0.5) / props.points.length) * 100
const y = (cents: number) => 100 - position(cents, scale.value)
const path = computed(() =>
  props.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.netCents)}`).join(' '),
)
const money = (cents: number) => formatMoney(cents, props.currency)
</script>

<template>
  <ChartFrame :scale="scale" :currency="currency" :labels="labels">
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <path :d="path" />
    </svg>
    <div class="columns" role="list">
      <div
        v-for="(p, i) in points"
        :key="p.date"
        class="column"
        role="listitem"
        tabindex="0"
        :aria-label="`${p.date}: net worth ${money(p.netCents)}`"
      >
        <span
          class="dot"
          :class="{ last: i === points.length - 1 }"
          :style="{ top: `${y(p.netCents)}%` }"
        />
        <v-tooltip activator="parent" location="top">
          <div class="font-weight-bold">{{ p.date }}</div>
          <div>Net worth: {{ money(p.netCents) }}</div>
          <div>You have: {{ money(p.assetsCents) }}</div>
          <div>You owe: {{ money(p.debtsCents) }}</div>
          <div v-if="p.missing">{{ p.missing }} account(s) had no balance yet</div>
        </v-tooltip>
      </div>
    </div>
  </ChartFrame>
</template>

<style scoped>
svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
path {
  fill: none;
  stroke: rgb(var(--v-theme-chart-1));
  stroke-width: 2px;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
.columns {
  position: absolute;
  inset: 0;
  display: flex;
}
.column {
  flex: 1;
  min-width: 0;
  position: relative;
}
/* A crosshair for the month being read. */
.column:hover,
.column:focus-visible {
  background: linear-gradient(
    to right,
    transparent calc(50% - 0.5px),
    rgba(var(--v-theme-on-surface), 0.35) calc(50% - 0.5px),
    rgba(var(--v-theme-on-surface), 0.35) calc(50% + 0.5px),
    transparent calc(50% + 0.5px)
  );
}
.dot {
  position: absolute;
  left: 50%;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: rgb(var(--v-theme-chart-1));
  box-shadow: 0 0 0 2px rgb(var(--v-theme-surface));
  opacity: 0;
}
.dot.last,
.column:hover .dot,
.column:focus-visible .dot {
  opacity: 1;
}
/* With only one month there is no line, so its point must show. */
.column:only-child .dot {
  opacity: 1;
}
</style>
