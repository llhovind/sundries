'use strict';

/**
 * Image-store port tests: the shared upload policy, adapter selection, and the
 * local adapter's filesystem contract. No DB and no network — the integration
 * path (upload endpoint → primary_image → served file) lives in
 * storefront.test.js.
 */

const fs   = require('fs/promises');
const path = require('path');

const ImageStorage = require('../services/images');
const policy       = require('../services/images/policy');
const local        = require('../services/images/localAdapter');
const { getImageStore } = require('../services/images/registry');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const PRODUCT_NO = 987654321;   // outside any seeded range — this suite writes real files

const ORIGINAL_PROVIDER = process.env.IMAGE_PROVIDER;

afterEach(() => {
    if (ORIGINAL_PROVIDER === undefined) delete process.env.IMAGE_PROVIDER;
    else process.env.IMAGE_PROVIDER = ORIGINAL_PROVIDER;
});

afterAll(async () => {
    await fs.rm(path.join(local.root, String(PRODUCT_NO)), { recursive: true, force: true });
});

describe('given the image upload policy when a key is built then it is derived, never client-supplied', () => {

    test('given a supported mimetype then the key is <product_no>/<base>-<ts>.<ext>', () => {
        expect(policy.imageKey(42, 'product', 'image/png'))
            .toMatch(/^42\/product-\d+\.png$/);
        expect(policy.imageKey(42, 'variant-7', 'image/jpeg'))
            .toMatch(/^42\/variant-7-\d+\.jpg$/);
    });

    test('given an unsupported mimetype then it is rejected as a 400, not a 500', () => {
        expect(() => policy.imageKey(42, 'product', 'application/pdf'))
            .toThrow(/Unsupported image type "application\/pdf"/);
        try {
            policy.imageKey(42, 'product', 'application/pdf');
        } catch (err) {
            expect(err.status).toBe(400);
        }
    });

    test('given a key from outside then only the generated shape is accepted', () => {
        expect(policy.isImageKey(policy.imageKey(42, 'product', 'image/png'))).toBe(true);
        expect(policy.isImageKey('42/variant-7-1700000000000.jpg')).toBe(true);

        ['../../etc/passwd', '42/../../etc/passwd', '/42/product-1.png', 'abc/product-1.png',
         '42/sub/dir/product-1.png', '', null, undefined].forEach(bad =>
            expect(policy.isImageKey(bad)).toBe(false));
    });

    test('given every allowed type then each maps to exactly one extension', () => {
        expect(Object.keys(policy.ALLOWED_IMAGE_TYPES).sort())
            .toEqual(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
        expect(policy.MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
    });
});

describe('given the adapter registry when IMAGE_PROVIDER is set then the matching store is used', () => {

    test('given no IMAGE_PROVIDER then the local store is the default', () => {
        delete process.env.IMAGE_PROVIDER;
        expect(getImageStore().provider).toBe('local');
    });

    test('given IMAGE_PROVIDER=local then the local store is selected', () => {
        process.env.IMAGE_PROVIDER = 'local';
        expect(getImageStore().provider).toBe('local');
    });

    test('given an unknown provider then selection fails loudly', () => {
        process.env.IMAGE_PROVIDER = 'dropbox';
        expect(() => getImageStore()).toThrow('Unknown image provider: dropbox');
    });
});

describe('given the s3 image store when images are saved and removed then the bucket is written through the SDK', () => {

    // The AWS SDK is an optional dependency — installs that never use S3 do
    // not have it — so the module registry stands in for it here. This asserts
    // the adapter's CONTRACT with S3 (keys, headers, retry policy), which is
    // what a wrong deploy would get wrong.
    const sent = [];

    function loadS3Adapter(env) {
        const saved = process.env;
        process.env = { ...saved, ...env };
        let adapter;
        try {
            jest.isolateModules(() => {
                jest.doMock('@aws-sdk/client-s3', () => ({
                    S3Client: class { constructor(opts) { sent.push({ clientOptions: opts }); }
                                      send(command) { sent.push(command); return Promise.resolve({}); } },
                    PutObjectCommand:    class { constructor(input) { this.name = 'Put';    this.input = input; } },
                    DeleteObjectCommand: class { constructor(input) { this.name = 'Delete'; this.input = input; } },
                }), { virtual: true });
                adapter = require('../services/images/s3Adapter');
            });
        } finally {
            process.env = saved;
        }
        return adapter;
    }

    beforeEach(() => { sent.length = 0; });

    test('given a saved image then it is put at <prefix>/<key> with its type and an immutable cache header', async () => {
        const adapter = loadS3Adapter({
            IMAGE_PROVIDER: 's3', S3_BUCKET: 'store-images',
            IMAGE_PUBLIC_BASE_URL: 'https://cdn.example.com/images',
        });
        await adapter.put('42/product-1700000000000.png', 'image/png', PNG);

        const put = sent.find(entry => entry.name === 'Put');
        expect(put.input).toMatchObject({
            Bucket:       'store-images',
            Key:          'images/42/product-1700000000000.png',
            ContentType:  'image/png',
            CacheControl: 'public, max-age=31536000, immutable',
        });
        expect(put.input.Body).toEqual(PNG);
    });

    test('given S3_PREFIX then it replaces the default bucket prefix', async () => {
        const adapter = loadS3Adapter({
            IMAGE_PROVIDER: 's3', S3_BUCKET: 'store-images', S3_PREFIX: 'catalog/',
            IMAGE_PUBLIC_BASE_URL: 'https://cdn.example.com/catalog',
        });
        await adapter.put('42/product-1.png', 'image/png', PNG);
        expect(sent.find(e => e.name === 'Put').input.Key).toBe('catalog/42/product-1.png');
    });

    test('given a removal then the same bucket key is deleted', async () => {
        const adapter = loadS3Adapter({
            IMAGE_PROVIDER: 's3', S3_BUCKET: 'store-images',
            IMAGE_PUBLIC_BASE_URL: 'https://cdn.example.com/images',
        });
        await adapter.remove('42/product-1.png');
        expect(sent.find(e => e.name === 'Delete').input)
            .toEqual({ Bucket: 'store-images', Key: 'images/42/product-1.png' });
    });

    test('given any S3 call then the client carries a retry limit and a request timeout', async () => {
        const adapter = loadS3Adapter({
            IMAGE_PROVIDER: 's3', S3_BUCKET: 'store-images',
            IMAGE_PUBLIC_BASE_URL: 'https://cdn.example.com/images',
        });
        await adapter.put('42/product-1.png', 'image/png', PNG);
        expect(sent[0].clientOptions).toMatchObject({
            maxAttempts: 3,
            requestHandler: { requestTimeout: 10000 },
        });
    });
});

describe('given the local image store when images are saved and removed then disk tracks the keys', () => {

    test('given a product image then it is written at the returned key', async () => {
        const key = await ImageStorage.saveProductImage(PRODUCT_NO, 'image/png', PNG);
        expect(key).toMatch(new RegExp(`^${PRODUCT_NO}/product-\\d+\\.png$`));
        await expect(fs.readFile(path.join(local.root, key))).resolves.toEqual(PNG);
    });

    test('given a variant image then it is written alongside its product', async () => {
        const key = await ImageStorage.saveVariantImage(PRODUCT_NO, 3, 'image/webp', PNG);
        expect(key).toMatch(new RegExp(`^${PRODUCT_NO}/variant-3-\\d+\\.webp$`));
        await expect(fs.access(path.join(local.root, key))).resolves.toBeUndefined();
    });

    test('given a stored key when removed then the file is gone and removal is idempotent', async () => {
        const key = await ImageStorage.saveProductImage(PRODUCT_NO, 'image/png', PNG);
        await ImageStorage.removeImage(key);
        await expect(fs.access(path.join(local.root, key)))
            .rejects.toMatchObject({ code: 'ENOENT' });
        await expect(ImageStorage.removeImage(key)).resolves.toBeUndefined();
    });

    test('given no key then removal is a no-op rather than an error', async () => {
        await expect(ImageStorage.removeImage(null)).resolves.toBeUndefined();
        await expect(ImageStorage.removeImage('')).resolves.toBeUndefined();
    });

    test('given a key escaping the uploads root then reads and writes are refused', async () => {
        await expect(local.put('../../etc/evil.png', 'image/png', PNG))
            .rejects.toThrow(/outside the uploads root/);
        // A corrupted DB row must not delete anything outside uploads/ either.
        await expect(local.remove('../../etc/passwd')).resolves.toBeUndefined();
        await expect(fs.access('/etc/passwd')).resolves.toBeUndefined();
    });
});

describe('given the app asks how to serve /images then the local store answers with its directory', () => {

    test('given the local store then delivery is a static mount on the uploads root', () => {
        delete process.env.IMAGE_PROVIDER;
        expect(ImageStorage.publicDelivery()).toEqual({ mode: 'static', root: local.root });
    });

    test('given the s3 store then delivery is a redirect to the CDN base, trailing slash normalised', () => {
        const saved = process.env;
        process.env = {
            ...saved, IMAGE_PROVIDER: 's3', S3_BUCKET: 'store-images',
            IMAGE_PUBLIC_BASE_URL: 'https://cdn.example.com/images/',
        };
        try {
            jest.isolateModules(() => {
                expect(require('../services/images').publicDelivery())
                    .toEqual({ mode: 'redirect', baseUrl: 'https://cdn.example.com/images' });
            });
        } finally {
            process.env = saved;
        }
    });
});
