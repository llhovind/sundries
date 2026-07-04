<script setup>
import { ref, computed, onMounted } from 'vue';
import { usePagination } from '@/composables/usePagination';
import PaginationBar from '@/components/PaginationBar.vue';
import { useCategoriesStore } from '@/stores/categories';

const store    = useCategoriesStore();
onMounted(() => store.getAll().catch(() => {}));
const errorMsg = ref('');
const newName  = ref('');
const adding   = ref(false);
const searchQ  = ref('');

// Inline edit state
const editId   = ref(null);
const editName = ref('');

const totalPgs = computed(() => store.totalPgs);
const { pgArry } = usePagination(computed(() => store.curPg), totalPgs);

function onSearch()       { store.query.q = searchQ.value; store.query.page = 1; }
function onGoto(pg)       { store.query.page = pg; }
function onPageSize(size) { store.query.pageSize = size; store.query.page = 1; }

async function addCategory() {
    if (!newName.value.trim()) return;
    adding.value  = true;
    errorMsg.value = '';
    try {
        await store.createCategory(newName.value.trim());
        newName.value = '';
    } catch (err) {
        errorMsg.value = err.response?.data?.message || 'Failed to add category';
    } finally {
        adding.value = false;
    }
}

function startEdit(cat) { editId.value = cat.id; editName.value = cat.name; }
function cancelEdit()    { editId.value = null; editName.value = ''; }

async function saveEdit(cat) {
    if (!editName.value.trim()) return;
    errorMsg.value = '';
    try {
        await store.updateCategory(cat.id, editName.value.trim());
        cancelEdit();
    } catch (err) {
        errorMsg.value = err.response?.data?.message || 'Failed to save';
    }
}

async function deleteCategory(cat) {
    if (!confirm(`Delete category "${cat.name}"? It must not be assigned to any items.`)) return;
    errorMsg.value = '';
    try {
        await store.deleteCategory(cat.id);
    } catch (err) {
        errorMsg.value = err.response?.data?.message || 'Failed to delete';
    }
}
</script>

<template>
  <div class="cat-view">
    <div class="view-header">
      <h2>Categories</h2>
      <div class="search-row">
        <input v-model="searchQ" type="text" placeholder="Search categories…" @keyup.enter="onSearch" />
        <button class="btn-search" @click="onSearch">Search</button>
      </div>
    </div>

    <div v-if="errorMsg" class="error">{{ errorMsg }}</div>
    <div v-if="store.loadingCnt > 0" class="info">Loading…</div>

    <!-- Add form -->
    <div class="add-row">
      <input v-model="newName" type="text" placeholder="New category name…" @keyup.enter="addCategory" />
      <button class="btn-add" :disabled="adding || !newName.trim()" @click="addCategory">
        {{ adding ? 'Adding…' : 'Add' }}
      </button>
    </div>

    <PaginationBar
      :curPage="store.curPg"
      :totalPages="store.totalPgs"
      :totalCnt="store.totalCnt"
      :pageSize="store.query.pageSize"
      :pgArry="pgArry"
      :pageSizeOptions="[25, 50, 100]"
      label="Categories Found"
      @goto="onGoto"
      @update:pageSize="onPageSize"
    />

    <table v-if="store.categories.length" class="cat-table">
      <thead><tr><th>Name</th><th class="actions-col">Actions</th></tr></thead>
      <tbody>
        <tr v-for="cat in store.categories" :key="cat.id">
          <td>
            <template v-if="editId === cat.id">
              <input v-model="editName" class="edit-input" @keyup.enter="saveEdit(cat)" @keyup.esc="cancelEdit" autofocus />
            </template>
            <template v-else>{{ cat.name }}</template>
          </td>
          <td class="actions-col">
            <template v-if="editId === cat.id">
              <button class="btn-save"   @click="saveEdit(cat)">Save</button>
              <button class="btn-cancel" @click="cancelEdit">Cancel</button>
            </template>
            <template v-else>
              <button class="btn-edit"   @click="startEdit(cat)">Edit</button>
              <button class="btn-delete" @click="deleteCategory(cat)">Delete</button>
            </template>
          </td>
        </tr>
      </tbody>
    </table>

    <p v-else-if="store.loadingCnt === 0" class="empty">No categories found.</p>
  </div>
</template>

<style lang="scss" scoped>
.cat-view {
  max-width: 600px;
  h2 { margin: 0 0 1rem; color: #3a2060; }
}
.view-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem;
  h2 { margin: 0; }
}
.search-row { display: flex; gap: 0.5rem;
  input { padding: 0.35rem 0.6rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem; width: 220px; }
}
.btn-search { padding: 0.35rem 0.9rem; background: #5a3e8a; color: #fff; border: none; border-radius: 4px; cursor: pointer; &:hover { background: #7a5ea8; } }
.add-row {
  display: flex; gap: 0.5rem; margin-bottom: 0.75rem;
  input {
    flex: 1; padding: 0.4rem 0.6rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.95rem;
    &:focus { outline: none; border-color: #8090BF; }
  }
}
.cat-table {
  width: 100%; border-collapse: collapse;
  th { background: royalblue; color: #fff; text-align: left; padding: 0.4rem 0.75rem; }
  td { padding: 0.35rem 0.75rem; border-bottom: 1px solid #eee; }
  tr:hover td { background: rgba(96,176,250,0.15); }
}
.actions-col { width: 12rem; white-space: nowrap; }
.edit-input {
  width: 100%; padding: 0.25rem 0.4rem; border: 1px solid #8090BF; border-radius: 3px; font-size: 0.9rem;
}
.error { color: #c0392b; margin-bottom: 0.75rem; font-size: 0.9rem; }
.info  { color: #666;    margin-bottom: 0.75rem; }
.empty { color: #999; }
button {
  padding: 0.25rem 0.7rem; border-radius: 4px; border: none; cursor: pointer; font-size: 0.85rem;
  margin-left: 0.3rem;
  &:disabled { opacity: 0.6; cursor: not-allowed; }
}
.btn-add    { background: #5a3e8a; color: #fff; padding: 0.4rem 1rem; &:hover:not(:disabled) { background: #7a5ea8; } }
.btn-edit   { background: #4a90d9; color: #fff; &:hover { background: #357abd; } }
.btn-save   { background: #2e7d32; color: #fff; &:hover { background: #388e3c; } }
.btn-delete { background: #c0392b; color: #fff; &:hover { background: #e74c3c; } }
.btn-cancel { background: #e0e0e0; color: #333; &:hover { background: #ccc; } }
</style>
