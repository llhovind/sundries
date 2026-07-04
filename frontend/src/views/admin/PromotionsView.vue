<script setup>
import { ref, reactive, onMounted } from 'vue';
import { usePromotionsStore } from '@/stores/promotions';
import { apiErrorMessage } from '@/stores/storeUtils';
import { fixedNum } from '@/composables/utils';
import TableComponent from '@/components/TableComponent.vue';

const store = usePromotionsStore();
onMounted(() => store.getAll().catch(() => {}));

const displayFields = ['code', 'name', 'promo_type', 'starts_at', 'redemption_count', 'status'];

const mutationError = ref('');
const showCreate    = ref(false);

const blank = () => ({ code: '', name: '', promo_type: 'percent', value: 10,
                       starts_at: '', ends_at: '', max_redemptions: null, status: 'active' });
const form = reactive(blank());

async function create() {
    mutationError.value = '';
    try {
        const body = { ...form };
        if (!body.starts_at) delete body.starts_at;
        if (!body.ends_at)   delete body.ends_at;
        if (body.max_redemptions == null || body.max_redemptions === '') delete body.max_redemptions;
        await store.createPromotion(body);
        showCreate.value = false;
        Object.assign(form, blank());
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Create failed');
    }
}

async function toggleStatus(promo) {
    mutationError.value = '';
    try {
        await store.togglePromotionStatus(promo);
    } catch (err) {
        mutationError.value = apiErrorMessage(err, 'Status update failed');
    }
}

function fmtValue(p) {
    if (p.promo_type === 'percent')       return p.value + '% off';
    if (p.promo_type === 'fixed_amount')  return '$ ' + fixedNum(p.value, 2) + ' off';
    return 'Free shipping';
}

function fmtDate(val) { return val ? new Date(val).toLocaleDateString() : null; }
</script>

<template>
  <div class="view">
    <div class="view-header">
      <h2>Promotions</h2>
      <button class="btn btn-primary" @click="showCreate = !showCreate">+ New code</button>
    </div>

    <div v-if="store.error || mutationError" class="error">{{ store.error || mutationError }}</div>

    <div v-if="showCreate" class="card create">
      <div class="inline-form">
        <input v-model="form.code" class="input" type="text" placeholder="CODE *" />
        <input v-model="form.name" class="input" type="text" placeholder="Name *" />
        <select v-model="form.promo_type" class="input">
          <option value="percent">Percent off</option>
          <option value="fixed_amount">Fixed amount off</option>
          <option value="free_shipping">Free shipping</option>
        </select>
        <input v-if="form.promo_type !== 'free_shipping'" v-model.number="form.value"
               class="input num" type="number" step="0.01" placeholder="Value" />
        <input v-model="form.starts_at" class="input" type="date" title="Starts" />
        <input v-model="form.ends_at" class="input" type="date" title="Ends" />
        <input v-model.number="form.max_redemptions" class="input num" type="number" placeholder="Max uses" />
        <button class="btn btn-primary" :disabled="!form.code || !form.name" @click="create">Create</button>
      </div>
    </div>

    <TableComponent
      :store="store"
      :rows="store.promotions"
      :displayFields="displayFields"
      rowKey="promo_no"
      label="Promotions Found"
    >
      <template #cell-code="{ row }">
        <strong>{{ row.code }}</strong>
      </template>

      <template #cell-promo_type="{ row }">
        {{ fmtValue(row) }}
      </template>

      <template #cell-starts_at="{ row }">
        <span class="muted">{{ fmtDate(row.starts_at) || '—' }} → {{ fmtDate(row.ends_at) || '∞' }}</span>
      </template>

      <template #cell-redemption_count="{ row }">
        {{ row.redemption_count }}{{ row.max_redemptions != null ? ' / ' + row.max_redemptions : '' }}
      </template>

      <template #cell-status="{ row }">
        <span class="pill" :class="row.status === 'active' ? 'ok' : ''">{{ row.status }}</span>
      </template>

      <template #row-actions="{ row }">
        <button class="btn mini" @click="toggleStatus(row)">
          {{ row.status === 'active' ? 'Disable' : 'Enable' }}
        </button>
      </template>

      <template #empty>No promotions found.</template>
    </TableComponent>
  </div>
</template>

<style lang="scss" scoped>
.view { display: flex; flex-direction: column; height: 100%; }
.view-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem;
  h2 { margin: 0; color: #3a2060; }
}
.error { color: #c0392b; margin-bottom: 0.5rem; font-size: 0.9rem; }
.create { margin-bottom: 1rem; }
.inline-form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.num { width: 110px; }
.mini { padding: 0.1rem 0.5rem; font-size: 0.75rem; }
</style>
