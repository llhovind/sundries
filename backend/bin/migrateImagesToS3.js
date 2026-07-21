#!/usr/bin/env node
'use strict';

/**
 * One-off copy of the local uploads/ directory into the configured S3 bucket,
 * for a deployment moving from IMAGE_PROVIDER=local to s3.
 *
 * No database writes: both adapters address images by the SAME key, so every
 * primary_image row is already correct once the bytes are in the bucket. That
 * is what makes the cutover reversible — run this, flip IMAGE_PROVIDER, and
 * leave uploads/ in place until you are satisfied.
 *
 * Idempotent: re-uploading a key overwrites it with identical bytes, so a
 * partial run is fixed by running it again.
 *
 * Usage:
 *   IMAGE_PROVIDER=s3 S3_BUCKET=... IMAGE_PUBLIC_BASE_URL=... \
 *     node bin/migrateImagesToS3.js [--dry-run]
 */

require('../common/config');   // validates env, throws early if incomplete

const fs   = require('fs/promises');
const path = require('path');

const { log }    = require('../common/logger');
const local      = require('../services/images/localAdapter');
const s3         = require('../services/images/s3Adapter');
const { ALLOWED_IMAGE_TYPES, isImageKey } = require('../services/images/policy');

/** Extension → mimetype, inverted from the upload policy so the two cannot drift. */
const MIMETYPE_BY_EXT = Object.entries(ALLOWED_IMAGE_TYPES)
    .reduce((acc, [mimetype, ext]) => ({ ...acc, [ext]: mimetype }), {});

const dryRun = process.argv.includes('--dry-run');

main()
    .then(({ copied, skipped }) => {
        log('info', 'image migration finished', { copied, skipped, dryRun });
        process.exit(skipped > 0 ? 2 : 0);   // non-zero: some files need a human
    })
    .catch(err => {
        log('error', 'image migration failed', { error: err.message });
        process.exit(1);
    });

async function main() {
    if (process.env.IMAGE_PROVIDER !== 's3') {
        throw new Error("IMAGE_PROVIDER must be 's3' — this script migrates local images INTO the bucket");
    }

    const keys = await localImageKeys();
    log('info', 'migrating local images to s3', { count: keys.length, dryRun });

    let copied = 0;
    let skipped = 0;
    for (const key of keys) {
        if (!isImageKey(key)) {
            log('warn', 'skipping file that is not a recognised image key', { key });
            skipped++;
            continue;
        }
        const mimetype = MIMETYPE_BY_EXT[path.extname(key).slice(1).toLowerCase()];
        if (!mimetype) {
            log('warn', 'skipping file with an unsupported extension', { key });
            skipped++;
            continue;
        }
        if (!dryRun) {
            await s3.put(key, mimetype, await fs.readFile(path.join(local.root, key)));
        }
        copied++;
        if (copied % 100 === 0) log('info', 'image migration progress', { copied, of: keys.length });
    }
    return { copied, skipped };
}

/**
 * Every stored key under uploads/ — one directory level (the product number)
 * deep, which is the whole layout policy.js produces.
 */
async function localImageKeys() {
    const dirs = await fs.readdir(local.root, { withFileTypes: true })
        .catch(err => { if (err.code === 'ENOENT') return []; throw err; });

    const keys = [];
    for (const dir of dirs.filter(entry => entry.isDirectory())) {
        const files = await fs.readdir(path.join(local.root, dir.name), { withFileTypes: true });
        keys.push(...files.filter(f => f.isFile()).map(f => `${dir.name}/${f.name}`));
    }
    return keys;
}
