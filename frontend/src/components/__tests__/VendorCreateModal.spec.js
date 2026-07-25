import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import VendorCreateModal from '@/components/VendorCreateModal.vue';
import { usePurchaseOrdersStore } from '@/stores/purchaseOrders';

async function fill(wrapper, fields) {
    for (const [selector, value] of Object.entries(fields)) {
        await wrapper.find(selector).setValue(value);
    }
}

const save = (wrapper) => wrapper.find('.btn-save').trigger('click');
const flush = () => new Promise(r => setTimeout(r));

describe('VendorCreateModal', () => {
    beforeEach(() => setActivePinia(createPinia()));

    it('given a name and contact details when saved then the vendor is created', async () => {
        const store = usePurchaseOrdersStore();
        store.createVendor = vi.fn().mockResolvedValue({ id: 7, name: 'Northwind Supply Co.' });

        const wrapper = mount(VendorCreateModal);
        await fill(wrapper, {
            '#new-vendor-name':  'Northwind Supply Co.',
            '#new-vendor-phone': '+1-503-555-0142',
            '#new-vendor-city':  'Portland',
        });
        await save(wrapper);
        await flush();

        expect(store.createVendor).toHaveBeenCalledWith({
            name:  'Northwind Supply Co.',
            phone: '+1-503-555-0142',
            city:  'Portland',
        });
    });

    it('given a successful save then the new vendor id is emitted before closing', async () => {
        const store = usePurchaseOrdersStore();
        store.createVendor = vi.fn().mockResolvedValue({ id: 7, name: 'Northwind Supply Co.' });

        const wrapper = mount(VendorCreateModal);
        await fill(wrapper, { '#new-vendor-name': 'Northwind Supply Co.' });
        await save(wrapper);
        await flush();

        expect(wrapper.emitted('created')).toEqual([[7]]);
        expect(wrapper.emitted('close')).toHaveLength(1);
    });

    it('given a blank name when saved then it reports the error and calls nothing', async () => {
        const store = usePurchaseOrdersStore();
        store.createVendor = vi.fn();

        const wrapper = mount(VendorCreateModal);
        await fill(wrapper, { '#new-vendor-name': '   ' });
        await save(wrapper);
        await flush();

        expect(store.createVendor).not.toHaveBeenCalled();
        expect(wrapper.find('.error').text()).toContain('name is required');
        expect(wrapper.emitted('close')).toBeUndefined();
    });

    it('given the API rejects then the message is shown and the modal stays open', async () => {
        const store = usePurchaseOrdersStore();
        store.createVendor = vi.fn().mockRejectedValue(
            { response: { data: { outcome: { message: 'Vendor name already exists' } } } });

        const wrapper = mount(VendorCreateModal);
        await fill(wrapper, { '#new-vendor-name': 'Northwind Supply Co.' });
        await save(wrapper);
        await flush();

        expect(wrapper.find('.error').text()).toBe('Vendor name already exists');
        expect(wrapper.emitted('close')).toBeUndefined();
    });
});
