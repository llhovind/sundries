import { test, expect } from '@playwright/test';
import { beginOtpLogin } from './support/backend';

test.describe('session persistence on page refresh', () => {
    test('user remains logged in after a hard page reload', async ({ page }) => {
        const email = `e2e-refresh-${Date.now()}@example.com`;

        // ── 1. Login via one-time code ───────────────────────────────────────
        await beginOtpLogin(page, email, '123456');
        await page.fill('#otp', '123456');
        await page.click('button[type="submit"]');
        await expect(page).toHaveURL(/\/shop/);

        // ── 2. Confirm the refresh_token httpOnly cookie was set ─────────────
        const cookies = await page.context().cookies();
        const refreshCookie = cookies.find(c => c.name === 'refresh_token');
        expect(refreshCookie, 'refresh_token cookie must be set after login').toBeTruthy();
        expect(refreshCookie.httpOnly, 'refresh_token cookie must be httpOnly').toBe(true);

        // ── 3. Hard reload — wipes in-memory JS state; the session must be
        //       restored from the refresh cookie alone ────────────────────────
        const refreshResponse = page.waitForResponse(r =>
            r.url().includes('/api/v1/auth/refresh')
        );
        await page.reload();
        const res = await refreshResponse;

        expect(res.status(), '/api/v1/auth/refresh must return 200 after reload').toBe(200);
        await expect(page).toHaveURL(/\/shop/, { timeout: 8_000 });
        await expect(page.locator('.username-btn')).toContainText(email, { timeout: 5_000 });
    });
});
