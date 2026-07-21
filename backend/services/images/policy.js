'use strict';

/**
 * Upload policy for catalog images — what may be uploaded, how large it may
 * be, and the key it is stored under.
 *
 * Deliberately independent of any storage adapter: the upload middleware must
 * not need to know which backing store is active to enforce a size limit, and
 * every adapter must derive the SAME key from the same input so `primary_image`
 * rows stay portable when a deployment switches provider.
 */

/** Accepted upload content types and the extension each is stored with. */
const ALLOWED_IMAGE_TYPES = Object.freeze({
    'image/jpeg': 'jpg',
    'image/png':  'png',
    'image/webp': 'webp',
    'image/gif':  'gif',
});

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Storage key for one image: "<product_no>/<baseName>-<timestamp>.<ext>".
 *
 * Names are generated here and never taken from the client, so a stored key
 * can be trusted when it is later served or deleted. The timestamp makes every
 * key write-once, which is what allows images to be served with a far-future
 * immutable cache header.
 *
 * @param {number} productNo
 * @param {string} baseName   'product' or 'variant-<variant_no>'
 * @param {string} mimetype
 * @returns {string}
 */
function imageKey(productNo, baseName, mimetype) {
    const ext = ALLOWED_IMAGE_TYPES[mimetype];
    if (!ext) {
        throw Object.assign(new Error(`Unsupported image type "${mimetype}"`), { status: 400 });
    }
    return `${productNo}/${baseName}-${Date.now()}.${ext}`;
}

/**
 * Exactly the shape imageKey() produces. Used to reject anything else before
 * it is echoed into a redirect target or a store lookup — a key arriving from
 * outside (a URL path, an old database row) is input until it matches this.
 */
const IMAGE_KEY_PATTERN = /^\d+\/[A-Za-z0-9._-]+$/;

/** @param {string} key @returns {boolean} */
function isImageKey(key) {
    return typeof key === 'string' && IMAGE_KEY_PATTERN.test(key);
}

module.exports = { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, imageKey, isImageKey };
