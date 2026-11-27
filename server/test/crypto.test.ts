import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config';
import {
  hashPin,
  hashSessionToken,
  isPairingCode,
  normalizePairingCode,
  randomPairingCode,
  randomToken,
  sha256Hex,
  verifyPin,
} from '../src/crypto';
import { RateLimiter } from '../src/http';
import { createMailer, signSigV4 } from '../src/mail';
import { normalizeIdentifier } from '../src/routes/parent';
import { signStripePayload, verifyStripeSignature } from '../src/stripe';

describe('tokens and hashes', () => {
  it('random tokens are long, URL-safe and different each time', () => {
    const a = randomToken();
    const b = randomToken();
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b);
  });

  it('sha256Hex matches the known digest', () => {
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('session hashes depend on the server secret', () => {
    assert.equal(hashSessionToken('t', ''), sha256Hex('t'));
    assert.notEqual(hashSessionToken('t', 'secret-one'), hashSessionToken('t', 'secret-two'));
    assert.notEqual(hashSessionToken('t', 'secret-one'), sha256Hex('t'));
  });

  it('pairing codes use 8 characters without 0, O, 1, I', () => {
    for (let i = 0; i < 200; i++) {
      const code = randomPairingCode();
      assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
      assert.equal(isPairingCode(code), true);
    }
    assert.equal(isPairingCode('ABCD0EFG'), false);
    assert.equal(isPairingCode('ABCDOEFG'), false);
    assert.equal(isPairingCode('ABCD1EFG'), false);
    assert.equal(isPairingCode('ABCDIEFG'), false);
    assert.equal(isPairingCode('ABCDEFG'), false);
    assert.equal(normalizePairingCode(' abcd-efgh '), 'ABCDEFGH');
  });

  it('PINs are hashed with scrypt and a fresh salt', async () => {
    const one = await hashPin('1234');
    const two = await hashPin('1234');
    assert.match(one, /^scrypt\$16384\$8\$1\$/);
    assert.notEqual(one, two);
    assert.equal(one.includes('1234'), false);
    assert.equal(await verifyPin('1234', one), true);
    assert.equal(await verifyPin('1235', one), false);
    assert.equal(await verifyPin('1234', 'garbage'), false);
    assert.equal(await verifyPin('1234', 'scrypt$16384$8$1$$'), false);
  });
});

describe('Stripe webhook signature', () => {
  const secret = 'whsec_test_secret';
  const payload = '{"id":"evt_1","type":"customer.subscription.updated"}';
  const now = 1_800_000_000;

  it('accepts a correct signature', () => {
    assert.equal(verifyStripeSignature(Buffer.from(payload), signStripePayload(payload, secret, now), secret, now), true);
  });

  it('matches a signature worked out independently', () => {
    // echo -n "1800000000.{...}" | openssl dgst -sha256 -hmac whsec_test_secret
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const sig = crypto.createHmac('sha256', secret).update(`${now}.${payload}`).digest('hex');
    assert.equal(verifyStripeSignature(Buffer.from(payload), `t=${now},v1=${sig}`, secret, now), true);
  });

  it('accepts when one of several v1 signatures is right (secret rotation)', () => {
    const good = signStripePayload(payload, secret, now).split('v1=')[1];
    const header = `t=${now},v1=${'0'.repeat(64)},v1=${good},v0=ignored`;
    assert.equal(verifyStripeSignature(Buffer.from(payload), header, secret, now), true);
  });

  it('rejects a changed body', () => {
    const header = signStripePayload(payload, secret, now);
    assert.equal(verifyStripeSignature(Buffer.from(payload + ' '), header, secret, now), false);
  });

  it('rejects a wrong secret', () => {
    assert.equal(verifyStripeSignature(Buffer.from(payload), signStripePayload(payload, 'other', now), secret, now), false);
  });

  it('rejects a timestamp outside the tolerance, both old and in the future', () => {
    const header = signStripePayload(payload, secret, now);
    assert.equal(verifyStripeSignature(Buffer.from(payload), header, secret, now + 300), true);
    assert.equal(verifyStripeSignature(Buffer.from(payload), header, secret, now + 301), false);
    assert.equal(verifyStripeSignature(Buffer.from(payload), header, secret, now - 301), false);
  });

  it('rejects a changed timestamp', () => {
    const header = signStripePayload(payload, secret, now).replace(`t=${now}`, `t=${now + 1}`);
    assert.equal(verifyStripeSignature(Buffer.from(payload), header, secret, now), false);
  });

  it('rejects missing or broken headers', () => {
    const body = Buffer.from(payload);
    assert.equal(verifyStripeSignature(body, undefined, secret, now), false);
    assert.equal(verifyStripeSignature(body, '', secret, now), false);
    assert.equal(verifyStripeSignature(body, 'v1=abc', secret, now), false);
    assert.equal(verifyStripeSignature(body, `t=${now}`, secret, now), false);
    assert.equal(verifyStripeSignature(body, `t=${now},v1=zz`, secret, now), false);
    assert.equal(verifyStripeSignature(body, `t=abc,v1=${'a'.repeat(64)}`, secret, now), false);
    assert.equal(verifyStripeSignature(body, signStripePayload(payload, secret, now), '', now), false);
  });
});

describe('AWS Signature Version 4', () => {
  it('matches the AWS test suite vector "get-vanilla"', () => {
    const headers = signSigV4({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      region: 'us-east-1',
      service: 'service',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      now: new Date('2015-08-30T12:36:00Z'),
    });
    assert.equal(headers['x-amz-date'], '20150830T123600Z');
    assert.equal(
      headers['authorization'],
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('matches the AWS test suite vector "get-vanilla-query-order-key-case"', () => {
    const headers = signSigV4({
      method: 'GET',
      url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1',
      region: 'us-east-1',
      service: 'service',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      now: new Date('2015-08-30T12:36:00Z'),
    });
    assert.match(headers['authorization'] ?? '', /Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/);
  });

  it('signs the content type and body for a POST', () => {
    const base = {
      method: 'POST',
      url: 'https://email.us-west-2.amazonaws.com/v2/email/outbound-emails',
      headers: { 'Content-Type': 'application/json' },
      region: 'us-west-2',
      service: 'ses',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
      now: new Date('2026-01-02T03:04:05Z'),
    };
    const a = signSigV4({ ...base, body: '{"a":1}' });
    const b = signSigV4({ ...base, body: '{"a":2}' });
    assert.match(a['authorization'] ?? '', /Credential=AKIDEXAMPLE\/20260102\/us-west-2\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.notEqual(a['authorization'], b['authorization']);
    assert.equal(a['host'], 'email.us-west-2.amazonaws.com');
  });
});

describe('mailer', () => {
  const baseEnv = { DATABASE_URL: 'postgres://x/y' };

  it('logs the link when SES is not configured', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(' '));
    try {
      await createMailer(loadConfig(baseEnv)).sendSignInLink('a@example.com', 'http://localhost/x?token=abc');
    } finally {
      console.log = original;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /a@example\.com.*token=abc/);
  });

  it('sends a signed SES v2 SendEmail request when SES is configured', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('{"MessageId":"1"}', { status: 200 });
    }) as typeof fetch;
    const config = loadConfig({
      ...baseEnv,
      AWS_SES_REGION: 'us-west-2',
      AWS_SES_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      AWS_SES_SECRET_ACCESS_KEY: 'secret',
      MAIL_FROM_EMAIL: 'Family Screen Warden <hello@familyscreenwarden.com>',
    });
    await createMailer(config, fakeFetch).sendSignInLink('parent@example.com', 'https://app.familyscreenwarden.com/api/auth/verify?token=abc');
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, 'https://email.us-west-2.amazonaws.com/v2/email/outbound-emails');
    assert.equal(call.init.method, 'POST');
    const headers = call.init.headers as Record<string, string>;
    assert.match(headers['authorization'] ?? '', /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    const body = JSON.parse(String(call.init.body)) as {
      FromEmailAddress: string;
      Destination: { ToAddresses: string[] };
      Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string }; Html: { Data: string } } } };
    };
    assert.equal(body.FromEmailAddress, 'Family Screen Warden <hello@familyscreenwarden.com>');
    assert.deepEqual(body.Destination.ToAddresses, ['parent@example.com']);
    assert.match(body.Content.Simple.Body.Text.Data, /verify\?token=abc/);
    assert.match(body.Content.Simple.Body.Html.Data, /verify\?token=abc/);
  });

  it('does not throw when SES refuses or cannot be reached', async () => {
    const config = loadConfig({
      ...baseEnv,
      AWS_SES_REGION: 'us-west-2',
      AWS_SES_ACCESS_KEY_ID: 'k',
      AWS_SES_SECRET_ACCESS_KEY: 's',
      MAIL_FROM_EMAIL: 'a@b.co',
    });
    const original = console.error;
    console.error = () => undefined;
    try {
      await createMailer(config, (async () => new Response('denied', { status: 403 })) as typeof fetch).sendSignInLink('p@example.com', 'x');
      await createMailer(config, (async () => {
        throw new Error('offline');
      }) as typeof fetch).sendSignInLink('p@example.com', 'x');
    } finally {
      console.error = original;
    }
  });
});

describe('config', () => {
  it('needs DATABASE_URL', () => {
    assert.throws(() => loadConfig({}), /DATABASE_URL/);
  });

  it('needs a session secret in production', () => {
    assert.throws(() => loadConfig({ DATABASE_URL: 'x', NODE_ENV: 'production' }), /SESSION_SECRET/);
    assert.equal(loadConfig({ DATABASE_URL: 'x', NODE_ENV: 'production', SESSION_SECRET: 'a'.repeat(32) }).production, true);
  });

  it('has sensible defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'x' });
    assert.equal(c.port, 3000);
    assert.equal(c.publicUrl, 'http://localhost:3000');
    assert.equal(c.devLinks, false);
    assert.equal(c.ses, null);
    assert.equal(c.stripeSecretKey, '');
  });

  it('SES needs all four settings', () => {
    assert.equal(loadConfig({ DATABASE_URL: 'x', AWS_SES_REGION: 'us-east-1', AWS_SES_ACCESS_KEY_ID: 'k' }).ses, null);
  });
});

describe('small helpers', () => {
  it('rate limiter lets `limit` hits through per window', () => {
    const limiter = new RateLimiter(3, 1000);
    assert.deepEqual([1, 2, 3, 4].map(() => limiter.take('a', 0)), [true, true, true, false]);
    assert.equal(limiter.take('b', 0), true);
    assert.equal(limiter.take('a', 999), false);
    assert.equal(limiter.take('a', 1000), true);
  });

  it('normalises app and site identifiers', () => {
    assert.equal(normalizeIdentifier('site', 'any', 'https://www.Example.com/path?q=1'), 'example.com');
    assert.equal(normalizeIdentifier('site', 'any', ' KhanAcademy.org. '), 'khanacademy.org');
    assert.equal(normalizeIdentifier('app', 'windows', 'Minecraft.EXE'), 'minecraft.exe');
    assert.equal(normalizeIdentifier('app', 'android', 'com.Example.App'), 'com.Example.App');
    assert.equal(normalizeIdentifier('site', 'any', 'https://'), '');
  });
});
