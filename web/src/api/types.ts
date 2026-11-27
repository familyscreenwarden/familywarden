// Shapes follow SPEC.md "Parent API". Fields the spec does not spell out
// (kid, app, contact, device and request rows) are assumed to be the
// camelCase form of the data-model columns.

export type Plan = 'trial' | 'active' | 'locked';
export type Platform = 'windows' | 'android';
export type AppPlatform = Platform | 'any';
export type LockReason = 'paused' | 'parent' | 'bedtime' | 'time' | null;
export type DeviceStatus = 'in_use' | 'locked' | 'off';
export type RequestKind = 'time' | 'app' | 'site' | 'contact';
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
  /** Present and false when the server has the paywall switched off. */
  billingEnabled?: boolean;
}

// ---- Phones, chores, texts, APKs (SPEC.md "Android phones and the compatibility device API") ----

export interface ChoreApproval {
  id: string;
  choreId: string;
  choreName: string;
  kidId: string;
  kidName: string;
  deviceName: string | null;
  minutes: number;
  day: string;
  status: 'pending' | 'approved' | 'declined';
  createdAt: string;
  decidedAt: string | null;
}

export type ChoreRepeat = 'once' | 'daily' | 'weekly';

export interface Chore {
  id: string;
  kidId: string;
  name: string;
  minutes: number;
  repeat: ChoreRepeat;
  active: boolean;
  /** What the kid's launcher shows for it today. */
  today: 'todo' | 'waiting' | 'done' | 'hidden';
}

export type ChoreInput = Pick<Chore, 'name' | 'minutes' | 'repeat'>;

export interface PhoneRules {
  blockSettings: boolean;
  blockReset: boolean;
  blockSafeBoot: boolean;
  blockInstalls: boolean;
  blockAccounts: boolean;
  blockUsb: boolean;
  emergencyNumber: string;
  playMinutes: number;
}

export type LauncherTheme = 'galaxy' | 'ocean' | 'jungle' | 'sunset';

export interface LauncherLook {
  layout: string;
  theme: LauncherTheme;
  lookLocked: boolean;
}

export interface PhoneContact extends Contact {
  /** Reachable even when the phone is locked (time is up, bedtime, a parent's lock). */
  always: boolean;
}

export interface KidPhoneDevice {
  id: string;
  name: string;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  lastSeenAt: string | null;
  battery: number | null;
  charging: boolean | null;
  deviceOwner: boolean | null;
  usageAccess: boolean | null;
  canUnlock: boolean;
}

export interface TimeCode { code: string; minutes: number; expiresAt: string }

export interface KidPhone {
  rules: PhoneRules;
  launcher: LauncherLook;
  contacts: PhoneContact[];
  phones: KidPhoneDevice[];
  timeCodes: TimeCode[];
}

export interface AppRelease { version: string; size: number; sha256: string; notes: string; createdAt: string }
export interface AndroidApp { latest: AppRelease | null; package: string; admin: string }

export interface WifiInput { ssid: string; password?: string; security: 'WPA' | 'WEP' | 'NONE' }

export interface SetupQr {
  code: string;
  expiresAt: string;
  minutes: number;
  version: string;
  /** The QR code for Android's setup screen, as an SVG picture. */
  svg: string;
  /** A link any phone camera opens (quick install, no lock-down), and its QR code. */
  link: string;
  linkSvg: string;
}

export interface UnlockCode { code: string; counter: number; expiresAt: string }

export interface ApkPush { id: string; deviceId: string; deviceName: string; kidName: string; status: 'waiting' | 'installing' | 'done' | 'failed'; message: string | null; at: string }
export interface Apk { id: string; name: string; fileName: string | null; package: string | null; size: number; sha256: string; createdAt: string; pushes: ApkPush[] }

export interface PhoneText {
  id: string;
  dir: 'in' | 'out';
  from: string | null;
  fromName: string | null;
  body: string;
  at: string;
  status: string;
  media: { id: string | null; type: string; url: string | null }[];
}

export interface TextThread { thread: string; names: string[]; at: string; count: number; last: { dir: 'in' | 'out'; fromName: string | null; body: string } }

export interface KidTexts {
  keepDays: number;
  held: PhoneText[];
  threads: TextThread[];
  blocked: { num: string; phone: string; at: string }[];
}

export interface ChatMessage {
  id: string;
  /** The kid who wrote it; null when a parent did. */
  kidId: string | null;
  from: string;
  color: string | null;
  text: string;
  at: string;
}
