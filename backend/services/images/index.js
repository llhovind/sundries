'use strict';

const { getImageStore } = require('./registry');
const { imageKey }      = require('./policy');
const config            = require('../../common/config');

/**
 * Catalog image storage. Owns what an image is called and which store it goes
 * to, so no other layer builds image paths or touches a disk or a bucket.
 *
 * Every save returns the storage KEY ("<product_no>/<filename>") for the caller
 * to persist in `primary_image`. The key is identical under every adapter, so
 * switching provider is a configuration change plus a file copy — never a data
 * migration.
 */
const ImageStorage = (function () {

    return { saveProductImage, saveVariantImage, removeImage, publicDelivery };

    /** Product-level primary image. */
    function saveProductImage(productNo, mimetype, buffer) {
        return write(productNo, 'product', mimetype, buffer);
    }

    /** Variant image, keyed under its product so both live together. */
    function saveVariantImage(productNo, variantNo, mimetype, buffer) {
        return write(productNo, `variant-${variantNo}`, mimetype, buffer);
    }

    async function write(productNo, baseName, mimetype, buffer) {
        const key = imageKey(productNo, baseName, mimetype);
        await getImageStore().put(key, mimetype, buffer);
        return key;
    }

    /** Removes a previously stored image; a key already gone is not an error. */
    function removeImage(key) {
        if (!key) return Promise.resolve();
        return getImageStore().remove(key);
    }

    /**
     * How this deployment serves /images, for the app layer to mount. Storage
     * knows where the bytes live; only the app layer knows about Express.
     *
     * 'static'   — the API serves them off its own disk (local store).
     * 'redirect' — the bytes are in object storage behind a CDN, so the API
     *              points readers there. A CDN that routes /images itself
     *              never hits this; it is the safety net for one that doesn't.
     *
     * @returns {{mode: 'static', root: string} | {mode: 'redirect', baseUrl: string}}
     */
    function publicDelivery() {
        const store = getImageStore();
        return store.provider === 'local'
            ? { mode: 'static',   root: store.root }
            : { mode: 'redirect', baseUrl: config.images.publicBaseUrl };
    }

}());

module.exports = ImageStorage;
