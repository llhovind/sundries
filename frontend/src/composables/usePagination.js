import { computed } from 'vue';

/**
 * Composable that computes the visible page-number array for a pagination bar.
 *
 * @param {import('vue').Ref<number>|import('vue').ComputedRef<number>} curPg   - reactive current page
 * @param {import('vue').Ref<number>|import('vue').ComputedRef<number>} totalPgs - reactive total pages
 * @returns {{ pgArry: import('vue').ComputedRef<number[]> }}
 */
export function usePagination(curPg, totalPgs) {
    const pgArry = computed(() => {
        const cur   = +curPg.value;
        const total = +totalPgs.value;
        if (total <= 0) return [];
        let tmp = [-3, -2, -1, 0, 1, 2, 3].map(e => cur + e);
        if (tmp[0] < 1)       tmp = tmp.map(e => e + (1 - tmp[0]));
        else if (tmp[6] > total) tmp = tmp.map(e => e + (total - tmp[6]));
        return tmp.filter(p => p >= 1 && p <= total);
    });
    return { pgArry };
}
