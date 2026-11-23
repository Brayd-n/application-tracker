-- Optional Gmail connection. The refresh token is encrypted (AES-256-GCM) with a key that only exists
-- in the server's environment, so a database dump alone can't be used to read anyone's mail.
CREATE TABLE gmail_accounts (
  user_id            uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  refresh_token_enc  bytea NOT NULL,
  connected_at       timestamptz NOT NULL DEFAULT now(),
  last_checked_at    timestamptz,
  last_internal_date bigint NOT NULL DEFAULT 0  -- newest message already looked at (ms since epoch)
);

-- Only messages that matched one of the user's applications are kept, and only their headers.
CREATE TABLE email_matches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  application_id  uuid NOT NULL,
  gmail_id        text NOT NULL,
  from_name       text NOT NULL DEFAULT '',
  from_email      text NOT NULL DEFAULT '',
  subject         text NOT NULL DEFAULT '',
  received_at     timestamptz NOT NULL,
  read            boolean NOT NULL DEFAULT false,
  UNIQUE (user_id, gmail_id),
  FOREIGN KEY (application_id, user_id) REFERENCES applications (id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON email_matches (user_id, received_at DESC);
