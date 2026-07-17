'use strict';

/**
 * CSV serialization for report downloads — driven entirely by a report's
 * column declarations, so every report downloads correctly with no
 * per-report code. RFC 4180 quoting: fields containing commas, quotes, or
 * newlines are quoted, quotes doubled.
 */

function escapeField(value) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {Array<{key:string, label:string}>} columns
 * @param {Array<object>} rows
 * @returns {string} CSV text with a header row
 */
function toCsv(columns, rows) {
    const header = columns.map(c => escapeField(c.label)).join(',');
    const lines = rows.map(row =>
        columns.map(c => escapeField(row[c.key])).join(',')
    );
    return [header, ...lines].join('\r\n') + '\r\n';
}

module.exports = { toCsv };
