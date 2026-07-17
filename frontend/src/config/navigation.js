/**
 * Staff navigation structure — the single source of truth for the staff sidebar.
 *
 * Permission requirements are deliberately NOT declared here. Each item
 * references a named route, and visibility is derived from that route's
 * `requiresPerm` meta (see @/router), so the menu can never drift from what
 * the navigation guard actually enforces.
 *
 * A group with `label: null` renders its items as ungrouped top-level links
 * (used for Reports, which spans several domains).
 */
export const STAFF_NAV_GROUPS = [
    {
        label: 'Sales',
        items: [
            { label: 'Orders',     route: 'admin-orders' },
            { label: 'Returns',    route: 'admin-rmas' },
            { label: 'Customers',  route: 'customers' },
        ],
    },
    {
        label: 'Catalog',
        items: [
            { label: 'Products',   route: 'admin-products' },
            { label: 'Categories', route: 'categories' },
            { label: 'Promotions', route: 'admin-promotions' },
        ],
    },
    {
        label: 'Inventory',
        items: [
            { label: 'Stock',      route: 'admin-inventory' },
            { label: 'Transfers',  route: 'admin-transfers' },
            { label: 'Purchasing', route: 'admin-purchasing' },
        ],
    },
    {
        label: null,
        items: [
            { label: 'Reports',    route: 'admin-reports' },
        ],
    },
    {
        label: 'Admin',
        items: [
            { label: 'Users',      route: 'users' },
            { label: 'Roles',      route: 'admin-roles' },
            { label: 'Settings',   route: 'admin-settings' },
        ],
    },
];

/**
 * Filter the nav structure down to what the current user may see.
 *
 * @param {Array<{name?: string, meta?: object}>} routes - router.getRoutes()
 * @param {(...codes: string[]) => boolean} hasPerm - any-of permission check
 * @param {typeof STAFF_NAV_GROUPS} [groups] - injectable for tests
 * @returns {typeof STAFF_NAV_GROUPS} groups containing only permitted items;
 *          groups left with no items are dropped entirely
 * @throws {Error} if an item references a route name the router doesn't know —
 *         a config error that must fail loudly, not render a dead link
 */
export function visibleNavGroups(routes, hasPerm, groups = STAFF_NAV_GROUPS) {
    const metaByName = new Map(routes.map(r => [r.name, r.meta ?? {}]));

    return groups
        .map(group => ({
            ...group,
            items: group.items.filter(item => {
                const meta = metaByName.get(item.route);
                if (!meta) {
                    throw new Error(`[navigation] Unknown route name in nav config: "${item.route}"`);
                }
                return !meta.requiresPerm || hasPerm(...meta.requiresPerm);
            }),
        }))
        .filter(group => group.items.length > 0);
}
