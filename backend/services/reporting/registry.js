'use strict';

const fs   = require('fs');
const path = require('path');
const { CATEGORIES } = require('./categories');
const { PARAM_TYPES } = require('./reportParams');

/**
 * Report registry — discovers report controllers at startup.
 *
 * Every file in controllers/reports/ is one report: metadata (category,
 * execution mode, params, columns) plus its query. The registry loads the
 * directory, validates each definition, and freezes the set. Nothing else in
 * the system enumerates reports — router, jobs, and UI all read from here —
 * so adding or removing a report is exactly one file.
 *
 * Failure isolation: a report file that fails to load (syntax error) or
 * fails validation is logged as a structured error and SKIPPED — one broken
 * report must never take the API down; the rest of the catalog still
 * serves. The cost is that a broken report silently vanishes from the
 * catalog until the boot log is read, so the log entry names the file and
 * the exact problem. Requests for a skipped report 404, and any queued runs
 * for it are failed gracefully by runService.
 *
 * Definition contract (see any file in controllers/reports/):
 *   slug      unique kebab-case id, must equal the filename
 *   name      display name
 *   descr     one-line description for the catalog UI
 *   category  key of CATEGORIES — decides the guarding permission
 *   mode      'immediate' — runs in-request, results returned directly
 *             'stored'    — runs generate persisted report_runs rows
 *                           (long-running and/or scheduled reports)
 *   schedule  cron string (stored mode only, optional) — periodic generation
 *   params    input declarations (see reportParams.js)
 *   columns   [{key, label, format}] — drives generic rendering & CSV
 *   run       async (params) => rows
 */

const REPORTS_DIR = path.join(__dirname, '../../controllers/reports');

const SLUG_REGEX     = /^[a-z][a-z0-9-]{1,49}$/;
const MODES          = ['immediate', 'stored'];
const COLUMN_FORMATS = ['text', 'int', 'qty', 'money', 'date', 'datetime', 'bool'];

function log(level, msg, extra = {}) {
    process.stdout.write(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }) + '\n');
}

function invalid(slugOrFile, problem) {
    throw new Error(`Invalid report definition "${slugOrFile}": ${problem}`);
}

function validateDefinition(def, filename) {
    const expectedSlug = path.basename(filename, '.js');
    if (def.slug !== expectedSlug) {
        invalid(filename, `slug "${def.slug}" must match filename "${expectedSlug}"`);
    }
    if (!SLUG_REGEX.test(def.slug))          invalid(def.slug, 'slug must be kebab-case');
    if (!def.name)                           invalid(def.slug, 'name is required');
    if (!def.descr)                          invalid(def.slug, 'descr is required');
    if (!CATEGORIES[def.category])           invalid(def.slug, `unknown category "${def.category}"`);
    if (!MODES.includes(def.mode))           invalid(def.slug, `mode must be one of: ${MODES.join(', ')}`);
    if (def.schedule && def.mode !== 'stored') {
        invalid(def.slug, 'schedule is only valid on stored reports');
    }
    if (!Array.isArray(def.params))          invalid(def.slug, 'params must be an array');
    for (const p of def.params) {
        if (!p.name || !p.label)             invalid(def.slug, 'every param needs name and label');
        if (!PARAM_TYPES.includes(p.type))   invalid(def.slug, `param "${p.name}" has unknown type "${p.type}"`);
        if (p.type === 'select' && (!Array.isArray(p.options) || p.options.length === 0)) {
            invalid(def.slug, `select param "${p.name}" needs options`);
        }
    }
    if (!Array.isArray(def.columns) || def.columns.length === 0) {
        invalid(def.slug, 'columns must be a non-empty array');
    }
    for (const c of def.columns) {
        if (!c.key || !c.label)              invalid(def.slug, 'every column needs key and label');
        if (c.format && !COLUMN_FORMATS.includes(c.format)) {
            invalid(def.slug, `column "${c.key}" has unknown format "${c.format}"`);
        }
    }
    if (typeof def.run !== 'function')       invalid(def.slug, 'run must be a function');
}

function loadDefinitions() {
    const bySlug = new Map();
    const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.js')).sort();
    for (const file of files) {
        // Per-file isolation: catches both a require() that throws (syntax
        // error) and a definition that fails validation.
        try {
            const def = require(path.join(REPORTS_DIR, file));
            validateDefinition(def, file);
            bySlug.set(def.slug, Object.freeze({ ...def }));
        } catch (err) {
            log('error', 'report definition skipped — fix or remove the file', {
                file, error: err.message,
            });
        }
    }
    return bySlug;
}

const definitions = loadDefinitions();

/** All reports, load order (filename-sorted). */
function list() {
    return [...definitions.values()];
}

/** @returns {object|null} the report definition, or null when unknown */
function get(slug) {
    return definitions.get(slug) || null;
}

/** Stored reports carrying a cron schedule — registered with the job runner. */
function scheduled() {
    return list().filter(def => def.schedule);
}

/** The permission code guarding a report (from its category). */
function permissionFor(def) {
    return CATEGORIES[def.category].permission;
}

module.exports = { list, get, scheduled, permissionFor };
