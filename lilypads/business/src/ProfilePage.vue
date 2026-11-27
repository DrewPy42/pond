<script setup lang="ts">
import { usePadHost } from '@pond/sdk/client'
import { onMounted, ref } from 'vue'
import RevealTaxId from './RevealTaxId.vue'
import TaxIdInput from './TaxIdInput.vue'
import { BUSINESS_TYPES, type ProfileView } from './types'
import { MONTHS, items } from './ui'

const host = usePadHost()
const profile = ref<ProfileView | null>(null)
const taxId = ref<string | null | undefined>(undefined)
const message = ref('')
const error = ref('')
const busy = ref(false)

onMounted(async () => {
  try {
    profile.value = (await host.api.get<{ profile: ProfileView }>('/profile')).profile
  } catch {
    error.value = "Couldn't load the profile."
  }
})

async function save() {
  const p = profile.value
  if (!p) return
  busy.value = true
  message.value = ''
  error.value = ''
  try {
    const body = {
      legalName: p.legalName ?? '',
      businessType: p.businessType,
      address: p.address ?? '',
      phone: p.phone ?? '',
      taxYearStartMonth: p.taxYearStartMonth,
      ...(taxId.value === undefined ? {} : { taxId: taxId.value }),
    }
    profile.value = (await host.api.put<{ profile: ProfileView }>('/profile', body)).profile
    taxId.value = undefined
    message.value = 'Saved.'
  } catch {
    error.value = "Couldn't save. Check the tax ID: 4 to 30 letters, numbers, spaces or dashes."
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <h1 class="text-h5 mb-1">Business profile</h1>
  <p class="text-medium-emphasis mb-4">
    Everything here is optional. Only Space owners can see it.
  </p>
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
    error
  }}</v-alert>
  <v-alert v-if="message" type="success" variant="tonal" density="compact" class="mb-3">{{
    message
  }}</v-alert>
  <v-form v-if="profile" style="max-width: 560px" @submit.prevent="save">
    <v-text-field v-model="profile.legalName" label="Legal name" maxlength="200" />
    <v-select
      v-model="profile.businessType"
      :items="items(BUSINESS_TYPES)"
      label="Kind of business"
      clearable
    />
    <v-select
      v-model="profile.taxYearStartMonth"
      :items="MONTHS"
      label="Tax year starts in"
      hint="Leave it as the first month unless your accountant says otherwise."
      persistent-hint
      class="mb-3"
    />
    <div v-if="profile.taxIdMasked" class="mb-2">
      Tax ID on file: <RevealTaxId :masked="profile.taxIdMasked" path="/profile/tax-id" />
    </div>
    <TaxIdInput v-model="taxId" :on-file="profile.taxIdMasked" />
    <v-textarea v-model="profile.address" label="Address" rows="2" auto-grow class="mt-3" />
    <v-text-field v-model="profile.phone" label="Phone" />
    <v-btn type="submit" color="primary" :loading="busy">Save</v-btn>
  </v-form>
</template>
