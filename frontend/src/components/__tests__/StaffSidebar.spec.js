import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import StaffSidebar from '@/components/StaffSidebar.vue';

const RouterLinkStub = {
    props: ['to'],
    template: '<a :data-route="to.name"><slot /></a>',
};

function mountSidebar(groups) {
    return mount(StaffSidebar, {
        props: { groups },
        global: { components: { RouterLink: RouterLinkStub } },
    });
}

describe('StaffSidebar', () => {
    it('given labelled groups when rendered then headings and links appear in order', () => {
        const wrapper = mountSidebar([
            { label: 'Sales',     items: [{ label: 'Orders', route: 'admin-orders' }] },
            { label: 'Inventory', items: [{ label: 'Stock',  route: 'admin-inventory' }] },
        ]);

        expect(wrapper.findAll('.group-label').map(n => n.text())).toEqual(['Sales', 'Inventory']);
        const links = wrapper.findAll('a');
        expect(links.map(l => l.text())).toEqual(['Orders', 'Stock']);
        expect(links[0].attributes('data-route')).toBe('admin-orders');
    });

    it('given an unlabelled group when rendered then the item shows without a heading', () => {
        const wrapper = mountSidebar([
            { label: null, items: [{ label: 'Reports', route: 'admin-reports' }] },
        ]);

        expect(wrapper.find('.group-label').exists()).toBe(false);
        expect(wrapper.find('a').text()).toBe('Reports');
    });
});
