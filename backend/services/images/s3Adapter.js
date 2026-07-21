'use strict';

const config = require('../../common/config');

/**
 * S3 adapter for the image-store port — the shared store any deployment with
 * more than one API instance needs, since a locally written file is invisible
 * to the instance that serves the next request.
 *
 * Requires: `npm install @aws-sdk/client-s3`. Credentials come from the
 * standard AWS chain (task/instance role, env vars, ~/.aws) — nothing custom.
 * The SDK is required lazily so local-storage installs never need it.
 *
 * The bucket stays PRIVATE: nothing here grants public read. Images are served
 * by a CDN reading the bucket directly (CloudFront + Origin Access Control),
 * so the API is only ever a writer. The IAM policy this adapter needs is
 * therefore just PutObject + DeleteObject on <bucket>/<prefix>/* — no
 * GetObject, no ListBucket.
 *
 * Env: S3_BUCKET (required), S3_PREFIX (default 'images'), AWS_REGION (standard).
 */
const S3ImageAdapter = (function () {

    /** Long, immutable: policy.js timestamps every key, so a key is never rewritten. */
    const CACHE_CONTROL = 'public, max-age=31536000, immutable';
    const REQUEST_TIMEOUT_MS = 10000;
    const MAX_ATTEMPTS = 3;

    let client   = null;
    let commands = null;

    return { provider: 's3', put, remove };

    function s3() {
        if (!client) {
            // eslint-disable-next-line global-require
            const sdk = require('@aws-sdk/client-s3');
            commands = { PutObjectCommand: sdk.PutObjectCommand, DeleteObjectCommand: sdk.DeleteObjectCommand };
            client = new sdk.S3Client({
                maxAttempts: MAX_ATTEMPTS,
                requestHandler: { requestTimeout: REQUEST_TIMEOUT_MS },
            });
        }
        return client;
    }

    /**
     * Bucket key for a storage key. The prefix exists so a CDN can map the
     * public /images/* path straight onto bucket objects with no rewrite rule
     * — keep S3_PREFIX and the public path aligned.
     */
    function bucketKey(key) {
        return `${config.images.prefix}/${key}`;
    }

    async function put(key, mimetype, buffer) {
        await s3().send(new commands.PutObjectCommand({
            Bucket:       config.images.bucket,
            Key:          bucketKey(key),
            Body:         buffer,
            ContentType:  mimetype,
            CacheControl: CACHE_CONTROL,
        }));
    }

    /** S3 DeleteObject is already idempotent — a missing key succeeds. */
    async function remove(key) {
        await s3().send(new commands.DeleteObjectCommand({
            Bucket: config.images.bucket,
            Key:    bucketKey(key),
        }));
    }

}());

module.exports = S3ImageAdapter;
