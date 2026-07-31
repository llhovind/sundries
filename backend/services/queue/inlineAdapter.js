'use strict';

/**
 * Inline queue adapter — no queue at all. Enqueuing runs the handler on the
 * calling stack, in-process.
 *
 * Two legitimate users:
 *   - tests, which want a job's effects visible on the next line rather than
 *     after a poll interval;
 *   - installs that deliberately run no background worker.
 *
 * The tradeoff is explicit rather than hidden: recurring work does not fire,
 * because nothing here holds a clock. start() logs exactly which scheduled
 * queues have been dropped so an operator who selected this adapter by
 * accident sees it in the first seconds of the log rather than discovering
 * weeks later that reservations were never swept.
 */

const { log } = require('../../common/logger');

/** @type {Map<string, import('./index').Consumer>} */
const consumersByQueue = new Map();
let running = false;

/**
 * @param {import('./index').Consumer[]} consumers
 */
async function start(consumers) {
    consumersByQueue.clear();
    for (const consumer of consumers) consumersByQueue.set(consumer.queue, consumer);

    const dropped = consumers.filter(c => c.schedule).map(c => c.queue);
    if (dropped.length) {
        log('warn', 'inline queue adapter runs no scheduled work', { queues: dropped });
    }
    running = true;
}

async function stop() {
    consumersByQueue.clear();
    running = false;
}

/**
 * Runs the handler immediately. Errors propagate — the caller is on the same
 * stack and there is no retry behind this adapter, so swallowing here would
 * lose the work with nobody informed. services/jobs.js decides which callers
 * can tolerate that.
 *
 * @param {string} queue
 * @param {object} data
 * @returns {Promise<null>} always null — inline work has no job id
 */
async function send(queue, data) {
    const consumer = consumersByQueue.get(queue);
    if (!consumer) throw new Error(`No consumer registered for queue: ${queue}`);
    await consumer.handler(data);
    return null;
}

module.exports = {
    provider: 'inline',
    durable:  false,
    start,
    stop,
    send,
    isRunning: () => running,
};
