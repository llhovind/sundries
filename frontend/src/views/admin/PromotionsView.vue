<script setup>
import { ref, reactive, onMounted } from 'vue';
import api from '@/services/api';
import { fixedNum } from '@/composables/utils';

const promos = ref([]);
const error  = ref('');
const showCreate = ref(false);
const form = reactive({ code: '', name: '', promo_type: 'percent', value: 10,
                        starts_at: '', ends_at: '', max_redemptions: null, status: 'active' });

async function load() {
    error.value = '';
    try {
        const res = await api.get('/api/v1/promotions?pageSize=50');
        promos.value = res.data.content.promotions;
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Failed to load promotions';
    }
}

async function create() {
    error.value = '';
    try {
        const body = { ...form };
        if (!body.starts_at) delete body.starts_at;
        if (!body.ends_at)   delete body.ends_at;
        if (body.max_redemptions == null || body.max_redemptions === '') delete body.max_redemptions;
        await api.post('/api/v1/promotions', body);
        showCreate.value = false;
        Object.assign(form, { code: '', name: '', promo_type: 'percent', value: 10,
                              starts_at: '', ends_at: '', max_redemptions: null, status: 'active' });
        await load();
    } catch (err) {
        error.value = err.response?.data?.outcome?.message || 'Create failed';
    }
}

async function toggleStatus(p) {
    await api.put('/api/v1/promotions/' + p.promo_no,
        { status: p.status === 'active' ? 'inactive' : 'active' });
    await load();
}

function fmtValue(p) {
    if (p.promo_type === 'percent')       return p.value + '% off';
    if (p.promo_type === 'fixed_amount')  return '$ ' + fixedNum(p.value, 2) + ' off';
    return 'Free shipping';
}

onMounted(load);
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>Promotions</h2>
      <button class="btn btn-primary" @click="showCreate = !showCreate">+ New code</button>
    </div>
    <p v-if="error" class="error-text">{{ error }}</p>

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

    <table class="table-plain">
      <thead><tr><th>Code</th><th>Name</th><th>Discount</th><th>Window</th><th>Used</th><th>Status</th><th></th></tr></thead>
      <tbody>
        <tr v-for="p in promos" :key="p.promo_no">
          <td><strong>{{ p.code }}</strong></td>
          <td>{{ p.name }}</td>
          <td>{{ fmtValue(p) }}</td>
          <td class="muted">
            {{ p.starts_at ? new Date(p.starts_at).toLocaleDateString() : '—' }} →
            {{ p.ends_at ? new Date(p.ends_at).toLocaleDateString() : '∞' }}
          </td>
          <td>{{ p.redemption_count }}{{ p.max_redemptions != null ? ' / ' + p.max_redemptions : '' }}</td>
          <td><span class="pill" :class="p.status === 'active' ? 'ok' : ''">{{ p.status }}</span></td>
          <td>
            <button class="btn mini" @click="toggleStatus(p)">
              {{ p.status === 'active' ? 'Disable' : 'Enable' }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.8rem; }
.toolbar .btn { margin-left: auto; }
.create { margin-bottom: 1rem; }
.inline-form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.num { width: 110px; }
.mini { padding: 0.1rem 0.5rem; font-size: 0.75rem; }
</style>
