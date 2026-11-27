import { describe, expect, it } from 'vitest';
import { createApi } from '../api/client';
import { choreCopy, requestCopy } from './requests';

describe('wording for what waits for a parent', () => {
  it('names each kind of request', () => {
    expect(requestCopy({ kind: 'time', kidName: 'Ava', minutes: 30, detail: null }).text).toBe('Ava asks for 30 more minutes');
    expect(requestCopy({ kind: 'app', kidName: 'Ava', minutes: null, detail: 'Duolingo' }).tag).toBe('New app');
    expect(requestCopy({ kind: 'site', kidName: 'Ava', minutes: null, detail: 'pbskids.org' }).tag).toBe('New site');
    const friend = requestCopy({ kind: 'contact', kidName: 'Ava', minutes: null, detail: 'Mia' });
    expect(friend).toEqual({ text: 'Ava wants to text a friend: Mia', tag: 'New contact', tagClass: 'pill-deep', yes: 'Allow' });
  });

  it('says what a chore earns', () => {
    expect(choreCopy({ kidName: 'Max', choreName: 'Take out the trash', minutes: 10 })).toEqual({
      text: 'Max says this chore is done: Take out the trash', reward: 'Yes adds 10 minutes today',
    });
    expect(choreCopy({ kidName: 'Max', choreName: 'Tidy up', minutes: 1 }).reward).toBe('Yes adds 1 minute today');
    expect(choreCopy({ kidName: 'Max', choreName: 'Tidy up', minutes: 0 }).reward).toBe('No extra time');
  });
});

describe('phone calls of the API client', () => {
  function recorder() {
    const calls: { url: string; init?: RequestInit }[] = [];
    const api = createApi(async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ apk: {}, approvals: [], messages: [] }), { status: 200 });
    });
    return { api, calls };
  }

  it('uploads an APK as the body, with the headers the server asks for', async () => {
    const { api, calls } = recorder();
    const file = new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'chess kids.apk');
    await api.uploadApk('Chess Kids', file);
    expect(calls[0]?.url).toBe('/api/apks/upload?name=Chess%20Kids');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(file);
    expect(calls[0]?.init?.headers).toMatchObject({ 'X-FSW-Upload': '1', 'X-Filename': 'chess%20kids.apk', 'Content-Type': 'application/vnd.android.package-archive' });
  });

  it('sends the Wi-Fi only when there is one, and encodes ids in paths', async () => {
    const { api, calls } = recorder();
    await api.setupQr('kid-1', null);
    await api.setupQr('kid-1', { ssid: 'Home', security: 'WPA', password: 'pw' });
    await api.decideChore('a/b', true);
    await api.textThread('kid 1', '5550100101,5550100103');
    await api.sendChat('hello');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ kidId: 'kid-1' });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ kidId: 'kid-1', wifi: { ssid: 'Home', security: 'WPA', password: 'pw' } });
    expect(calls[2]?.url).toBe('/api/chore-approvals/a%2Fb/decide');
    expect(calls[3]?.url).toBe('/api/kids/kid%201/texts/thread?t=5550100101%2C5550100103');
    expect([calls[4]?.url, calls[4]?.init?.method, String(calls[4]?.init?.body)]).toEqual(['/api/chat', 'POST', '{"text":"hello"}']);
  });
});
