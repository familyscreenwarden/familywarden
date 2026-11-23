import crypto from 'node:crypto';
import type { Config } from './config';
import { hmacSha256 } from './crypto';

export interface SigV4Input {
  method: string;
  url: string;
  /** Extra headers to sign and send (host and x-amz-date are added). */
  headers?: Record<string, string>;
  body?: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: Date;
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * AWS Signature Version 4, written out by hand (no SDK).
 * Returns the headers to send, including Authorization.
 */
export function signSigV4(input: SigV4Input): Record<string, string> {
  const url = new URL(input.url);
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); // 20150830T123600Z
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  headers['host'] = url.host;
  headers['x-amz-date'] = amzDate;

  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((n) => `${n}:${headers[n] ?? ''}\n`).join('');
  const signedHeaders = signedNames.join(';');

  const canonicalUri =
    url.pathname
      .split('/')
      .map((seg) => rfc3986(decodeURIComponent(seg)))
      .join('/') || '/';
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.body ?? ''),
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmacSha256(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, input.region);
  const kService = hmacSha256(kRegion, input.service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export interface Mailer {
  /** Sends the sign-in link. Must not throw for delivery problems the parent cannot fix; it logs them. */
  sendSignInLink(email: string, link: string): Promise<void>;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function signInEmail(link: string): { subject: string; text: string; html: string } {
  const subject = 'Your Family Screen Warden sign-in link';
  const text = [
    'Open this link to sign in to Family Screen Warden:',
    '',
    link,
    '',
    'The link works once and stops working after 15 minutes.',
    'If you did not ask for it, you can ignore this email.',
  ].join('\n');
  const safe = escapeHtml(link);
  const html =
    `<div style="font-family:Inter,Arial,sans-serif;font-size:15px;color:#111;line-height:1.5">` +
    `<p>Open this link to sign in to Family Screen Warden:</p>` +
    `<p><a href="${safe}" style="display:inline-block;background:#34d399;color:#06281c;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600">Sign in</a></p>` +
    `<p>Or copy this address into your browser:<br>${safe}</p>` +
    `<p>The link works once and stops working after 15 minutes. If you did not ask for it, you can ignore this email.</p>` +
    `</div>`;
  return { subject, text, html };
}

/** Amazon SES v2 SendEmail over plain fetch, or the console when SES is not configured. */
export function createMailer(config: Config, fetchImpl: typeof fetch = fetch): Mailer {
  const ses = config.ses;
  if (!ses) {
    return {
      async sendSignInLink(email, link) {
        console.log(`[mail] SES is not configured. Sign-in link for ${email}: ${link}`);
      },
    };
  }
  return {
    async sendSignInLink(email, link) {
      const mail = signInEmail(link);
      const body = JSON.stringify({
        FromEmailAddress: ses.from,
        Destination: { ToAddresses: [email] },
        Content: {
          Simple: {
            Subject: { Data: mail.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: mail.text, Charset: 'UTF-8' }, Html: { Data: mail.html, Charset: 'UTF-8' } },
          },
        },
      });
      const url = `https://email.${ses.region}.amazonaws.com/v2/email/outbound-emails`;
      const headers = signSigV4({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        body,
        region: ses.region,
        service: 'ses',
        accessKeyId: ses.accessKeyId,
        secretAccessKey: ses.secretAccessKey,
      });
      delete headers['host']; // fetch sets it
      try {
        const res = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 300);
          console.error(`[mail] SES refused the sign-in email (${res.status}): ${detail}`);
        }
      } catch (err) {
        console.error('[mail] Could not reach SES:', err instanceof Error ? err.message : err);
      }
    },
  };
}
