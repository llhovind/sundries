'use strict';

const multer = require('multer');
const { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES } = require('../services/imageStorage');

/**
 * Single-image upload middleware. The file is buffered in memory (bounded by
 * MAX_IMAGE_BYTES) and handed to the controller as req.file — persisting it
 * is the image-storage adapter's job, not the transport's.
 */
const upload = multer({
    storage: multer.memoryStorage(),
    limits:  { files: 1, fileSize: MAX_IMAGE_BYTES },
    fileFilter(_req, file, cb) {
        if (ALLOWED_IMAGE_TYPES[file.mimetype]) return cb(null, true);
        cb(Object.assign(
            new Error(`Unsupported image type "${file.mimetype}" — allowed: ${Object.keys(ALLOWED_IMAGE_TYPES).join(', ')}`),
            { status: 400 }));
    },
});

/** Multer's own errors (file too large, wrong field) are client faults, not 500s. */
function productImage(req, res, next) {
    upload.single('image')(req, res, err => {
        if (err instanceof multer.MulterError) err.status = 400;
        next(err);
    });
}

module.exports = { productImage };
