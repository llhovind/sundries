'use strict';

const { DB: db } = require('../../common/db');
const { isoToday, isoDaysAgo } = require('../../services/reporting/dates');

/**
 * Shrinkage (write-offs) over a period, grouped by reason code — remnants of
 * measured goods, damage, count corrections.
 */
module.exports = {
    slug:     'shrinkage',
    name:     'Shrinkage',
    descr:    'Write-off cost by reason code',
    category: 'finance',
    mode:     'immediate',
    params: [
        { name: 'from', label: 'From', type: 'date', default: () => isoDaysAgo(30) },
        { name: 'to',   label: 'To',   type: 'date', default: isoToday },
    ],
    columns: [
        { key: 'reason',  label: 'Reason',  format: 'text' },
        { key: 'entries', label: 'Entries', format: 'int' },
        { key: 'units',   label: 'Units',   format: 'qty' },
        { key: 'cost',    label: 'Cost',    format: 'money' },
    ],

    run({ from, to }) {
        return db.query(
            `SELECT COALESCE(t.reason_code, 'unspecified') AS reason,
                    COUNT(*)::int                          AS entries,
                    SUM(-t.qty)                            AS units,
                    ROUND(SUM(-t.qty * t.unit_cost), 2)    AS cost
             FROM inventory_transactions t
             WHERE t._trn_type = 'ADJ' AND t.qty < 0
               AND t._trn_dt >= $1::date AND t._trn_dt < $2::date + 1
             GROUP BY t.reason_code
             ORDER BY cost DESC`,
            [from, to]
        ).then(res => res.rows);
    },
};
