'use strict';

const Pagination = require('../common/pagination');
const Users      = require('../models/users');
const Rbac       = require('../models/rbac');

const UsersCntlr = function () {

    const EMAIL_REGEX      = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const ALLOWED_STATUSES = ['active', 'inactive'];

    return { find, findOne, createUser, update, deactivate, listRoles, grantRole, revokeRole };

    // POST /api/v1/users — body: { email, role, username? }
    // role is deliberately required: an implicit default here once handed out
    // admin, so privilege must always be an explicit choice by the caller.
    function createUser(req, res, next) {
        const { email, role, username } = req.body;

        if (!email) return next({ status: 400, message: 'email is required' });
        if (!EMAIL_REGEX.test(email)) return next({ status: 400, message: 'Invalid email address' });
        if (!role) return next({ status: 400, message: 'role is required' });

        Users.findByEmail(email)
            .then(existing => {
                if (existing) return next({ status: 409, message: 'Email already registered' });
                return Users.create({ email, role, username: username || null }, req.user.id);
            })
            .then(user => {
                if (!user) return; // short-circuit already handled by next()
                res.locals.results = { user };
                res.locals.status  = 201;
                res.locals.message = 'User created';
                next();
            })
            .catch(err => {
                if (err.message === 'Invalid role') return next({ status: 400, message: 'Invalid role' });
                next({ status: 500, message: 'Failed to create user' });
            });
    }

    // GET /api/v1/users?q=&role=&status=&staff=true
    function find(req, res, next) {
        const { page, pageSize, offset } = Pagination.parsePageQuery(req.query);
        const { role, status } = req.query;
        const staffOnly = req.query.staff === 'true' || req.query.staff === '1';

        if (status !== undefined && !ALLOWED_STATUSES.includes(status)) {
            return next({ status: 400, message: 'Invalid status filter' });
        }

        Users.findAll({ search: req.query.q, role, status, staffOnly, limit: pageSize, offset })
            .then(({ total, users }) => {
                res.locals.results = Pagination.pageResult('users', users, total, page, pageSize);
                res.locals.status  = 200;
                res.locals.message = 'Users returned';
                next();
            })
            .catch(err => {
                res.locals.status = 500;
                next({ status: 500, message: 'Failed to load users' });
            });
    }

    // GET /api/v1/users/:id
    function findOne(req, res, next) {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return next({ status: 400, message: 'Invalid user id' });

        Users.findById(id)
            .then(user => {
                if (!user) return next({ status: 404, message: 'User not found' });
                res.locals.results = { user };
                res.locals.status  = 200;
                res.locals.message = 'User returned';
                next();
            })
            .catch(() => next({ status: 500, message: 'Failed to load user' }));
    }

    // PUT /api/v1/users/:id
    function update(req, res, next) {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return next({ status: 400, message: 'Invalid user id' });

        if (id === req.user.id && req.body.role && req.body.role !== 'admin') {
            return next({ status: 403, message: 'Cannot demote your own account' });
        }
        if (id === req.user.id && req.body.status === 'inactive') {
            return next({ status: 403, message: 'Cannot deactivate your own account' });
        }

        Users.update(id, { role: req.body.role, status: req.body.status }, req.user.id)
            .then(user => {
                if (!user) return next({ status: 404, message: 'User not found' });
                res.locals.results = { user };
                res.locals.status  = 200;
                res.locals.message = 'User updated';
                next();
            })
            .catch(err => {
                const known = ['Invalid role', 'Invalid status', 'Nothing to update'];
                const status = known.includes(err.message) ? 400 : 500;
                next({ status, message: err.message || 'Failed to update user' });
            });
    }

    // DELETE /api/v1/users/:id
    function deactivate(req, res, next) {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return next({ status: 400, message: 'Invalid user id' });

        if (id === req.user.id) {
            return next({ status: 403, message: 'Cannot deactivate your own account' });
        }

        Users.deactivate(id)
            .then(user => {
                if (!user) return next({ status: 404, message: 'User not found' });
                res.locals.results = { user };
                res.locals.status  = 200;
                res.locals.message = 'User deactivated';
                next();
            })
            .catch(() => next({ status: 500, message: 'Failed to deactivate user' }));
    }

    // GET /api/v1/users/roles — all roles with their permissions (for the admin UI)
    function listRoles(req, res, next) {
        Rbac.listRoles()
            .then(roles => {
                res.locals.results = { roles };
                res.locals.status  = 200;
                res.locals.message = 'Roles returned';
                next();
            })
            .catch(() => next({ status: 500, message: 'Failed to load roles' }));
    }

    // POST /api/v1/users/:id/roles — grant an additional role. Body: { role }
    function grantRole(req, res, next) {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id))        return next({ status: 400, message: 'Invalid user id' });
        if (!req.body.role)   return next({ status: 400, message: 'role is required' });

        Rbac.grantRole(id, req.body.role, req.user.id)
            .then(granted => Rbac.getRolesForUser(id).then(roles => {
                res.locals.results = { roles };
                res.locals.status  = granted ? 201 : 200;
                res.locals.message = granted ? 'Role granted' : 'Role already held';
                next();
            }))
            .catch(err => next({ status: err.status || 500, message: err.message || 'Failed to grant role' }));
    }

    // DELETE /api/v1/users/:id/roles/:role — revoke a role.
    // A user's last role cannot be revoked here — set a new primary role instead.
    function revokeRole(req, res, next) {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return next({ status: 400, message: 'Invalid user id' });

        if (id === req.user.id && req.params.role === 'admin') {
            return next({ status: 403, message: 'Cannot revoke your own admin role' });
        }

        Rbac.getRolesForUser(id)
            .then(roles => {
                if (roles.length === 1 && roles[0] === req.params.role) {
                    return next({ status: 409, message: 'Cannot revoke the only role; set a new primary role instead' });
                }
                return Rbac.revokeRole(id, req.params.role, req.user.id).then(revoked => {
                    if (!revoked) return next({ status: 404, message: 'Role not held by user' });
                    return Rbac.getRolesForUser(id).then(remaining => {
                        res.locals.results = { roles: remaining };
                        res.locals.status  = 200;
                        res.locals.message = 'Role revoked';
                        next();
                    });
                });
            })
            .catch(err => next({ status: err.status || 500, message: err.message || 'Failed to revoke role' }));
    }

};

module.exports = UsersCntlr;
