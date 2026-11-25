<script setup lang="ts">
import { computed } from 'vue'
import { compactMoney, position, type Scale } from '../../composables/charts'

/** The shared frame of a time chart: quiet gridlines, one money axis, and labels underneath. */
const props = defineProps<{
  scale: Scale
  currency: string
  /** One per column; an empty string leaves that column unlabeled. */
  labels: string[]
}>()
const lines = computed(() =>
  props.scale.ticks.map((t) => ({
    value: t,
    bottom: position(t, props.scale),
    label: compactMoney(t, props.currency),
  })),
)
</script>

<template>
  <div class="frame">
    <div class="axis" aria-hidden="true">
      <span v-for="l in lines" :key="l.value" :style="{ bottom: `${l.bottom}%` }">{{
        l.label
      }}</span>
    </div>
    <div class="plot">
      <div
        v-for="l in lines"
        :key="l.value"
        class="grid"
        :class="{ zero: l.value === 0 }"
        :style="{ bottom: `${l.bottom}%` }"
        aria-hidden="true"
      />
      <slot />
    </div>
    <div />
    <div class="labels" aria-hidden="true">
      <span v-for="(l, i) in labels" :key="i"
        ><b>{{ l }}</b></span
      >
    </div>
  </div>
</template>

<style scoped>
.frame {
  display: grid;
  grid-template-columns: 52px 1fr;
  grid-template-rows: 220px 22px;
  column-gap: 8px;
  padding-top: 8px;
}
.axis,
.plot {
  position: relative;
}
.axis span {
  position: absolute;
  right: 0;
  transform: translateY(50%);
  font-size: 0.72rem;
  opacity: 0.7;
}
.grid {
  position: absolute;
  left: 0;
  right: 0;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.1);
}
.grid.zero {
  border-bottom-color: rgba(var(--v-theme-on-surface), 0.35);
}
.labels {
  display: flex;
}
.labels span {
  flex: 1;
  min-width: 0;
  display: flex;
  justify-content: center;
}
.labels b {
  font-weight: 400;
  font-size: 0.72rem;
  opacity: 0.7;
  white-space: nowrap;
  padding-top: 4px;
}
</style>
