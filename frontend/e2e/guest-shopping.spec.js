import { test, expect } from '@playwright/test';
import { staffToken } from './support/backend';

/**
 * Anonymous guest shopping: browse the catalog without logging in, build a
 * local cart, and complete checkout through the public guest endpoint.
 * Each test seeds its own product through the staff API.
 */

const API = 'http://localhost:3000';
const RUN = Date.now();

/** Seed an active, in-stock product through the staff API; returns nothing the UI can't find by name. */
async function seedProduct(request, name, sku) {
    const authHeader = { Authorization: `Bearer ${staffToken()}` };

    const created = await request.post(`${API}/api/v1/products`, {
        headers: authHeader,
        data: { name, sell_method: 'unit', base_uom: 'each', status: 'active' },
    });
    expect(created.status()).toBe(201);
    const productNo = (await created.json()).content.product_no;

    const variant = await request.post(`${API}/api/v1/products/${productNo}/variants`, {
        headers: authHeader,
        data: { sku, price: 19 },
    });
    expect(variant.status()).toBe(201);
    const variantNo = (await variant.json()).content.variant_no;

    const warehouses = await request.get(`${API}/api/v1/inventory/warehouses`, { headers: authHeader });
    const warehouseNo = (await warehouses.json()).content.warehouses[0].warehouse_no;

    const received = await request.post(`${API}/api/v1/inventory/receive`, {
        headers: authHeader,
        data: { variant_no: variantNo, warehouse_no: warehouseNo, qty: 10, unit_cost: 4 },
    });
    expect(received.status()).toBe(201);
}

test.describe('Guest shopping', () => {

    test.beforeEach(async ({ page }) => {
        await page.context().clearCookies();
    });

    test('guest browses, fills a cart, and checks out without an account', async ({ page, request }) => {
        const productName = `E2E Guest Mug ${RUN}`;
        await seedProduct(request, productName, `E2E-GUEST-${RUN}`);

        // ── Browse: anonymous visit lands on the shop ─────────────────────────
        await page.goto('/');
        await expect(page).toHaveURL(/\/shop/);

        await page.fill('input[placeholder="Search products…"]', productName);
        const card = page.locator('.product', { hasText: productName });
        await expect(card).toBeVisible();
        await card.click();

        // ── Cart: add the item, local guest cart shows it ──────────────────────
        await page.click('button:has-text("Add to cart")');
        await expect(page.locator('.cart .lines')).toContainText(productName);

        await page.click('.checkout-btn');
        await expect(page).toHaveURL(/\/checkout/);

        // ── Checkout: guest contact + shipping, then the demo payment ─────────
        await page.getByLabel('Email').fill(`guest-e2e-${RUN}@example.com`);
        await page.getByLabel('Name', { exact: true }).fill('Gwen Guest');
        await page.getByLabel('Address').fill('1 Anonymous Way');
        await page.getByLabel('City').fill('Springfield');
        await page.getByLabel('ZIP').fill('12345');

        await page.click('button:has-text("Place Order")');
        await expect(page.locator('.pay-card')).toContainText('complete payment');

        await page.click('button:has-text("Pay now (demo)")');
        await expect(page.locator('.done-card')).toContainText('Payment confirmed');
        await expect(page.locator('button:has-text("Log in to track it")')).toBeVisible();

        // The guest basket is spent — a fresh shop visit starts empty
        await page.goto('/shop');
        await expect(page.locator('.cart')).toContainText('Your cart is empty');
    });

    test('guest cart survives a page reload', async ({ page, request }) => {
        const productName = `E2E Guest Plate ${RUN}`;
        await seedProduct(request, productName, `E2E-GUEST-P-${RUN}`);

        await page.goto('/shop');
        await page.fill('input[placeholder="Search products…"]', productName);
        const card = page.locator('.product', { hasText: productName });
        await expect(card).toBeVisible();
        await card.click();

        await page.click('button:has-text("Add to cart")');
        await expect(page.locator('.cart .lines')).toContainText(productName);

        await page.reload();
        await expect(page.locator('.cart .lines')).toContainText(productName);
    });
});
