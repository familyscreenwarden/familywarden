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
  {
    // Android phones through the kid-device API (/api/warden + /api/android), chores, family chat, texts, APKs, releases.
    id: '002_android_compat',
    sql: `
      ALTER TABLE kids
        ADD COLUMN launcher_layout text NOT NULL DEFAULT 'bright' CHECK (launcher_layout IN ('bright','gamer','glass')),
        ADD COLUMN launcher_theme text NOT NULL DEFAULT 'galaxy' CHECK (launcher_theme IN ('galaxy','ocean','jungle','sunset')),
        ADD COLUMN launcher_look_locked boolean NOT NULL DEFAULT false,
        ADD COLUMN phone_block_settings boolean NOT NULL DEFAULT true,
        ADD COLUMN phone_block_reset boolean NOT NULL DEFAULT true,
        ADD COLUMN phone_block_safe_boot boolean NOT NULL DEFAULT true,
        ADD COLUMN phone_block_installs boolean NOT NULL DEFAULT true,
        ADD COLUMN phone_block_accounts boolean NOT NULL DEFAULT true,
        ADD COLUMN phone_block_usb boolean NOT NULL DEFAULT true,
        ADD COLUMN phone_emergency_number text NOT NULL DEFAULT '911' CHECK (phone_emergency_number ~ '^[0-9]{2,6}$'),
        ADD COLUMN phone_play_minutes integer NOT NULL DEFAULT 10 CHECK (phone_play_minutes BETWEEN 2 AND 60);

      ALTER TABLE devices
        ADD COLUMN machine_id text,
        ADD COLUMN unlock_secret text,
        ADD COLUMN unlock_counter integer NOT NULL DEFAULT 0,
        ADD COLUMN paired_at timestamptz,
        ADD COLUMN info jsonb;
      CREATE INDEX devices_machine_idx ON devices (account_id, machine_id);

      ALTER TABLE pairing_codes
        ADD COLUMN machine_id text,
        ADD COLUMN device_id uuid REFERENCES devices(id) ON DELETE SET NULL;

      ALTER TABLE apps
        ADD COLUMN category text NOT NULL DEFAULT 'other' CHECK (category IN ('game','school','browser','video','other'));

      ALTER TABLE contacts ADD COLUMN always boolean NOT NULL DEFAULT true;

      ALTER TABLE requests DROP CONSTRAINT requests_kind_check;
      ALTER TABLE requests ADD CONSTRAINT requests_kind_check CHECK (kind IN ('time','app','site','contact'));

      -- What a compatibility device reports: seconds per day. app_key '' is the day's counted time,
      -- any other key is an apps.id (as text) or 'site' (website tiles).
      CREATE TABLE usage_seconds (
        device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        day date NOT NULL,
        app_key text NOT NULL,
        seconds integer NOT NULL CHECK (seconds >= 0),
        PRIMARY KEY (device_id, day, app_key)
      );
      CREATE INDEX usage_seconds_kid_day_idx ON usage_seconds (kid_id, day);

      CREATE TABLE chores (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        name text NOT NULL,
        minutes integer NOT NULL DEFAULT 15 CHECK (minutes BETWEEN 0 AND 240),
        repeat text NOT NULL DEFAULT 'once' CHECK (repeat IN ('once','daily','weekly')),
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX chores_kid_idx ON chores (account_id, kid_id);

      CREATE TABLE chore_completions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        chore_id uuid NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
        day date NOT NULL,
        minutes integer NOT NULL CHECK (minutes BETWEEN 0 AND 240),
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
        created_at timestamptz NOT NULL DEFAULT now(),
        decided_at timestamptz,
        decided_day date
      );
      CREATE INDEX chore_completions_account_idx ON chore_completions (account_id, status, created_at DESC);
      CREATE INDEX chore_completions_chore_idx ON chore_completions (chore_id, day);

      -- Family chat: kids write from the launcher, parents from the console. kid_id NULL = a parent wrote it.
      CREATE TABLE family_chat (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kid_id uuid REFERENCES kids(id) ON DELETE CASCADE,
        text text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX family_chat_account_idx ON family_chat (account_id, created_at DESC);

      CREATE TABLE texts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
        phone_id text NOT NULL,
        thread text NOT NULL,
        participants text[] NOT NULL,
        dir text NOT NULL CHECK (dir IN ('in','out')),
        from_num text,
        body text NOT NULL DEFAULT '',
        media jsonb NOT NULL DEFAULT '[]'::jsonb,
        status text NOT NULL DEFAULT 'shown' CHECK (status IN ('shown','held','waiting','deleted')),
        at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (device_id, phone_id)
      );
      CREATE INDEX texts_kid_idx ON texts (account_id, kid_id, thread, at DESC);

      CREATE TABLE text_media (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
        phone_msg_id text NOT NULL,
        phone_media_id text NOT NULL,
        type text NOT NULL,
        size integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (device_id, phone_media_id)
      );

      CREATE TABLE blocked_numbers (
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        num text NOT NULL,
        phone text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (kid_id, num)
      );

      CREATE TABLE apks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name text NOT NULL,
        file_name text,
        package text,
        size integer NOT NULL,
        sha256 text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX apks_account_idx ON apks (account_id, created_at DESC);

      CREATE TABLE apk_installs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        apk_id uuid NOT NULL REFERENCES apks(id) ON DELETE CASCADE,
        device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        name text NOT NULL,
        status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','installing','done','failed')),
        message text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX apk_installs_device_idx ON apk_installs (device_id, status);

      -- Published versions of the kids' Android app (one list for the whole server, not per family).
      CREATE TABLE app_releases (
        version text PRIMARY KEY,
        size integer NOT NULL,
        sha256 text NOT NULL,
        signature_checksum text,
        notes text NOT NULL DEFAULT '',
        has_file boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE unlock_codes (
        device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        counter integer NOT NULL,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        cancelled_at timestamptz,
        PRIMARY KEY (device_id, counter)
      );

      CREATE TABLE time_codes (
        code text PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        minutes integer NOT NULL CHECK (minutes BETWEEN 1 AND 240),
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        used_by_device uuid REFERENCES devices(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX time_codes_kid_idx ON time_codes (account_id, kid_id, created_at DESC);
    `,
  },
  {
    id: '003_kid_media',
    sql: `
      -- Photos, videos and movies a kid made with the phone's Camera and Movie Maker, copied here for the parents
      -- (kept 90 days). The file is DATA_DIR/kid-media/<account>/<kid>/<id>. A share link's token is never stored:
      -- only its hash, and a nonce to work the same token out again.
      CREATE TABLE kid_media (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
        phone_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('photo','video','movie')),
        title text NOT NULL DEFAULT '',
        type text NOT NULL CHECK (type IN ('image/jpeg','image/png','video/webm','video/mp4')),
        size bigint NOT NULL CHECK (size > 0),
        duration_sec integer NOT NULL DEFAULT 0 CHECK (duration_sec >= 0),
        at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        deleted_on_phone_at timestamptz,
        share_token_hash text UNIQUE,
        share_nonce text,
        share_expires_at timestamptz,
        UNIQUE (device_id, phone_id)
      );
      CREATE INDEX kid_media_kid_idx ON kid_media (account_id, kid_id, at DESC);
      CREATE INDEX kid_media_created_idx ON kid_media (created_at);

      -- "Ask to add a friend": what the kid wrote about the friend, and the number as the kid typed it.
      ALTER TABLE requests ADD COLUMN note text, ADD COLUMN phone text;
    `,
  },
  {
    // Kids' levels (Little kid, Big kid, Teen) and one set of safe-browsing rules for every device (levels.ts).
    // "Only allowed websites" on becomes web_mode 'sites' (nothing changes for those kids). Off becomes 'open',
    // and the websites the parent had switched off for that kid become that kid's blocked list.
    id: '004_levels_web',
    sql: `
      ALTER TABLE kids
        ADD COLUMN level text CHECK (level IN ('little','big','teen')),
        ADD COLUMN birthday date,
        ADD COLUMN web_mode text NOT NULL DEFAULT 'sites' CHECK (web_mode IN ('sites','filtered','open')),
        ADD COLUMN web_categories text[] NOT NULL DEFAULT '{}',
        ADD COLUMN web_blocked text[] NOT NULL DEFAULT '{}',
        ADD COLUMN texting_who text NOT NULL DEFAULT 'friends' CHECK (texting_who IN ('family','friends','anyone'));

      UPDATE kids SET web_mode = 'open' WHERE NOT only_allowed_sites;
      UPDATE kids k
         SET web_blocked = COALESCE(
               (SELECT array_agg(x.identifier ORDER BY x.identifier)
                  FROM (SELECT a.identifier FROM apps a
                         WHERE a.kid_id = k.id AND a.kind = 'site' AND NOT a.allowed
                         ORDER BY a.identifier LIMIT 500) x),
               '{}')
       WHERE NOT k.only_allowed_sites;

      CREATE INDEX blocked_events_kid_idx ON blocked_events (kid_id, at DESC);
    `,
  },
  {
    // The live map: where the kids' phones are, family places with arrive / leave, check-ins, "Ring phone"
    // (routes/location.ts). Every row carries the family it belongs to. Points go with the kid, the phone or the
    // family they came from, and housekeeping removes them after the kid's keep_days.
    id: '005_kid_location',
    sql: `
      CREATE TABLE kid_location_settings (
        kid_id uuid PRIMARY KEY REFERENCES kids(id) ON DELETE CASCADE,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        sharing boolean NOT NULL DEFAULT true,
        alerts boolean NOT NULL DEFAULT true,
        keep_days integer NOT NULL DEFAULT 30 CHECK (keep_days IN (1, 30, 90)),
        live_until timestamptz,
        ring_id uuid,
        ring_at timestamptz
      );

      CREATE TABLE family_places (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name text NOT NULL,
        lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
        lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
        radius_m integer NOT NULL DEFAULT 150 CHECK (radius_m BETWEEN 50 AND 2000),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX family_places_account_idx ON family_places (account_id);

      CREATE TABLE kid_locations (
        id bigserial PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        device_id uuid REFERENCES devices(id) ON DELETE CASCADE,
        lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
        lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
        accuracy real,
        battery integer,
        charging boolean,
        at timestamptz NOT NULL,
        place_id uuid REFERENCES family_places(id) ON DELETE SET NULL
      );
      CREATE INDEX kid_locations_kid_idx ON kid_locations (kid_id, at DESC);
      CREATE INDEX kid_locations_at_idx ON kid_locations (at);

      CREATE TABLE kid_place_state (
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        place_id uuid NOT NULL REFERENCES family_places(id) ON DELETE CASCADE,
        inside boolean NOT NULL,
        since timestamptz NOT NULL,
        PRIMARY KEY (kid_id, place_id)
      );

      CREATE TABLE kid_place_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        place_id uuid REFERENCES family_places(id) ON DELETE SET NULL,
        place_name text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('arrive','leave')),
        at timestamptz NOT NULL
      );
      CREATE INDEX kid_place_events_kid_idx ON kid_place_events (kid_id, at DESC);

      CREATE TABLE kid_checkins (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kid_id uuid NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
        device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
        kind text NOT NULL CHECK (kind IN ('ok','pickup','help')),
        lat double precision,
        lng double precision,
        accuracy real,
        at timestamptz NOT NULL DEFAULT now(),
        answer text,
        answered_at timestamptz
      );
      CREATE INDEX kid_checkins_account_idx ON kid_checkins (account_id, at DESC);
    `,
  },
];
