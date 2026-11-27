/**
 * Ordered schema migrations. Never edit a migration that has shipped: add a new one.
 * Each runs once, inside a transaction, and is recorded in the `migrations` table.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: '001_initial',
    sql: `
      CREATE TABLE accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL UNIQUE CHECK (email = lower(email)),
        timezone text NOT NULL DEFAULT 'America/Denver',
        plan text NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial','active','locked')),
        trial_ends_at timestamptz NOT NULL,
        stripe_customer_id text,
        stripe_subscription_id text,
        parent_pin_hash text,
        pin_failed_count integer NOT NULL DEFAULT 0,
        pin_locked_until timestamptz,
        paused_all boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX accounts_stripe_customer_idx ON accounts (stripe_customer_id);

      CREATE TABLE login_tokens (
        token_hash text PRIMARY KEY,
        email text NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX login_tokens_email_idx ON login_tokens (email, created_at);

      CREATE TABLE sessions (
        token_hash text PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX sessions_account_idx ON sessions (account_id);

      CREATE TABLE kids (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name text NOT NULL,
        color text NOT NULL DEFAULT '#34d399',
        limit_school_minutes integer NOT NULL DEFAULT 120 CHECK (limit_school_minutes BETWEEN 0 AND 1440),
        limit_weekend_minutes integer NOT NULL DEFAULT 180 CHECK (limit_weekend_minutes BETWEEN 0 AND 1440),
        bed_school_start text NOT NULL DEFAULT '20:30',
        bed_school_end text NOT NULL DEFAULT '06:00',
        bed_other_start text NOT NULL DEFAULT '21:30',
        bed_other_end text NOT NULL DEFAULT '07:00',
        bedtime_enabled boolean NOT NULL DEFAULT true,
        only_allowed_sites boolean NOT NULL DEFAULT true,
        safe_search boolean NOT NULL DEFAULT true,
        youtube_restricted boolean NOT NULL DEFAULT true,
        block_private boolean NOT NULL DEFAULT true,
        locked boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX kids_account_idx ON kids (account_id);

      CREATE TABLE devices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        name text NOT NULL,
        platform text NOT NULL CHECK (platform IN ('windows','android')),
        model text,
        os_version text,
        app_version text,
        token_hash text NOT NULL UNIQUE,
        last_seen_at timestamptz,
        front_app text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX devices_account_idx ON devices (account_id);
      CREATE INDEX devices_kid_idx ON devices (kid_id);

      CREATE TABLE pairing_codes (
        code text PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        platform text NOT NULL CHECK (platform IN ('windows','android')),
        expires_at timestamptz NOT NULL,
        used_at timestamptz
      );

      CREATE TABLE apps (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN ('app','site')),
        platform text NOT NULL DEFAULT 'any' CHECK (platform IN ('windows','android','any')),
        identifier text NOT NULL,
        name text NOT NULL,
        allowed boolean NOT NULL DEFAULT true,
        free boolean NOT NULL DEFAULT false,
        limit_minutes integer CHECK (limit_minutes IS NULL OR limit_minutes BETWEEN 0 AND 1440),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (kid_id, kind, identifier)
      );
      CREATE INDEX apps_account_idx ON apps (account_id);

      CREATE TABLE usage (
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
        app_id uuid REFERENCES apps(id) ON DELETE SET NULL,
        day date NOT NULL,
        minutes integer NOT NULL CHECK (minutes >= 0),
        UNIQUE (device_id, app_id, day)
      );
      CREATE INDEX usage_kid_day_idx ON usage (kid_id, day);

      CREATE TABLE time_grants (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        day date NOT NULL,
        minutes integer NOT NULL CHECK (minutes > 0),
        reason text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX time_grants_kid_day_idx ON time_grants (kid_id, day);

      CREATE TABLE requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
        kind text NOT NULL CHECK (kind IN ('time','app','site')),
        minutes integer,
        detail text NOT NULL DEFAULT '',
        identifier text,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
        created_at timestamptz NOT NULL DEFAULT now(),
        decided_at timestamptz
      );
      CREATE INDEX requests_account_idx ON requests (account_id, status, created_at DESC);

      CREATE TABLE contacts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        name text NOT NULL,
        phone text NOT NULL,
        can_call boolean NOT NULL DEFAULT true,
        can_text boolean NOT NULL DEFAULT true
      );
      CREATE INDEX contacts_account_idx ON contacts (account_id);

      CREATE TABLE blocked_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
        host text NOT NULL,
        at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX blocked_events_account_idx ON blocked_events (account_id, at DESC);
    `,
  },
];
