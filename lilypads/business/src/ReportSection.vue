<script setup lang="ts">
import { formatMoney } from '@pond/shared'
import type { ReportLine } from './types'

defineProps<{ title: string; lines: ReportLine[]; totalCents: number; empty: string }>()
</script>

<template>
  <v-table density="compact" class="mb-4">
    <thead>
      <tr>
        <th class="text-left">{{ title }}</th>
        <th class="text-right">Amount</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="lines.length === 0">
        <td colspan="2" class="text-medium-emphasis">{{ empty }}</td>
      </tr>
      <tr v-for="l in lines" :key="l.categoryId">
        <td>{{ l.name }}</td>
        <td class="text-right">{{ formatMoney(l.cents) }}</td>
      </tr>
      <tr class="font-weight-bold">
        <td>Total {{ title.toLowerCase() }}</td>
        <td class="text-right">{{ formatMoney(totalCents) }}</td>
      </tr>
    </tbody>
  </v-table>
</template>
