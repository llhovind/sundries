'use strict';

/**
 * Public image delivery: how /images behaves under each storage mode. Mounted
 * on a bare Express app — no database, no store — so these assert the HTTP
 * contract a browser and a CDN see, not the storage wiring.
 */

const express = require('express');
const request = require('supertest');
const path    = require('path');

const { mountImageDelivery } = require('../middleware/imageDelivery');
const local = require('../services/images/localAdapter');

const IMAGE_PATH = '/images';
const CDN = 'https://cdn.example.com/images';

function appWith(delivery) {
    const app = express();
    mountImageDelivery(app, IMAGE_PATH, delivery);
    app.use((req, res) => res.status(404).end());
    return app;
}

describe('given the static delivery mode when an image is requested then it is served from disk', () => {

    test('given a missing file then the request falls through to a 404', async () => {
        const app = appWith({ mode: 'static', root: path.join(local.root) });
        const res = await request(app).get('/images/999999999/nope.png');
        expect(res.status).toBe(404);
    });
});

describe('given the redirect delivery mode when an image is requested then readers are sent to the CDN', () => {

    test('given a valid key then it redirects to the CDN with a cacheable 302', async () => {
        const res = await request(appWith({ mode: 'redirect', baseUrl: CDN }))
            .get('/images/42/product-1700000000000.png');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(`${CDN}/42/product-1700000000000.png`);
        expect(res.headers['cache-control']).toBe('public, max-age=3600');
    });

    test('given a variant key then it redirects the same way', async () => {
        const res = await request(appWith({ mode: 'redirect', baseUrl: CDN }))
            .get('/images/42/variant-7-1700000000000.webp');
        expect(res.headers.location).toBe(`${CDN}/42/variant-7-1700000000000.webp`);
    });

    test('given a path this app never issued as a key then it is a 404, not a redirect', async () => {
        const app = appWith({ mode: 'redirect', baseUrl: CDN });
        for (const bad of ['/images/etc/passwd', '/images/42/sub/dir/x.png', '/images/x.png', '/images/']) {
            const res = await request(app).get(bad);
            expect(res.status).toBe(404);
            expect(res.headers.location).toBeUndefined();
        }
    });

    test('given a traversal attempt then no redirect leaves the CDN base', async () => {
        const res = await request(appWith({ mode: 'redirect', baseUrl: CDN }))
            .get('/images/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd');
        expect(res.status).toBe(404);
    });
});

describe('given an unknown delivery mode when mounting then startup fails loudly', () => {

    test('given a mode with no handler then the app refuses to build', () => {
        expect(() => appWith({ mode: 'magic' }))
            .toThrow('Unknown image delivery mode: magic');
    });
});
