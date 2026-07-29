import { test, expect } from '@playwright/test';
import { beginOtpLogin } from './support/backend';

const OTP = '123456';

test.describe('Authentication flows', () => {

    test.beforeEach(async ({ page }) => {
        // Start fresh — clear any lingering session storage / cookies
        await page.context().clearCookies();
    });

    test('anonymous visit lands on the shop; account pages still require login', async ({ page }) => {
        await page.goto('/');
        await expect(page).toHaveURL(/\/shop/);

        await page.goto('/orders');
        await expect(page).toHaveURL(/\/login/);
    });

    test('shows validation error on empty login submit', async ({ page }) => {
        await page.goto('/login');
        await page.click('button[type="submit"]');
        await expect(page.locator('.error')).toBeVisible();
        await expect(page.locator('.error')).toContainText('required');
    });

    test('customer logs in with a one-time code, sees shopper nav, and can log out', async ({ page }) => {
        const email = `e2e-otp-${Date.now()}@example.com`;
        await beginOtpLogin(page, email, OTP);

        await page.fill('#otp', OTP);
        await page.click('button[type="submit"]');

        await expect(page).toHaveURL(/\/shop/);
        // Scoped to the header: the footer carries its own <nav> of content links.
        await expect(page.locator('header nav')).toContainText('My Orders');
        await expect(page.locator('.username-btn')).toContainText(email);

        // Customers hold no staff permissions — no admin links
        await expect(page.locator('header nav a[href="/admin/orders"]')).not.toBeVisible();
        await expect(page.locator('header nav a[href="/categories"]')).not.toBeVisible();

        await page.click('.logout-btn');
        await expect(page).toHaveURL(/\/login/);
    });

    test('a wrong login code shows an error and stays logged out', async ({ page }) => {
        const email = `e2e-otp-bad-${Date.now()}@example.com`;
        await beginOtpLogin(page, email, OTP);

        await page.fill('#otp', '000000');
        await page.click('button[type="submit"]');

        await expect(page.locator('.error')).toContainText('Invalid or expired');
        await expect(page).toHaveURL(/\/login/);
    });
});
