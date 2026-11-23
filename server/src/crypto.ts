import crypto from 'node:crypto';

/** A random URL-safe token with 256 bits of entropy. */
export function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** SHA-256 hex digest. Used for random tokens, which have enough entropy that a fast hash is safe. */
export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Session cookies are hashed with the server secret mixed in, so a database leak alone cannot forge a lookup. */
export function hashSessionToken(token: string, secret: string): string {
  if (!secret) return sha256Hex(token);
  return crypto.createHmac('sha256', secret).update(token, 'utf8').digest('hex');
}

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0, O, 1, I

export function randomPairingCode(): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)];
  return out;
}

export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

export function isPairingCode(code: string): boolean {
  return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code);
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

function scrypt(pin: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pin, salt, keylen, { N: n, r, p }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Hashes a parent PIN with scrypt. Format: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pin, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEYLEN);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0) || n > 1 << 20) return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (expected.length === 0) return false;
  const key = await scrypt(pin, salt, n, r, p, expected.length);
  return crypto.timingSafeEqual(key, expected);
}

export function hmacSha256(key: crypto.BinaryLike, data: string | Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/** Constant-time comparison of two hex strings. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0 || !/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
