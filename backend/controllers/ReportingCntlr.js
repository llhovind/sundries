'use strict';

const registry           = require('../services/reporting/registry');
const RunService         = require('../services/reporting/runService');
const ReportRuns         = require('../models/reportRuns');
const { toCsv }          = require('../services/reporting/csv');
const { CATEGORIES }     = require('../services/reporting/categories');
const { validateParams, describeParams } = require('../services/reporting/reportParams');

/**
 * Generic HTTP surface of the reporting system. Deliberately knows nothing
 * about any individual report: reports are self-contained controllers in
 * controllers/reports/, discovered by the registry, and this module only
 * catalogs them, executes immediate ones, and manages stored runs. Adding or
 * removing a report never touches this file.
 *
 * Route guards (requireReportAccess) resolve :slug and stash the definition
 * on res.locals.reportDef, so a handler running here has already passed the
 * report's category permission check.
 */
const ReportingCntlr = function () {

    return { catalog, results, startRun, listRuns, getRun, download };

    function respond(res, next, status, message, results) {
        res.locals.status  = status;
        res.locals.message = message;
        res.locals.results = results;
        next();
    }

    function describeReport(def) {
        return {
            slug:     def.slug,
            name:     def.name,
            descr:    def.descr,
            category: def.category,
            mode:     def.mode,
            schedule: def.schedule || null,
            params:   describeParams(def.params),
            columns:  def.columns,
        };
    }

    // GET /api/v1/reports — categories and reports the caller may see.
    // Permission filtering is the same any-of check the per-report routes
    // enforce, so the catalog can never show a report the API would 403.
    function catalog(req, res, next) {
        const perms = req.user.perms || [];
        const categories = Object.values(CATEGORIES)
            .filter(cat => perms.includes(cat.permission))
            .map(cat => ({
                code:    cat.code,
                label:   cat.label,
                descr:   cat.descr,
                reports: registry.list()
                    .filter(def => def.category === cat.code)
                    .map(describeReport),
            }))
            .filter(cat => cat.reports.length > 0);
        respond(res, next, 200, 'report catalog', { categories });
    }

    // GET /api/v1/reports/:slug/results — execute an immediate report.
    function results(req, res, next) {
        const def = res.locals.reportDef;
        if (def.mode !== 'stored') {
            let params;
            try {
                params = validateParams(def.params, req.query);
            } catch (err) {
                return next({ status: err.status || 400, message: err.message });
            }
            return def.run(params)
                .then(rows => respond(res, next, 200, `${def.slug} report`,
                    { report: def.slug, params, columns: def.columns, rows }))
                .catch(err => next({ status: err.status || 500, message: err.message || 'Report failed' }));
        }
        return next({
            status: 400,
            message: `${def.slug} is generated in the background — start a run and fetch it from the runs list`,
        });
    }

    // POST /api/v1/reports/:slug/runs — queue a stored-report generation.
    function startRun(req, res, next) {
        RunService.startRun(res.locals.reportDef.slug, req.body || {}, req.user.id)
            .then(run => respond(res, next, 202, 'report run queued', { run }))
            .catch(err => next({ status: err.status || 500, message: err.message }));
    }

    // GET /api/v1/reports/:slug/runs — saved runs, newest first.
    function listRuns(req, res, next) {
        const def = res.locals.reportDef;
        if (def.mode !== 'stored') {
            return next({ status: 400, message: `${def.slug} runs immediately — it keeps no saved runs` });
        }
        ReportRuns.listForReport(def.slug)
            .then(runs => respond(res, next, 200, 'report runs', { runs }))
            .catch(next);
    }

    // GET /api/v1/reports/:slug/runs/:run_no — one saved run with its rows.
    function getRun(req, res, next) {
        const def = res.locals.reportDef;
        loadRun(def, req.params.run_no)
            .then(run => respond(res, next, 200, 'report run', {
                run: {
                    ...run,
                    result:  undefined,
                    columns: def.columns,
                    rows:    run.status === 'succeeded' ? run.result : null,
                },
            }))
            .catch(err => next({ status: err.status || 500, message: err.message }));
    }

    // GET /api/v1/reports/:slug/runs/:run_no/download — CSV attachment.
    // Bypasses the JSON envelope by design: this is a file, not an API body.
    function download(req, res, next) {
        const def = res.locals.reportDef;
        loadRun(def, req.params.run_no)
            .then(run => {
                if (run.status !== 'succeeded') {
                    return next({ status: 409, message: `Run ${run.run_no} is ${run.status} — nothing to download` });
                }
                const filename = `${def.slug}-${run.run_no}.csv`;
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
                res.status(200).send(toCsv(def.columns, run.result || []));
            })
            .catch(err => next({ status: err.status || 500, message: err.message }));
    }

    /** Fetch a run and verify it belongs to the addressed report. */
    async function loadRun(def, rawRunNo) {
        const runNo = parseInt(rawRunNo, 10);
        if (isNaN(runNo)) {
            throw Object.assign(new Error('run_no must be a number'), { status: 400 });
        }
        const run = await ReportRuns.get(runNo);
        // Slug mismatch is a 404, not a 403: the run exists but not under
        // this report — and cross-report probing must not leak categories.
        if (!run || run.report_slug !== def.slug) {
            throw Object.assign(new Error(`No run ${runNo} for report ${def.slug}`), { status: 404 });
        }
        return run;
    }

};

module.exports = ReportingCntlr;
