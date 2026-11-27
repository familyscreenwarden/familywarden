/** An error with an HTTP status and a plain sentence a parent can read. */
export class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function notFound(what: string): HttpError {
  return new HttpError(404, `That ${what} was not found.`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Small typed reader for JSON bodies. Every getter throws a 400 with a readable sentence. */
export class Body {
  private readonly data: Record<string, unknown>;

  constructor(raw: unknown) {
    if (raw === undefined || raw === null) {
      this.data = {};
    } else if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(400, 'The request must be a JSON object.');
    } else {
      this.data = raw as Record<string, unknown>;
    }
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data, key) && this.data[key] !== undefined;
  }

  raw(key: string): unknown {
    return this.has(key) ? this.data[key] : undefined;
  }

  /** A trimmed string of 1..max characters (min can be lowered to 0). */
  string(key: string, label: string, opts: { max: number; min?: number }): string {
    const v = this.raw(key);
    if (typeof v !== 'string') throw new HttpError(400, `${label} is needed.`);
    // eslint-disable-next-line no-control-regex
    const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    const min = opts.min ?? 1;
    if (s.length < min) throw new HttpError(400, `${label} is needed.`);
    if (s.length > opts.max) throw new HttpError(400, `${label} is too long (at most ${opts.max} characters).`);
    return s;
  }

  optString(key: string, label: string, opts: { max: number; min?: number }): string | undefined {
    return this.has(key) ? this.string(key, label, opts) : undefined;
  }

  /** A string, or null when the field is missing, null or empty. */
  nullableString(key: string, label: string, max: number): string | null {
    const v = this.raw(key);
    if (v === undefined || v === null || v === '') return null;
    return this.string(key, label, { max, min: 0 }) || null;
  }

  int(key: string, label: string, min: number, max: number): number {
    const v = this.raw(key);
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}.`);
    }
    return v;
  }

  optInt(key: string, label: string, min: number, max: number): number | undefined {
    return this.has(key) ? this.int(key, label, min, max) : undefined;
  }

  bool(key: string, label: string): boolean {
    const v = this.raw(key);
    if (typeof v !== 'boolean') throw new HttpError(400, `${label} must be true or false.`);
    return v;
  }

  optBool(key: string, label: string): boolean | undefined {
    return this.has(key) ? this.bool(key, label) : undefined;
  }

  oneOf<T extends string>(key: string, label: string, values: readonly T[]): T {
    const v = this.raw(key);
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
      throw new HttpError(400, `${label} must be one of: ${values.join(', ')}.`);
    }
    return v as T;
  }

  optOneOf<T extends string>(key: string, label: string, values: readonly T[]): T | undefined {
    return this.has(key) ? this.oneOf(key, label, values) : undefined;
  }

  /** An array of at most `max` items (missing = empty). */
  array(key: string, label: string, max: number): unknown[] {
    const v = this.raw(key);
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new HttpError(400, `${label} must be a list.`);
    if (v.length > max) throw new HttpError(400, `${label} has too many entries (at most ${max}).`);
    return v;
  }
}

/** Fixed-window in-memory rate limiter. Good for one server process; restart clears it. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** True while the caller still has hits left (nothing is counted). */
  peek(key: string, now: number = Date.now()): boolean {
    const entry = this.hits.get(key);
    return !entry || entry.resetAt <= now || entry.count < this.limit;
  }

  /** Counts one hit. Returns false when the caller is over the limit. */
  take(key: string, now: number = Date.now()): boolean {
    if (this.hits.size > 20000) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}
