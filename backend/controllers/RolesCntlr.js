'use strict';

const Rbac = require('../models/rbac');

/**
 * Role & permission administration. All handlers sit behind roles:manage —
 * editing what a role can do is privilege escalation, so this permission is
 * granted to admin only by default and is deliberately separate from
 * users:manage.
 *
 * The permission catalog is read-only: permission codes are defined in
 * migrations and mapped to endpoints in config/routePermissions (code, not
 * data), so there is no create/delete API for them.
 */
const RolesCntlr = function () {

    return { find, create, update, setPermissions, remove, listPermissions };

    /** Normalizes model errors: status-tagged ones pass through as-is. */
    function fail(next, err, fallback) {
        next({ status: err.status || 500, message: err.status ? err.message : fallback });
    }

    // GET /api/v1/roles
    function find(req, res, next) {
        Rbac.listRoles()
            .then(roles => {
                res.locals.results = { roles };
                res.locals.status  = 200;
                res.locals.message = 'Roles returned';
                next();
            })
            .catch(err => fail(next, err, 'Failed to load roles'));
    }

    // GET /api/v1/roles/permissions
    function listPermissions(req, res, next) {
        Rbac.listPermissions()
            .then(permissions => {
                res.locals.results = { permissions };
                res.locals.status  = 200;
                res.locals.message = 'Permissions returned';
                next();
            })
            .catch(err => fail(next, err, 'Failed to load permissions'));
    }

    // POST /api/v1/roles — body: { code, name, descr? }
    function create(req, res, next) {
        const { code, name, descr } = req.body;

        Promise.resolve()
            .then(() => Rbac.createRole({ code, name, descr }, req.user.id))
            .then(role => {
                res.locals.results = { role };
                res.locals.status  = 201;
                res.locals.message = 'Role created';
                next();
            })
            .catch(err => fail(next, err, 'Failed to create role'));
    }

    // PUT /api/v1/roles/:code — body: { name?, descr? }
    function update(req, res, next) {
        const { name, descr } = req.body;

        Promise.resolve()
            .then(() => Rbac.updateRole(req.params.code, { name, descr }, req.user.id))
            .then(role => {
                res.locals.results = { role };
                res.locals.status  = 200;
                res.locals.message = 'Role updated';
                next();
            })
            .catch(err => fail(next, err, 'Failed to update role'));
    }

    // PUT /api/v1/roles/:code/permissions — body: { permissions: string[] }
    // Replaces the set atomically. Holders see the change on token refresh.
    function setPermissions(req, res, next) {
        Promise.resolve()
            .then(() => Rbac.setRolePermissions(req.params.code, req.body.permissions, req.user.id))
            .then(permissions => {
                res.locals.results = { role: req.params.code, permissions };
                res.locals.status  = 200;
                res.locals.message = 'Permissions updated; holders receive them on next token refresh';
                next();
            })
            .catch(err => fail(next, err, 'Failed to update permissions'));
    }

    // DELETE /api/v1/roles/:code
    function remove(req, res, next) {
        Promise.resolve()
            .then(() => Rbac.deleteRole(req.params.code, req.user.id))
            .then(() => {
                res.locals.results = { role: req.params.code };
                res.locals.status  = 200;
                res.locals.message = 'Role deleted';
                next();
            })
            .catch(err => fail(next, err, 'Failed to delete role'));
    }

};

module.exports = RolesCntlr;
