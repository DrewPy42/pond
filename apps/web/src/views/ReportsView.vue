<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CashFlowReport from '../components/reports/CashFlowReport.vue'
import NetWorthReport from '../components/reports/NetWorthReport.vue'
import SpendingReport from '../components/reports/SpendingReport.vue'
import { usePadsStore } from '../stores/pads'

const route = useRoute()
const router = useRouter()
const pads = usePadsStore()
const TABS = [
  { key: 'cash-flow', title: 'Cash flow', component: CashFlowReport },
  { key: 'spending', title: 'Spending', component: SpendingReport },
  { key: 'net-worth', title: 'Net worth', component: NetWorthReport },
]
// The chosen report is in the address, so it survives a reload and can be bookmarked.
const tab = computed({
  get: () => (TABS.find((t) => t.key === route.query.report) ?? TABS[0]!).key,
  set: (key: string) => void router.replace({ query: { report: key } }),
})
const current = computed(() => TABS.find((t) => t.key === tab.value)!.component)
</script>

<template>
  <h1 class="text-h5 mb-3">Reports</h1>
  <v-tabs v-model="tab" class="mb-4">
    <v-tab v-for="t in TABS" :key="t.key" :value="t.key" class="px-2 px-sm-4">{{ t.title }}</v-tab>
  </v-tabs>
  <component :is="current" :key="tab" />

  <template v-if="pads.reports.length">
    <h2 class="text-h6 mt-8 mb-2">From your apps</h2>
    <v-row>
      <v-col v-for="r in pads.reports" :key="`${r.padId}/${r.path}`" cols="12" md="6">
        <v-card :to="r.to" variant="outlined">
          <v-card-title class="text-subtitle-1">{{ r.title }}</v-card-title>
          <v-card-subtitle>{{ r.appName }}</v-card-subtitle>
          <v-card-text>{{ r.description }}</v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </template>
</template>
