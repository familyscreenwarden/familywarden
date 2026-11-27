// Shapes follow SPEC.md "Parent API". Fields the spec does not spell out
// (kid, app, contact, device and request rows) are assumed to be the
// camelCase form of the data-model columns.

export type Plan = 'trial' | 'active' | 'locked';
export type Platform = 'windows' | 'android';
export type AppPlatform = Platform | 'any';
export type LockReason = 'paused' | 'parent' | 'bedtime' | 'time' | null;
export type DeviceStatus = 'in_use' | 'locked' | 'off';
export type RequestKind = 'time' | 'app' | 'site';
export type RequestStatus = 'pending' | 'approved' | 'denied';

export interface Account {
  id: string;
  email: string;
  timezone: string;
  plan: Plan;
  trialEndsAt: string | null;
  trialDaysLeft: number | null;
  pausedAll: boolean;
  hasPin: boolean;
}

export interface DashKid {
  id: string;
  name: string;
  color: string;
  limitMinutes: number;
  usedMinutes: number;
  leftMinutes: number;
  locked: boolean;
  lockReason: LockReason;
  statusText: string;
  bedtimeTonight: string | null;
}

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  kidId: string;
  kidName: string;
  status: DeviceStatus;
  lastSeenAt: string | null;
}

export interface KidRequest {
  id: string;
  kidId: string;
  kidName: string;
  deviceId?: string | null;
  deviceName: string | null;
  kind: RequestKind;
  minutes: number | null;
  detail: string | null;
  identifier?: string | null;
  status: RequestStatus;
  createdAt: string;
  decidedAt?: string | null;
}

export interface WeekDay {
  day: string;
  minutes: Record<string, number>;
}

export interface AppLimit {
  kidId: string;
  kidName: string;
  appName: string;
  usedMinutes: number;
  limitMinutes: number;
}

export interface Dashboard {
  kids: DashKid[];
  devices: Device[];
  requests: KidRequest[];
  week: WeekDay[];
  blocked: { day: string; count: number }[];
  appLimits: AppLimit[];
  familyPercent: number;
  pausedAll: boolean;
}

export interface Kid {
  id: string;
  name: string;
  color: string;
  limitSchoolMinutes: number;
  limitWeekendMinutes: number;
  bedSchoolStart: string;
  bedSchoolEnd: string;
  bedOtherStart: string;
  bedOtherEnd: string;
  bedtimeEnabled: boolean;
  onlyAllowedSites: boolean;
  safeSearch: boolean;
  youtubeRestricted: boolean;
  blockPrivate: boolean;
  locked: boolean;
}

export type KidPatch = Partial<Omit<Kid, 'id'>>;

export interface KidApp {
  id: string;
  kind: 'app' | 'site';
  platform: AppPlatform;
  identifier: string;
  name: string;
  allowed: boolean;
  free: boolean;
  limitMinutes: number | null;
  usedMinutes: number;
}

export interface NewApp {
  kind: 'app' | 'site';
  platform?: AppPlatform;
  identifier: string;
  name: string;
  allowed?: boolean;
  free?: boolean;
  limitMinutes?: number | null;
}

export type AppPatch = Partial<Pick<KidApp, 'name' | 'allowed' | 'free' | 'limitMinutes'>>;

export interface Contact {
  id: string;
  name: string;
  phone: string;
  canCall: boolean;
  canText: boolean;
}

export type ContactInput = Omit<Contact, 'id'>;

export interface KidToday {
  limitMinutes: number;
  usedMinutes: number;
  leftMinutes: number;
  locked: boolean;
  lockReason: LockReason;
}

export interface KidDetail {
  kid: Kid;
  apps: KidApp[];
  contacts: Contact[];
  today: KidToday;
}

export interface PairingCode {
  code: string;
  expiresAt: string;
}

export interface ReportDay {
  day: string;
  minutes: number;
  byApp: { name: string; minutes: number }[];
}

export interface Report {
  days: ReportDay[];
  blocked: { host: string; count: number; lastAt: string }[];
}

export interface Billing {
  plan: Plan;
  trialEndsAt: string | null;
  trialDaysLeft: number | null;
  prices: { month: number; year: number };
  stripeReady: boolean;
}
