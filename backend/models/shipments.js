'use strict';

const { DB: db } = require('../common/db');
const { badRequest, optionalString } = require('../common/validation');

/**
 * Repository for shipment records (shipments + shipment_lines) — part of the
 * orders aggregate's fulfillment side. Rows are created only by
 * FulfillmentService inside the ship transaction; tracking details stay
 * editable afterward (labels are often printed after the ship action), but
 * shipments are never deleted.
 */
const Shipments = (function () {

    return { create, updateTracking, findByOrder, validateDetails };

    /** Normalize/validate the carrier/tracking/notes trio from a request body. */
    function validateDetails(data = {}) {
        return {
            carrier:     optionalString(data.carrier, 'carrier'),
            tracking_no: optionalString(data.tracking_no, 'tracking_no'),
            notes:       optionalString(data.notes, 'notes'),
        };
    }

    /**
     * Records one ship event and the lines that left in it. Runs on the ship
     * transaction's client so the shipment commits (or rolls back) with the
     * line transitions themselves.
     *
     * @param {import('pg').PoolClient} client
     * @param {{ordNo:number, shippedBy:number, carrier:string|null,
     *          tracking_no:string|null, notes:string|null,
     *          lines:Array<{id:number, qty:number}>}} shipment
     * @returns {Promise<number>} shipment_no
     */
    async function create(client, { ordNo, shippedBy, carrier, tracking_no, notes, lines }) {
        const res = await client.query(
            `INSERT INTO shipments (_ord_no, carrier, tracking_no, notes, shipped_by,
                                    _modify_ts, _modify_user_id)
             VALUES ($1, $2, $3, $4, $5, NOW(), $5)
             RETURNING shipment_no`,
            [ordNo, carrier, tracking_no, notes, shippedBy]
        );
        const shipmentNo = res.rows[0].shipment_no;
        for (const line of lines) {
            await client.query(
                `INSERT INTO shipment_lines (_shipment_no, _order_line_id, qty)
                 VALUES ($1, $2, $3)`,
                [shipmentNo, line.id, line.qty]
            );
        }
        return shipmentNo;
    }

    /**
     * Corrects/completes carrier, tracking number, or notes on an existing
     * shipment. The order number is part of the WHERE so a shipment can only
     * be addressed through its own order.
     *
     * @returns {Promise<object|null>} updated shipment, or null when not found
     */
    function updateTracking(shipmentNo, ordNo, data, userId) {
        const d = validateDetails(data);
        if (d.carrier === null && d.tracking_no === null && d.notes === null) {
            throw badRequest('Nothing to update: provide carrier, tracking_no or notes');
        }
        return db.query(
            `UPDATE shipments
             SET carrier     = COALESCE($3, carrier),
                 tracking_no = COALESCE($4, tracking_no),
                 notes       = COALESCE($5, notes),
                 _modify_ts = NOW(), _modify_user_id = $6
             WHERE shipment_no = $1 AND _ord_no = $2
             RETURNING shipment_no, _ord_no AS ord_no, carrier, tracking_no, notes, shipped_at`,
            [shipmentNo, ordNo, d.carrier, d.tracking_no, d.notes, userId]
        ).then(res => res.rows[0] || null);
    }

    /** All ship events for an order, each with its lines, oldest first. */
    function findByOrder(ordNo) {
        return db.query(
            `SELECT s.shipment_no, s.carrier, s.tracking_no, s.notes, s.shipped_at,
                    COALESCE(
                        json_agg(json_build_object(
                            'ln_no', ol.ln_no, 'sku', ol.sku, 'descr', ol.descr, 'qty', sl.qty
                        ) ORDER BY ol.ln_no) FILTER (WHERE sl.id IS NOT NULL),
                        '[]'
                    ) AS lines
             FROM shipments s
             LEFT JOIN shipment_lines sl ON sl._shipment_no = s.shipment_no
             LEFT JOIN order_lines ol    ON ol.id = sl._order_line_id
             WHERE s._ord_no = $1
             GROUP BY s.shipment_no
             ORDER BY s.shipment_no`,
            [ordNo]
        ).then(res => res.rows);
    }

}());

module.exports = Shipments;
