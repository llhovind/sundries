import { describe, it, expect } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { STAFF_NAV_GROUPS, visibleNavGroups } from '@/config/navigation';
import router from '@/router';

/** Minimal stand-in for router.getRoutes() output. */
const fakeRoutes = [
    { name: 'admin-orders',    meta: { requiresPerm: ['orders:read', 'orders:fulfill'] } },
    { name: 'admin-inventory', meta: { requiresPerm: ['inventory:read'] } },
    { name: 'open-page',       meta: {} },
];

const fakeGroups = [
    { label: 'Sales',     items: [{ label: 'Orders', route: 'admin-orders' }] },
    { label: 'Inventory', items: [{ label: 'Stock',  route: 'admin-inventory' }] },
    { label: null,        items: [{ label: 'Open',   route: 'open-page' }] },
];

/** any-of semantics, mirroring the auth store's hasPerm. */
const permsOf = (...held) => (...codes) => codes.some(c => held.includes(c));

describe('visibleNavGroups', () => {
    it('given a user with no permissions when filtering then only unrestricted items remain', () => {
        const groups = visibleNavGroups(fakeRoutes, permsOf(), fakeGroups);
        expect(groups).toEqual([
            { label: null, items: [{ label: 'Open', route: 'open-page' }] },
        ]);
    });

    it('given a user with one permission when filtering then empty groups are dropped', () => {
        const groups = visibleNavGroups(fakeRoutes, permsOf('inventory:read'), fakeGroups);
        expect(groups.map(g => g.label)).toEqual(['Inventory', null]);
        expect(groups[0].items).toEqual([{ label: 'Stock', route: 'admin-inventory' }]);
    });

    it('given a route with any-of permissions when the user holds only one then the item is visible', () => {
        const groups = visibleNavGroups(fakeRoutes, permsOf('orders:fulfill'), fakeGroups);
        expect(groups.map(g => g.label)).toContain('Sales');
    });

    it('given an item referencing an unknown route when filtering then it throws', () => {
        const broken = [{ label: 'X', items: [{ label: 'Ghost', route: 'no-such-route' }] }];
        expect(() => visibleNavGroups(fakeRoutes, permsOf(), broken))
            .toThrow(/no-such-route/);
    });

    it('given the real router when resolving the declared nav config then every route name exists', () => {
        // The router's guard reads the auth store at navigation time only, but
        // creating it is safe; pinia is activated in case any import touches it.
        setActivePinia(createPinia());
        const names = new Set(router.getRoutes().map(r => r.name));
        for (const group of STAFF_NAV_GROUPS) {
            for (const item of group.items) {
                expect(names.has(item.route), `route "${item.route}" missing from router`).toBe(true);
            }
        }
    });

    it('given full permissions when filtering against the real router then all groups appear in declared order', () => {
        const groups = visibleNavGroups(router.getRoutes(), () => true);
        expect(groups.map(g => g.label)).toEqual(['Sales', 'Catalog', 'Inventory', null, 'Admin']);
    });
});
