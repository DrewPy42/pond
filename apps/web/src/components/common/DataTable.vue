<script setup lang="ts" generic="T extends Record<string, unknown>">
/**
 * The app's one table: consistent headers, loading and empty states, optional server paging,
 * and clickable rows. Cell content comes from `#item.<key>` slots, exactly like Vuetify's.
 */
const props = withDefaults(
  defineProps<{
    headers: {
      title: string
      key: string
      align?: 'start' | 'end' | 'center'
      sortable?: boolean
      width?: string
    }[]
    items: T[]
    total?: number
    loading?: boolean
    paged?: boolean
    itemsPerPage?: number
    emptyText?: string
    clickable?: boolean
  }>(),
  {
    total: undefined,
    loading: false,
    paged: false,
    itemsPerPage: 25,
    emptyText: 'Nothing here yet.',
    clickable: false,
  },
)
const page = defineModel<number>('page', { default: 1 })
const emit = defineEmits<{ 'row-click': [item: T] }>()
</script>

<template>
  <v-data-table-server
    v-model:page="page"
    :headers="headers"
    :items="items"
    :items-length="total ?? items.length"
    :items-per-page="paged ? itemsPerPage : -1"
    :loading="loading"
    :hide-default-footer="!paged"
    :hover="clickable"
    density="comfortable"
    @click:row="(_e: Event, row: { item: T }) => clickable && emit('row-click', row.item)"
  >
    <template v-for="(_, name) in $slots" #[name]="slotData" :key="name">
      <slot :name="name" v-bind="slotData ?? {}" />
    </template>
    <template v-if="!$slots['no-data']" #no-data>
      <div class="pa-6 text-medium-emphasis">{{ props.emptyText }}</div>
    </template>
  </v-data-table-server>
</template>
