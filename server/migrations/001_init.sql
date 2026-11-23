CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub  text NOT NULL UNIQUE,
  email       text NOT NULL,
  name        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Only a SHA-256 hash of the session token is stored, so a database leak doesn't leak live sessions.
CREATE TABLE sessions (
  token_hash  bytea PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX ON sessions (user_id);

CREATE TABLE applications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  company      text NOT NULL,
  position     text NOT NULL,
  work_type    text CHECK (work_type IN ('on_site', 'hybrid', 'remote')),
  location     text NOT NULL DEFAULT '',
  link         text NOT NULL DEFAULT '',
  description  text NOT NULL DEFAULT '',
  pay          text NOT NULL DEFAULT '',
  workload     text CHECK (workload IN ('full_time', 'part_time', 'contract', 'internship')),
  status       text NOT NULL DEFAULT 'applied'
               CHECK (status IN ('saved', 'applied', 'interviewing', 'offer', 'hired', 'rejected', 'withdrawn')),
  notes        text NOT NULL DEFAULT '',
  applied_on   date,
  follow_up_on date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX ON applications (user_id);

-- (application_id, user_id) must match an application owned by the same user: the database itself
-- refuses an event that points at someone else's application.
CREATE TABLE events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL,
  user_id         uuid NOT NULL,
  kind            text NOT NULL DEFAULT 'interview'
                  CHECK (kind IN ('phone_screen', 'interview', 'technical', 'follow_up', 'offer', 'other')),
  happened_on     date,
  with_whom       text NOT NULL DEFAULT '',
  outcome         text CHECK (outcome IN ('passed', 'denied', 'abandoned', 'in_progress', 'technical_assignment', 'hired')),
  notes           text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (application_id, user_id) REFERENCES applications (id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON events (application_id);

CREATE TABLE attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL,
  user_id     uuid NOT NULL,
  filename    text NOT NULL,
  mime        text NOT NULL,
  size        integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, user_id) REFERENCES events (id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON attachments (event_id);
