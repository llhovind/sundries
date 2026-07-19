import api from '@/services/api';
import { createListStore } from './storeUtils';

export const useProductsStore = createListStore('products', {
    endpoint:         '/api/v1/products',
    collectionKey:    'products',
    loadErrorMessage: 'Failed to load products',

    fieldsConfig: {
        name:          { label: 'Name' },
        status:        { label: 'Status' },
        sell_method:   { label: 'Method' },
        price_from:    { label: 'From $', format: 'money' },
        variant_count: { label: 'Variants' },
        qty_available: { label: 'Available', format: 'fixedNum1' },
    },

    extend: ({ getAll }) => ({
        async getProduct(productNo) {
            const res = await api.get(`/api/v1/products/${productNo}`);
            return res.data.content.product;
        },

        async createProduct(body) {
            await api.post('/api/v1/products', body);
            await getAll();
        },

        async updateStatus(productNo, status) {
            await api.put(`/api/v1/products/${productNo}`, { status });
            await getAll();
        },

        /** Creates a variant, or updates one when payload carries variant_no. */
        async saveVariant(productNo, payload) {
            await api.post(`/api/v1/products/${productNo}/variants`, payload);
        },

        /** Uploads a product image (multipart) and makes it the primary image. */
        async uploadImage(productNo, file) {
            const form = new FormData();
            form.append('image', file);
            await api.post(`/api/v1/products/${productNo}/image`, form);
        },

        /** Uploads an image for one variant of a product. */
        async uploadVariantImage(productNo, variantNo, file) {
            const form = new FormData();
            form.append('image', file);
            await api.post(`/api/v1/products/${productNo}/variants/${variantNo}/image`, form);
        },

        async saveOptions(productNo, options) {
            await api.put(`/api/v1/products/${productNo}/options`, { options });
        },
    }),
});
