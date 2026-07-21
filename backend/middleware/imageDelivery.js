'use strict';

const express = require('express');
const { isImageKey } = require('../services/images/policy');

/**
 * Mounts public image delivery on an Express app, driven by the descriptor the
 * image store hands back (services/images.publicDelivery()).
 *
 * The store decides WHERE the bytes are; this decides how Express hands them
 * to a browser. A lookup map rather than a conditional chain, so a new
 * delivery mode is a new entry.
 */

/** Redirects are cached, but briefly enough that repointing a CDN takes effect the same day. */
const REDIRECT_CACHE_CONTROL = 'public, max-age=3600';

const MODES = {
    /** Local store: the API serves its own uploads directory. */
    static: (path, delivery) => express.static(delivery.root),

    /**
     * Object store: point readers at the CDN. A CDN that routes the image path
     * itself never reaches this — it is the safety net for a deployment whose
     * edge sends everything to the API.
     */
    redirect: (path, delivery) => (req, res, next) => {
        const key = req.path.replace(/^\//, '');
        // Anything that is not a key this app issued is a 404, not a redirect
        // target — the public URL space is exactly the set of generated keys.
        if (!isImageKey(key)) return next();
        res.set('Cache-Control', REDIRECT_CACHE_CONTROL);
        res.redirect(302, `${delivery.baseUrl}/${key}`);
    },
};

/**
 * @param {import('express').Application} app
 * @param {string} path      public URL prefix, e.g. '/images'
 * @param {{mode: string, root?: string, baseUrl?: string}} delivery
 */
function mountImageDelivery(app, path, delivery) {
    const build = MODES[delivery.mode];
    if (!build) throw new Error(`Unknown image delivery mode: ${delivery.mode}`);
    app.use(path, build(path, delivery));
}

module.exports = { mountImageDelivery };
