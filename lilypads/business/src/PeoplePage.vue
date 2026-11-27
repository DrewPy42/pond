<script setup lang="ts">
import { usePadHost } from '@pond/sdk/client'
import { formatMoney } from '@pond/shared'
import { computed, onMounted, ref } from 'vue'
import { today } from './logic'
import MoneyField from './MoneyField.vue'
import RevealTaxId from './RevealTaxId.vue'
import TaxIdInput from './TaxIdInput.vue'
import { PAY_PERIODS, RELATIONSHIPS, labelOf, type PayView, type PersonView } from './types'
import { items } from './ui'

const host = usePadHost()
const people = ref<PersonView[]>([])
const loading = ref(true)
const error = ref('')
const former = (p: PersonView) => !!p.endDate && p.endDate < today()

async function load() {
  try {
    people.value = (await host.api.get<{ people: PersonView[] }>('/people')).people
    error.value = ''
  } catch {
    error.value = "Couldn't load people."
  } finally {
    loading.value = false
  }
}

// ----- add or edit -----
const blank = () => ({
  firstName: '',
  lastName: '',
  relationship: 'employee',
  email: '',
  phone: '',
  address: '',
  startDate: '',
  endDate: '',
})
const editing = ref(false)
const editId = ref<string | null>(null)
const form = ref(blank())
const taxId = ref<string | null | undefined>(undefined)
const onFile = ref<string | null>(null)
const formError = ref('')

function openForm(p?: PersonView) {
  editId.value = p?.id ?? null
  form.value = p
    ? {
        firstName: p.firstName,
        lastName: p.lastName,
        relationship: p.relationship,
        email: p.email ?? '',
        phone: p.phone ?? '',
        address: p.address ?? '',
        startDate: p.startDate ?? '',
        endDate: p.endDate ?? '',
      }
    : blank()
  taxId.value = undefined
  onFile.value = p?.taxIdMasked ?? null
  formError.value = ''
  editing.value = true
}
async function savePerson() {
  const body = {
    ...form.value,
    startDate: form.value.startDate || null,
    endDate: form.value.endDate || null,
    ...(taxId.value === undefined ? {} : { taxId: taxId.value }),
  }
  try {
    if (editId.value) await host.api.put(`/people/${editId.value}`, body)
    else await host.api.post('/people', body)
    editing.value = false
    // The typed number doesn't linger in the page.
    taxId.value = undefined
    await load()
  } catch {
    formError.value =
      "Couldn't save. Check the dates, and that the tax ID has 4 to 30 letters, numbers, spaces or dashes."
  }
}

// ----- one person's details and pay history -----
const openId = ref<string | null>(null)
const selected = computed(() => people.value.find((p) => p.id === openId.value) ?? null)
const pay = ref<PayView[]>([])
const amount = ref<number | null>(null)
const per = ref('year')
const effective = ref(today())
const note = ref('')

async function loadPay() {
  if (!openId.value) return
  pay.value = (await host.api.get<{ pay: PayView[] }>(`/people/${openId.value}/pay`)).pay
}
async function openPerson(p: PersonView) {
  openId.value = p.id
  pay.value = []
  amount.value = null
  note.value = ''
  effective.value = today()
  await loadPay().catch(() => (error.value = "Couldn't load the pay history."))
}
async function addPay() {
  if (!amount.value || amount.value < 1) return
  try {
    await host.api.post(`/people/${openId.value}/pay`, {
      amountCents: amount.value,
      per: per.value,
      effectiveDate: effective.value,
      note: note.value,
    })
    amount.value = null
    note.value = ''
    await loadPay()
  } catch {
    error.value = "Couldn't save the pay record."
  }
}
async function removePay(id: string) {
  try {
    await host.api.del(`/people/${openId.value}/pay/${id}`)
    await loadPay()
  } catch {
    error.value = "Couldn't remove it."
  }
}

// ----- delete -----
const removing = ref<PersonView | null>(null)
async function removePerson() {
  const p = removing.value
  if (!p) return
  try {
    await host.api.del(`/people/${p.id}`)
    removing.value = null
    openId.value = null
    await load()
  } catch {
    error.value = "Couldn't delete this person."
  }
}

onMounted(load)
</script>

<template>
  <div class="d-flex align-center mb-4">
    <h1 class="text-h5 mr-auto">People</h1>
    <v-btn color="primary" prepend-icon="mdi-plus" @click="openForm()">Add a person</v-btn>
  </div>
  <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
    error
  }}</v-alert>
  <v-progress-linear v-if="loading" indeterminate />
  <p v-else-if="people.length === 0" class="text-medium-emphasis">
    Nobody yet. Keep owners, employees and contractors here, with their details and pay history.
  </p>
  <v-list v-else lines="two">
    <v-list-item v-for="p in people" :key="p.id" @click="openPerson(p)">
      <v-list-item-title>{{ p.firstName }} {{ p.lastName }}</v-list-item-title>
      <v-list-item-subtitle>
        {{ labelOf(RELATIONSHIPS, p.relationship) }}<span v-if="former(p)"> · Former</span>
      </v-list-item-subtitle>
    </v-list-item>
  </v-list>

  <v-dialog
    :model-value="!!selected"
    max-width="640"
    scrollable
    @update:model-value="openId = null"
  >
    <v-card v-if="selected" :title="`${selected.firstName} ${selected.lastName}`">
      <v-card-text>
        <div class="text-medium-emphasis mb-2">
          {{ labelOf(RELATIONSHIPS, selected.relationship)
          }}<span v-if="former(selected)"> · Former</span>
        </div>
        <div v-if="selected.email">Email: {{ selected.email }}</div>
        <div v-if="selected.phone">Phone: {{ selected.phone }}</div>
        <div v-if="selected.address">Address: {{ selected.address }}</div>
        <div v-if="selected.startDate">Started: {{ selected.startDate }}</div>
        <div v-if="selected.endDate">Ended: {{ selected.endDate }}</div>
        <div v-if="selected.taxIdMasked" class="mt-1">
          Tax ID:
          <RevealTaxId :masked="selected.taxIdMasked" :path="`/people/${selected.id}/tax-id`" />
        </div>

        <h2 class="text-subtitle-1 font-weight-bold mt-4">Pay history</h2>
        <p class="text-caption text-medium-emphasis">
          A record of pay rates. It isn't payroll, and reports use your actual transactions.
        </p>
        <v-list v-if="pay.length" density="compact">
          <v-list-item v-for="r in pay" :key="r.id" class="px-0">
            <v-list-item-title>
              {{ formatMoney(r.amountCents) }} {{ labelOf(PAY_PERIODS, r.per) }}, from
              {{ r.effectiveDate }}
            </v-list-item-title>
            <v-list-item-subtitle v-if="r.note">{{ r.note }}</v-list-item-subtitle>
            <template #append>
              <v-btn
                icon="mdi-close"
                size="x-small"
                variant="text"
                :aria-label="`Remove the pay record from ${r.effectiveDate}`"
                @click="removePay(r.id)"
              />
            </template>
          </v-list-item>
        </v-list>
        <v-form class="mt-2" @submit.prevent="addPay">
          <v-row dense>
            <v-col cols="12" sm="4"><MoneyField v-model="amount" label="Pay" /></v-col>
            <v-col cols="12" sm="4"
              ><v-select v-model="per" :items="items(PAY_PERIODS)" label="How often"
            /></v-col>
            <v-col cols="12" sm="4"
              ><v-text-field v-model="effective" label="From" type="date"
            /></v-col>
            <v-col cols="12"
              ><v-text-field v-model="note" label="Note (optional)" maxlength="300"
            /></v-col>
          </v-row>
          <v-btn type="submit" variant="tonal" :disabled="!amount || !effective">Add pay</v-btn>
        </v-form>
      </v-card-text>
      <v-card-actions>
        <v-btn color="error" variant="text" @click="removing = selected">Delete</v-btn>
        <v-spacer />
        <v-btn variant="text" @click="openForm(selected)">Edit</v-btn>
        <v-btn variant="text" @click="openId = null">Close</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog v-model="editing" max-width="560" scrollable>
    <v-card :title="editId ? 'Edit person' : 'Add a person'">
      <v-card-text>
        <v-alert v-if="formError" type="error" variant="tonal" density="compact" class="mb-3">{{
          formError
        }}</v-alert>
        <v-text-field v-model="form.firstName" label="First name" maxlength="80" />
        <v-text-field v-model="form.lastName" label="Last name" maxlength="80" />
        <v-select v-model="form.relationship" :items="items(RELATIONSHIPS)" label="They are an" />
        <TaxIdInput v-model="taxId" :on-file="onFile" />
        <v-text-field v-model="form.email" label="Email (optional)" class="mt-3" />
        <v-text-field v-model="form.phone" label="Phone (optional)" />
        <v-text-field v-model="form.address" label="Address (optional)" />
        <v-text-field v-model="form.startDate" label="Start date (optional)" type="date" />
        <v-text-field v-model="form.endDate" label="End date (optional)" type="date" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="editing = false">Cancel</v-btn>
        <v-btn
          color="primary"
          :disabled="!form.firstName.trim() || !form.lastName.trim()"
          @click="savePerson"
          >Save</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog :model-value="!!removing" max-width="420" @update:model-value="removing = null">
    <v-card :title="`Delete ${removing?.firstName ?? ''} ${removing?.lastName ?? ''}?`">
      <v-card-text>
        This also deletes their tax ID, pay history and any documents saved for them. It can't be
        undone. If they've only stopped working with you, add an end date instead.
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="removing = null">Keep</v-btn>
        <v-btn color="error" @click="removePerson">Delete</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
