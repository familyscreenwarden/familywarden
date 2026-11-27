import type { Pool } from 'pg';
import { verifyPin } from './crypto';

export const PIN_MAX_TRIES = 5;
export const PIN_LOCK_MINUTES = 5;

export type PinResult =
  | { result: 'ok' }
  | { result: 'wrong'; triesLeft: number; lockedNow: boolean }
  | { result: 'no-pin' }
  | { result: 'locked-out'; retryAfterSeconds: number };

/**
 * Checks the family's parent PIN typed on a kid's device. 5 wrong tries lock PIN checks for 5 minutes (per family).
 * The try is counted BEFORE the PIN is compared, in one statement, so a burst of parallel guesses cannot get more
 * than 5 tries per lock-out window.
 */
export async function checkParentPin(pool: Pool, accountId: string, pin: string): Promise<PinResult> {
  const taken = await pool.query<{ parent_pin_hash: string; pin_failed_count: number; locked: boolean }>(
    `UPDATE accounts
        SET pin_failed_count = CASE WHEN pin_failed_count + 1 >= $2 THEN 0 ELSE pin_failed_count + 1 END,
            pin_locked_until = CASE WHEN pin_failed_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE NULL END
      WHERE id = $1 AND parent_pin_hash IS NOT NULL AND (pin_locked_until IS NULL OR pin_locked_until <= now())
      RETURNING parent_pin_hash, pin_failed_count, (pin_locked_until IS NOT NULL) AS locked`,
    [accountId, PIN_MAX_TRIES, PIN_LOCK_MINUTES],
  );
  const attempt = taken.rows[0];
  if (!attempt) {
    const why = await pool.query<{ has_pin: boolean; locked_seconds: number }>(
      `SELECT parent_pin_hash IS NOT NULL AS has_pin,
              COALESCE(GREATEST(0, CEIL(EXTRACT(EPOCH FROM (pin_locked_until - now())))), 0)::int AS locked_seconds
         FROM accounts WHERE id = $1`,
      [accountId],
    );
    const row = why.rows[0];
    if (row && !row.has_pin) return { result: 'no-pin' };
    return { result: 'locked-out', retryAfterSeconds: Math.max(1, row?.locked_seconds ?? PIN_LOCK_MINUTES * 60) };
  }
  if (await verifyPin(pin, attempt.parent_pin_hash)) {
    await pool.query('UPDATE accounts SET pin_failed_count = 0, pin_locked_until = NULL WHERE id = $1', [accountId]);
    return { result: 'ok' };
  }
  return attempt.locked
    ? { result: 'wrong', triesLeft: 0, lockedNow: true }
    : { result: 'wrong', triesLeft: PIN_MAX_TRIES - attempt.pin_failed_count, lockedNow: false };
}
