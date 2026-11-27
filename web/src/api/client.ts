import type {
  Account, AndroidApp, Apk, AppPatch, Billing, ChatMessage, Chore, ChoreApproval, ChoreInput, ContactInput, Dashboard, Device, Kid, KidDetail,
  KidPatch, KidPhone, KidRequest, KidTexts, LauncherLook, NewApp, PairingCode, PhoneRules, PhoneText, Platform, Report, SetupQr,
  TimeCode, UnlockCode, WifiInput,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly locked: boolean;
  constructor(message: string, status: number, locked = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.locked = locked;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiHooks {
  /** Called on any 401 (the session is missing or has ended). */
  onUnauthorized?: () => void;
  /** Called on a 402 whose body carries locked:true (trial over, no plan). */
  onLocked?: () => void;
}

const FALLBACK: Record<number, string> = {
  401: 'Please sign in again.',
  402: 'Your free trial has ended. Choose a plan to keep using the console.',
  404: 'That could not be found. It may have been removed.',
  429: 'Too many tries. Please wait a little and try again.',
  503: 'This is not available right now. Please try again later.',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** A sentence a parent can read, for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return 'Something went wrong. Please try again.';
}

export function createApi(fetchFn: FetchLike, hooks: ApiHooks = {}) {
  /** `file`: the body is a file (an APK upload), sent as it is with the headers the server asks for. */
  async function request<T>(method: string, path: string, body?: unknown, file?: { data: Blob; name: string }): Promise<T> {
    let res: Response;
    try {
      res = await fetchFn(path, file ? {
        method,
        credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/vnd.android.package-archive', 'X-FSW-Upload': '1', 'X-Filename': encodeURIComponent(file.name) },
        body: file.data,
      } : {
        method,
        credentials: 'include',
        headers: body === undefined
          ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError('Cannot reach Family Screen Warden. Check your connection and try again.', 0);
    }

    let data: unknown = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }

    if (res.ok) return data as T;

    const serverMsg = isRecord(data) && typeof data.error === 'string' && data.error ? data.error : null;
    const locked = res.status === 402 && isRecord(data) && data.locked === true;
    const err = new ApiError(
      serverMsg ?? FALLBACK[res.status] ?? 'Something went wrong. Please try again.',
      res.status,
      locked,
    );
    if (res.status === 401) hooks.onUnauthorized?.();
    else if (locked) hooks.onLocked?.();
    throw err;
  }

  const get = <T>(p: string) => request<T>('GET', p);
  const post = <T>(p: string, b: unknown = {}) => request<T>('POST', p, b);
  const patch = <T>(p: string, b: unknown) => request<T>('PATCH', p, b);
  const put = <T>(p: string, b: unknown) => request<T>('PUT', p, b);
  const del = <T>(p: string) => request<T>('DELETE', p);
  const id = encodeURIComponent;

  return {
    request,
    requestLink: (email: string) => post<{ ok: true; devLink?: string }>('/api/auth/request-link', { email }),
    logout: () => post<{ ok: true }>('/api/auth/logout'),
    config: () => get<{ billingEnabled: boolean }>('/api/config'),
    me: () => get<{ account: Account; billingEnabled?: boolean }>('/api/me'),
    updateAccount: (b: { timezone?: string; pin?: string }) => patch<unknown>('/api/account', b),

    dashboard: () => get<Dashboard>('/api/dashboard'),
    pauseAll: (paused: boolean) => post<unknown>('/api/pause-all', { paused }),

    kids: () => get<{ kids: Kid[] }>('/api/kids'),
    createKid: (b: { name: string; color?: string }) => post<unknown>('/api/kids', b),
    kid: (kidId: string) => get<KidDetail>(`/api/kids/${id(kidId)}`),
    updateKid: (kidId: string, b: KidPatch) => patch<unknown>(`/api/kids/${id(kidId)}`, b),
    deleteKid: (kidId: string) => del<unknown>(`/api/kids/${id(kidId)}`),
    grant: (kidId: string, minutes: number) => post<unknown>(`/api/kids/${id(kidId)}/grant`, { minutes }),
    lock: (kidId: string, locked: boolean) => post<unknown>(`/api/kids/${id(kidId)}/lock`, { locked }),

    createApp: (kidId: string, b: NewApp) => post<unknown>(`/api/kids/${id(kidId)}/apps`, b),
    updateApp: (appId: string, b: AppPatch) => patch<unknown>(`/api/apps/${id(appId)}`, b),
    deleteApp: (appId: string) => del<unknown>(`/api/apps/${id(appId)}`),

    createContact: (kidId: string, b: ContactInput) => post<unknown>(`/api/kids/${id(kidId)}/contacts`, b),
    updateContact: (cId: string, b: Partial<ContactInput>) => patch<unknown>(`/api/contacts/${id(cId)}`, b),
    deleteContact: (cId: string) => del<unknown>(`/api/contacts/${id(cId)}`),

    devices: () => get<{ devices: Device[] }>('/api/devices'),
    pairingCode: (kidId: string, platform: Platform) =>
      post<PairingCode>('/api/devices/pairing-code', { kidId, platform }),
    updateDevice: (dId: string, b: { name?: string; kidId?: string }) => patch<unknown>(`/api/devices/${id(dId)}`, b),
    deleteDevice: (dId: string) => del<unknown>(`/api/devices/${id(dId)}`),

    requests: (status: 'pending' | 'all') => get<{ requests: KidRequest[] }>(`/api/requests?status=${status}`),
    decide: (rId: string, approve: boolean) => post<unknown>(`/api/requests/${id(rId)}/decide`, { approve }),

    reports: (kidId: string, days: 7 | 30) => get<Report>(`/api/reports?kidId=${id(kidId)}&days=${days}`),

    // Phones, chores, texts and APKs.
    androidApp: () => get<AndroidApp>('/api/android-app'),
    setupQr: (kidId: string, wifi: WifiInput | null) => post<SetupQr>('/api/devices/android-qr', wifi ? { kidId, wifi } : { kidId }),
    unlockCode: (dId: string) => post<UnlockCode>(`/api/devices/${id(dId)}/unlock-code`),
    kidPhone: (kidId: string) => get<KidPhone>(`/api/kids/${id(kidId)}/phone`),
    savePhoneRules: (kidId: string, b: PhoneRules) => put<unknown>(`/api/kids/${id(kidId)}/phone-rules`, b),
    saveLauncher: (kidId: string, b: LauncherLook) => put<unknown>(`/api/kids/${id(kidId)}/launcher`, b),
    setContactAlways: (cId: string, always: boolean) => patch<unknown>(`/api/contacts/${id(cId)}`, { always }),
    timeCode: (kidId: string, minutes: number) => post<TimeCode>(`/api/kids/${id(kidId)}/time-code`, { minutes }),
    chores: (kidId: string) => get<{ chores: Chore[] }>(`/api/kids/${id(kidId)}/chores`),
    createChore: (kidId: string, b: ChoreInput) => post<unknown>(`/api/kids/${id(kidId)}/chores`, b),
    updateChore: (cId: string, b: Partial<ChoreInput & { active: boolean }>) => patch<unknown>(`/api/chores/${id(cId)}`, b),
    deleteChore: (cId: string) => del<unknown>(`/api/chores/${id(cId)}`),
    choreApprovals: (status: 'pending' | 'all') => get<{ approvals: ChoreApproval[] }>(`/api/chore-approvals?status=${status}`),
    decideChore: (aId: string, approve: boolean) => post<unknown>(`/api/chore-approvals/${id(aId)}/decide`, { approve }),
    chat: () => get<{ maxLength: number; messages: ChatMessage[] }>('/api/chat'),
    sendChat: (text: string) => post<unknown>('/api/chat', { text }),
    deleteChat: (mId: string) => del<unknown>(`/api/chat/${id(mId)}`),
    kidTexts: (kidId: string) => get<KidTexts>(`/api/kids/${id(kidId)}/texts`),
    textThread: (kidId: string, thread: string) => get<{ thread: string; names: string[]; texts: PhoneText[] }>(`/api/kids/${id(kidId)}/texts/thread?t=${id(thread)}`),
    deleteHeldText: (tId: string) => post<unknown>(`/api/texts/${id(tId)}/delete`),
    blockNumber: (kidId: string, phone: string) => post<unknown>(`/api/kids/${id(kidId)}/blocked-numbers`, { phone }),
    unblockNumber: (kidId: string, num: string) => del<unknown>(`/api/kids/${id(kidId)}/blocked-numbers/${id(num)}`),
    apks: () => get<{ maxBytes: number; apks: Apk[] }>('/api/apks'),
    uploadApk: (name: string, file: File) => request<{ apk: Apk }>('POST', `/api/apks/upload?name=${id(name)}`, undefined, { data: file, name: file.name }),
    deleteApk: (aId: string) => del<unknown>(`/api/apks/${id(aId)}`),
    pushApk: (aId: string, kidIds: string[]) => post<{ phones: number; pushed: number }>(`/api/apks/${id(aId)}/push`, { kidIds }),

    billing: () => get<Billing>('/api/billing'),
    checkout: (interval: 'month' | 'year') => post<{ url: string }>('/api/billing/checkout', { interval }),
    portal: () => post<{ url: string }>('/api/billing/portal'),
  };
}

export type Api = ReturnType<typeof createApi>;
