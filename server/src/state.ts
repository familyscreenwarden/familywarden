import type { Pool, PoolClient } from 'pg';
import { evaluateRules, localTime, type RuleResult } from './rules';

export type Db = Pool | PoolClient;

export interface AccountRow {
  id: string;
  email: string;
  timezone: string;
  plan: 'trial' | 'active' | 'locked';
  trial_ends_at: Date;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  parent_pin_hash: string | null;
  pin_failed_count: number;
  pin_locked_until: Date | null;
  paused_all: boolean;
  created_at: Date;
}

export interface KidRow {
  id: string;
  account_id: string;
  name: string;
  color: string;
  limit_school_minutes: number;
  limit_weekend_minutes: number;
  bed_school_start: string;
  bed_school_end: string;
  bed_other_start: string;
  bed_other_end: string;
  bedtime_enabled: boolean;
  only_allowed_sites: boolean;
  safe_search: boolean;
  youtube_restricted: boolean;
  block_private: boolean;
  locked: boolean;
  created_at: Date;
}

export interface DeviceRow {
  id: string;
  account_id: string;
  kid_id: string;
  name: string;
  platform: 'windows' | 'android';
  model: string | null;
  os_version: string | null;
  app_version: string | null;
  token_hash: string;
  last_seen_at: Date | null;
  front_app: string | null;
  created_at: Date;
}

export interface AppRow {
  id: string;
  account_id: string;
  kid_id: string;
  kind: 'app' | 'site';
  platform: 'windows' | 'android' | 'any';
  identifier: string;
  name: string;
  allowed: boolean;
  free: boolean;
  limit_minutes: number | null;
  created_at: Date;
}

export interface ContactRow {
  id: string;
  account_id: string;
  kid_id: string;
  name: string;
  phone: string;
  can_call: boolean;
  can_text: boolean;
}

export interface RequestRow {
  id: string;
  account_id: string;
  kid_id: string;
  device_id: string | null;
  kind: 'time' | 'app' | 'site';
  minutes: number | null;
  detail: string;
  identifier: string | null;
  status: 'pending' | 'approved' | 'denied';
  created_at: Date;
  decided_at: Date | null;
  kid_name?: string;
  device_name?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function trialDaysLeft(account: AccountRow, now: Date): number {
  return Math.max(0, Math.ceil((account.trial_ends_at.getTime() - now.getTime()) / DAY_MS));
}

export function accountJson(a: AccountRow, now: Date): Record<string, unknown> {
  return {
    id: a.id,
    email: a.email,
    timezone: a.timezone,
    plan: a.plan,
    trialEndsAt: a.trial_ends_at.toISOString(),
    trialDaysLeft: trialDaysLeft(a, now),
    pausedAll: a.paused_all,
    hasPin: a.parent_pin_hash !== null,
  };
}

export function kidJson(k: KidRow): Record<string, unknown> {
  return {
    id: k.id,
    name: k.name,
    color: k.color,
    limitSchoolMinutes: k.limit_school_minutes,
    limitWeekendMinutes: k.limit_weekend_minutes,
    bedSchoolStart: k.bed_school_start,
    bedSchoolEnd: k.bed_school_end,
    bedOtherStart: k.bed_other_start,
    bedOtherEnd: k.bed_other_end,
    bedtimeEnabled: k.bedtime_enabled,
    onlyAllowedSites: k.only_allowed_sites,
    safeSearch: k.safe_search,
    youtubeRestricted: k.youtube_restricted,
    blockPrivate: k.block_private,
    locked: k.locked,
    createdAt: k.created_at.toISOString(),
  };
}

export function appJson(a: AppRow, usedMinutes: number): Record<string, unknown> {
  return {
    id: a.id,
    kidId: a.kid_id,
    kind: a.kind,
    platform: a.platform,
    identifier: a.identifier,
    name: a.name,
    allowed: a.allowed,
    free: a.free,
    limitMinutes: a.limit_minutes,
    usedMinutes,
    createdAt: a.created_at.toISOString(),
  };
}

export function contactJson(c: ContactRow): Record<string, unknown> {
  return { id: c.id, kidId: c.kid_id, name: c.name, phone: c.phone, canCall: c.can_call, canText: c.can_text };
}

export function requestJson(r: RequestRow): Record<string, unknown> {
  return {
    id: r.id,
    kidId: r.kid_id,
    kidName: r.kid_name ?? '',
    deviceId: r.device_id,
    deviceName: r.device_name ?? null,
    kind: r.kind,
    minutes: r.minutes,
    detail: r.detail,
    identifier: r.identifier,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
  };
}

export const DEVICE_OFF_AFTER_MS = 3 * 60 * 1000;

export type DeviceStatus = 'in_use' | 'locked' | 'off';

export function deviceStatus(d: DeviceRow, kidLocked: boolean, nowMs: number): DeviceStatus {
  if (!d.last_seen_at || nowMs - d.last_seen_at.getTime() > DEVICE_OFF_AFTER_MS) return 'off';
  return kidLocked ? 'locked' : 'in_use';
}

export function deviceJson(d: DeviceRow, kidName: string, status: DeviceStatus): Record<string, unknown> {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    model: d.model,
    osVersion: d.os_version,
    appVersion: d.app_version,
    kidId: d.kid_id,
    kidName,
    status,
    lastSeenAt: d.last_seen_at ? d.last_seen_at.toISOString() : null,
    frontApp: d.front_app,
    createdAt: d.created_at.toISOString(),
  };
}

export function todayJson(r: RuleResult): Record<string, unknown> {
  return {
    limitMinutes: r.limitMinutes,
    usedMinutes: r.usedMinutes,
    leftMinutes: r.leftMinutes,
    locked: r.locked,
    lockReason: r.lockReason,
  };
}

export interface KidState {
  kid: KidRow;
  apps: AppRow[];
  rules: RuleResult;
}

/**
 * Loads kids of ONE account with their apps, today's usage and grants, and evaluates the rules.
 * `kidId` narrows to one kid; an id from another account simply gives an empty list.
 */
export async function loadKidStates(
  db: Db,
  account: Pick<AccountRow, 'id' | 'timezone' | 'paused_all'>,
  now: Date,
  kidId?: string,
): Promise<KidState[]> {
  const kidsRes = kidId
    ? await db.query<KidRow>('SELECT * FROM kids WHERE account_id = $1 AND id = $2', [account.id, kidId])
    : await db.query<KidRow>('SELECT * FROM kids WHERE account_id = $1 ORDER BY created_at, id', [account.id]);
  const kids = kidsRes.rows;
  if (kids.length === 0) return [];
  const ids = kids.map((k) => k.id);
  const today = localTime(now, account.timezone).day;

  const [appsRes, usageRes, grantsRes] = await Promise.all([
    db.query<AppRow>(
      'SELECT * FROM apps WHERE account_id = $1 AND kid_id = ANY($2::uuid[]) ORDER BY lower(name), id',
      [account.id, ids],
    ),
    db.query<{ kid_id: string; app_id: string | null; minutes: number }>(
      `SELECT u.kid_id, u.app_id, SUM(u.minutes)::int AS minutes
         FROM usage u JOIN kids k ON k.id = u.kid_id
        WHERE k.account_id = $1 AND u.kid_id = ANY($2::uuid[]) AND u.day = $3
        GROUP BY u.kid_id, u.app_id`,
      [account.id, ids, today],
    ),
    db.query<{ kid_id: string; minutes: number }>(
      `SELECT g.kid_id, SUM(g.minutes)::int AS minutes
         FROM time_grants g JOIN kids k ON k.id = g.kid_id
        WHERE k.account_id = $1 AND g.kid_id = ANY($2::uuid[]) AND g.day = $3
        GROUP BY g.kid_id`,
      [account.id, ids, today],
    ),
  ]);

  return kids.map((kid) => {
    const apps = appsRes.rows.filter((a) => a.kid_id === kid.id);
    const rules = evaluateRules({
      now,
      timezone: account.timezone,
      pausedAll: account.paused_all,
      kid: {
        limitSchoolMinutes: kid.limit_school_minutes,
        limitWeekendMinutes: kid.limit_weekend_minutes,
        bedSchoolStart: kid.bed_school_start,
        bedSchoolEnd: kid.bed_school_end,
        bedOtherStart: kid.bed_other_start,
        bedOtherEnd: kid.bed_other_end,
        bedtimeEnabled: kid.bedtime_enabled,
        locked: kid.locked,
      },
      grantMinutes: grantsRes.rows.find((g) => g.kid_id === kid.id)?.minutes ?? 0,
      apps: apps.map((a) => ({ id: a.id, free: a.free, limitMinutes: a.limit_minutes })),
      usage: usageRes.rows.filter((u) => u.kid_id === kid.id).map((u) => ({ appId: u.app_id, minutes: u.minutes })),
    });
    return { kid, apps, rules };
  });
}

/** Moves trial accounts whose trial has ended to `locked`. Returns how many changed. */
export async function lockExpiredTrials(db: Db): Promise<number> {
  const res = await db.query("UPDATE accounts SET plan = 'locked' WHERE plan = 'trial' AND trial_ends_at <= now()");
  return res.rowCount ?? 0;
}

/** Housekeeping: removes sign-in links, sessions and pairing codes that can no longer be used. */
export async function purgeExpired(db: Db): Promise<void> {
  await db.query("DELETE FROM login_tokens WHERE expires_at < now() - interval '1 day'");
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  await db.query("DELETE FROM pairing_codes WHERE expires_at < now() - interval '1 day'");
}
