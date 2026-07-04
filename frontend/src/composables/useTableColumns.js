import { ref, computed } from 'vue';
import { formatCell } from './utils';

export function useTableColumns(configObj, fieldKeys) {
    const fields_config = ref(configObj);
    const displayFields = ref(fieldKeys);
    const colCount      = computed(() => displayFields.value.length);

    function cellValue(row, key) {
        return formatCell(row[key], fields_config.value[key]?.format);
    }

    return { fields_config, displayFields, colCount, cellValue };
}
