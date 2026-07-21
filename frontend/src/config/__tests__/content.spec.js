import { describe, it, expect } from 'vitest';
import { CONTENT_PAGES, CONTENT_NAV } from '@/config/content';
import router from '@/router';

describe('content pages config', () => {
    it('given the footer nav when built then every slug resolves to a defined page', () => {
        for (const { slug } of CONTENT_NAV) {
            expect(CONTENT_PAGES[slug], `missing page for slug "${slug}"`).toBeDefined();
        }
    });

    it('given every page when validated then it has a title and non-empty sections', () => {
        for (const [slug, page] of Object.entries(CONTENT_PAGES)) {
            expect(page.title, `${slug} title`).toBeTruthy();
            expect(Array.isArray(page.sections) && page.sections.length, `${slug} sections`).toBeTruthy();
            for (const section of page.sections) {
                expect(
                    Array.isArray(section.paragraphs) && section.paragraphs.length,
                    `${slug} section paragraphs`,
                ).toBeTruthy();
            }
        }
    });

    it('given the router when loaded then every content slug is a registered route', () => {
        const names = new Set(router.getRoutes().map(r => r.name));
        for (const { slug } of CONTENT_NAV) {
            expect(names.has(`content-${slug}`), `route content-${slug}`).toBe(true);
        }
    });
});
