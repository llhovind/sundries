'use strict';

/**
 * Email validation, including the regression that motivated extracting it.
 *
 * The pattern behind isValidEmail backtracks quadratically on long
 * non-matching input, and it guards unauthenticated endpoints (OTP request,
 * registration, guest checkout) that run it before any rate limit engages.
 * Unbounded, a single 100kb request body blocked the event loop for ~5.4s;
 * the length cap is the only thing keeping that linear.
 */

const { isValidEmail, MAX_EMAIL_LENGTH } = require('../common/validation');

// Valid local part and '@', then repeated "b." pairs so the trailing character
// classes have a split point at every dot, terminated by a space so '$' is
// never reachable and the engine is forced to explore all of them.
function backtrackingPayload(bytes) {
    return `a@${'b.'.repeat(Math.floor(bytes / 2))} `;
}

describe('isValidEmail', () => {
    it('given a well-formed address when validated then it is accepted', () => {
        expect(isValidEmail('user@example.com')).toBe(true);
        expect(isValidEmail('first.last+tag@mail.example.co.uk')).toBe(true);
    });

    it('given a malformed address when validated then it is rejected', () => {
        for (const bad of ['', 'user', 'user@', '@example.com', 'user@example', 'user @example.com', 'a@b@c.com']) {
            expect(isValidEmail(bad)).toBe(false);
        }
    });

    it('given a non-string value when validated then it is rejected without coercion', () => {
        // String(['a@b.c']) === 'a@b.c', so a coercing check would accept this.
        for (const bad of [null, undefined, 42, {}, ['a@b.c']]) {
            expect(isValidEmail(bad)).toBe(false);
        }
    });

    it('given an address at the RFC 5321 length limit when validated then the limit is inclusive', () => {
        const domain = '@example.com';
        const atLimit = 'a'.repeat(MAX_EMAIL_LENGTH - domain.length) + domain;
        expect(atLimit).toHaveLength(MAX_EMAIL_LENGTH);
        expect(isValidEmail(atLimit)).toBe(true);
        expect(isValidEmail(`a${atLimit}`)).toBe(false);
    });

    it('given a 100kb backtracking payload when validated then it is rejected without stalling the event loop', () => {
        const payload = backtrackingPayload(102_400);
        expect(payload.length).toBeGreaterThan(100_000);

        const startedAt = process.hrtime.bigint();
        expect(isValidEmail(payload)).toBe(false);
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

        // Bounded input decides in microseconds. 100ms is loose enough to
        // absorb a loaded CI runner while still failing by three orders of
        // magnitude if the length cap is ever removed.
        expect(elapsedMs).toBeLessThan(100);
    });
});
