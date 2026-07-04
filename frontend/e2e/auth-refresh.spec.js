import { test, expect } from '@playwright/test';

const ADMIN = { username: 'admin', password: 'Admin123!' };

test.describe('session persistence on page refresh', () => {
    test('user remains logged in after a hard page reload', async ({ page }) => {
        const consoleWarnings = [];
        page.on('console', msg => {
            if (msg.type() === 'warning') consoleWarnings.push(msg.text());
        });

        // ── 1. Login ────────────────────────────────────────────────────────
        await page.goto('/login');
        await page.locator('#username').fill(ADMIN.username);
        await page.locator('#password').fill(ADMIN.password);

        const loginResponse = page.waitForResponse(r =>
            r.url().includes('/api/v1/auth/login')
        );
        await page.getByRole('button', { name: /sign in/i }).click();
        await loginResponse;

        // ── 2. Confirm the ff_refresh httpOnly cookie was set ────────────────
        const cookies = await page.context().cookies();
        const refreshCookie = cookies.find(c => c.name === 'ff_refresh');

        if (!refreshCookie) {
            console.error('DIAGNOSIS: ff_refresh cookie was NOT set after login.');
            console.error('Cookies present:', cookies.map(c => c.name));
        }
        expect(refreshCookie, 'ff_refresh cookie must be set after login').toBeTruthy();
        expect(refreshCookie.httpOnly, 'ff_refresh cookie must be httpOnly').toBe(true);

        // ── 3. Verify we landed on the inventory page ────────────────────────
        await expect(page).toHaveURL(/\/inventory/);

        // ── 4. Hard reload — this wipes in-memory JS state ──────────────────
        const refreshResponse = page.waitForResponse(r =>
            r.url().includes('/api/v1/auth/refresh')
        );
        await page.reload();
        const res = await refreshResponse;

        // ── 5. Log the refresh response for diagnosis ────────────────────────
        const status = res.status();
        let body;
        try { body = await res.json(); } catch { body = null; }

        console.log(`[auth/refresh] status=${status}`, body);

        if (status !== 200) {
            console.error('DIAGNOSIS: /api/v1/auth/refresh returned', status, body);
            if (consoleWarnings.some(w => w.includes('[auth]'))) {
                console.error('Frontend init() warning captured:', consoleWarnings.filter(w => w.includes('[auth]')));
            }
        }

        // ── 6. Assert session survived the reload ────────────────────────────
        expect(status, '/api/v1/auth/refresh must return 200 after reload').toBe(200);
        await expect(page).toHaveURL(/\/inventory/, { timeout: 8_000 });
        await expect(page.locator('.username').filter({ hasText: 'admin' })).toBeVisible({ timeout: 5_000 });
    });
});
