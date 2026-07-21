'use strict';

/**
 * Image-store adapter registry.
 *
 * Selection is the IMAGE_PROVIDER environment variable only. Unlike the mail
 * and search ports there is deliberately NO app_settings override: a running
 * store that switched backing store would strand every file already written to
 * the previous one, so this is a deploy-time decision, not a store-owner
 * setting.
 */

/** Valid IMAGE_PROVIDER values. Keep in sync with common/config.js. */
const IMAGE_PROVIDERS = ['local', 's3'];

const ADAPTERS = {
    get local() { return require('./localAdapter'); },
    get s3()    { return require('./s3Adapter'); },
};

/**
 * The adapter this deployment stores images with.
 * @returns {{provider: string, put: Function, remove: Function}}
 */
function getImageStore() {
    const name = process.env.IMAGE_PROVIDER || 'local';
    const adapter = ADAPTERS[name];
    if (!adapter) throw new Error(`Unknown image provider: ${name}`);
    return adapter;
}

module.exports = { getImageStore, IMAGE_PROVIDERS };
