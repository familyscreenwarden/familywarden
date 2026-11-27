import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, errorMessage } from './client';
import type { FetchLike } from './client';

function respond(status: number, body?: unknown): FetchLike {
  return vi.fn(async () => new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status }));
}

async function caught(p: Promise<unknown>): Promise<ApiError> {
  try { await p; } catch (e) { if (e instanceof ApiError) return e; throw e; }
  throw new Error('expected the call to fail');
}

describe('api client', () => {
  it('sends the session cookie and JSON bodies', async () => {
    const fetchFn = respond(200, { ok: true });
    const api = createApi(fetchFn);
    await api.pauseAll(true);
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]!;
    expect(url).toBe('/api/pause-all');
    expect(init?.credentials).toBe('include');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"paused":true}');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('returns parsed data on success and builds query strings', async () => {
    const fetchFn = respond(200, { days: [], blocked: [] });
    const api = createApi(fetchFn);
    expect(await api.reports('kid 1', 30)).toEqual({ days: [], blocked: [] });
    expect(vi.mocked(fetchFn).mock.calls[0]![0]).toBe('/api/reports?kidId=kid%201&days=30');
  });

  it('calls onUnauthorized on 401 and still rejects', async () => {
    const onUnauthorized = vi.fn(), onLocked = vi.fn();
    const api = createApi(respond(401, { error: 'Please sign in.' }), { onUnauthorized, onLocked });
    const err = await caught(api.me());
    expect(err.status).toBe(401);
    expect(err.message).toBe('Please sign in.');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onLocked).not.toHaveBeenCalled();
  });

  it('calls onLocked on 402 with locked:true', async () => {
    const onUnauthorized = vi.fn(), onLocked = vi.fn();
    const api = createApi(respond(402, { error: 'Your trial has ended.', locked: true }), { onUnauthorized, onLocked });
    const err = await caught(api.dashboard());
    expect(err.status).toBe(402);
    expect(err.locked).toBe(true);
    expect(err.message).toBe('Your trial has ended.');
    expect(onLocked).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('does not treat a 402 without locked:true as a locked account', async () => {
    const onLocked = vi.fn();
    const api = createApi(respond(402, { error: 'Payment needed.' }), { onLocked });
    const err = await caught(api.dashboard());
    expect(err.locked).toBe(false);
    expect(onLocked).not.toHaveBeenCalled();
  });

  it("shows the server's sentence for other errors, such as billing not set up", async () => {
    const api = createApi(respond(503, { error: 'Billing is not set up on this server yet.' }));
    const err = await caught(api.checkout('month'));
    expect(err.status).toBe(503);
    expect(errorMessage(err)).toBe('Billing is not set up on this server yet.');
  });

  it('falls back to a readable sentence when the body is not JSON', async () => {
    const err = await caught(createApi(respond(500, '<html>oops</html>')).kids());
    expect(err.status).toBe(500);
    expect(err.message).toBe('Something went wrong. Please try again.');
    const notFound = await caught(createApi(respond(404, '')).kid('x'));
    expect(notFound.message).toMatch(/could not be found/);
  });

  it('turns a network failure into a readable error', async () => {
    const api = createApi(async () => { throw new TypeError('Failed to fetch'); });
    const err = await caught(api.me());
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/Cannot reach/);
  });

  it('accepts an empty success body', async () => {
    expect(await createApi(respond(200)).deleteApp('a')).toBeNull();
  });

  it('never leaks a non-API error message to the parent', () => {
    expect(errorMessage(new Error('x is undefined'))).toBe('Something went wrong. Please try again.');
  });
});
