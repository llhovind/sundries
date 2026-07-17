'use strict';

/**
 * Report categories — the reporting system's access-control axis.
 *
 * Every report belongs to exactly one category, and each category is guarded
 * by exactly one permission code (seeded in migration 011 and granted per
 * role like every other permission). Who sees a report is therefore never
 * decided inside a report: it falls out of the category it declares.
 *
 * Adding a category means adding a row here plus a permissions insert in a
 * migration — reports and the reporting plumbing stay untouched.
 */
const CATEGORIES = Object.freeze({
    sales: Object.freeze({
        code:       'sales',
        label:      'Sales',
        descr:      'Revenue and customer purchasing activity',
        permission: 'reports:sales',
    }),
    finance: Object.freeze({
        code:       'finance',
        label:      'Finance',
        descr:      'Costs, margins, and inventory valuation',
        permission: 'reports:finance',
    }),
    inventory: Object.freeze({
        code:       'inventory',
        label:      'Inventory',
        descr:      'Operational stock reports',
        permission: 'reports:inventory',
    }),
    purchasing: Object.freeze({
        code:       'purchasing',
        label:      'Purchasing',
        descr:      'Vendors and purchase orders',
        permission: 'reports:purchasing',
    }),
});

/** Every category permission code — used to guard the reports API surface. */
const ALL_CATEGORY_PERMISSIONS = Object.freeze(
    Object.values(CATEGORIES).map(c => c.permission)
);

module.exports = { CATEGORIES, ALL_CATEGORY_PERMISSIONS };
