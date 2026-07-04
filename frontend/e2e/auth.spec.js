import { test, expect } from '@playwright/test';

test.describe('Authentication flows', () => {

    test.beforeEach(async ({ page }) => {
        // Start fresh — clear any lingering session storage / cookies
        await page.context().clearCookies();
    });

    test('unauthenticated visit redirects to /login', async ({ page }) => {
        await page.goto('/');
        await expect(page).toHaveURL(/\/login/);
    });

    test('shows validation error on empty login submit', async ({ page }) => {
        await page.goto('/login');
        await page.click('button[type="submit"]');
        await expect(page.locator('.error')).toBeVisible();
        await expect(page.locator('.error')).toContainText('required');
    });

    test('shows error for wrong credentials', async ({ page }) => {
        await page.goto('/login');
        await page.fill('#username', 'admin');
        await page.fill('#password', 'wrongpassword');
        await page.click('button[type="submit"]');
        await expect(page.locator('.error')).toBeVisible();
    });

    test('admin can log in and reach inventory', async ({ page }) => {
        await page.goto('/login');
        await page.fill('#username', 'admin');
        await page.fill('#password', 'Admin123!');
        await page.click('button[type="submit"]');

        await expect(page).toHaveURL(/\/inventory/, { timeout: 8_000 });
        // Nav should show username and role
        await expect(page.locator('.username')).toContainText('admin');
        await expect(page.locator('.role-badge')).toContainText('admin');
    });

    test('customer can log in and reach inventory', async ({ page }) => {
        await page.goto('/login');
        await page.fill('#username', 'customer');
        await page.fill('#password', 'Customer123!');
        await page.click('button[type="submit"]');

        await expect(page).toHaveURL(/\/inventory/, { timeout: 8_000 });
        await expect(page.locator('.role-badge')).toContainText('customer');
    });

    test('logout redirects to /login', async ({ page }) => {
        // Log in first
        await page.goto('/login');
        await page.fill('#username', 'admin');
        await page.fill('#password', 'Admin123!');
        await page.click('button[type="submit"]');
        await expect(page).toHaveURL(/\/inventory/, { timeout: 8_000 });

        // Logout
        await page.click('.logout-btn');
        await expect(page).toHaveURL(/\/login/);
    });

    test('customer does not see admin-only nav links', async ({ page }) => {
        await page.goto('/login');
        await page.fill('#username', 'customer');
        await page.fill('#password', 'Customer123!');
        await page.click('button[type="submit"]');
        await expect(page).toHaveURL(/\/inventory/, { timeout: 8_000 });

        await expect(page.locator('nav a[href="/purchaseorders"]')).not.toBeVisible();
        await expect(page.locator('nav a[href="/categories"]')).not.toBeVisible();
    });
});
