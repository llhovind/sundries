'use strict';

const fs   = require('fs/promises');
const path = require('path');

/**
 * Filesystem adapter for catalog images. Owns the uploads directory layout
 * (uploads/<product_no>/<filename>, served publicly at /images/...) so no
 * other layer touches the disk or builds image paths. Swapping the backing
 * store (e.g. for S3) means replacing this module only.
 */
const ImageStorage = (function () {

    const UPLOADS_ROOT = path.join(__dirname, '../uploads');

    /** Accepted upload content types and the extension each is stored with. */
    const ALLOWED_IMAGE_TYPES = Object.freeze({
        'image/jpeg': 'jpg',
        'image/png':  'png',
        'image/webp': 'webp',
        'image/gif':  'gif',
    });

    const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

    return { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, saveProductImage, saveVariantImage, removeImage };

    /** Product-level primary image: uploads/<product_no>/product-<ts>.<ext>. */
    function saveProductImage(productNo, mimetype, buffer) {
        return writeImage(productNo, 'product', mimetype, buffer);
    }

    /** Variant image, stored alongside its product: variant-<variant_no>-<ts>.<ext>. */
    function saveVariantImage(productNo, variantNo, mimetype, buffer) {
        return writeImage(productNo, `variant-${variantNo}`, mimetype, buffer);
    }

    /**
     * Persists an uploaded image buffer and returns the relative path
     * ("<product_no>/<filename>") to store in primary_image. Filenames are
     * generated here, never taken from the client, so any stored path can be
     * trusted when served or deleted later.
     */
    async function writeImage(productNo, baseName, mimetype, buffer) {
        const ext = ALLOWED_IMAGE_TYPES[mimetype];
        if (!ext) {
            throw Object.assign(new Error(`Unsupported image type "${mimetype}"`), { status: 400 });
        }
        const filename = `${baseName}-${Date.now()}.${ext}`;
        const dir = path.join(UPLOADS_ROOT, String(productNo));
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, filename), buffer);
        return `${productNo}/${filename}`;
    }

    /**
     * Removes a previously stored image. Refuses paths that resolve outside
     * the uploads root; a file already gone is not an error.
     */
    async function removeImage(relPath) {
        if (!relPath) return;
        const abs = path.resolve(UPLOADS_ROOT, relPath);
        if (!abs.startsWith(UPLOADS_ROOT + path.sep)) return;
        await fs.unlink(abs).catch(err => { if (err.code !== 'ENOENT') throw err; });
    }

}());

module.exports = ImageStorage;
