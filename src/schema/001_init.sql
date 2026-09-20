CREATE TABLE contacts (
  open_id      TEXT PRIMARY KEY,
  name         TEXT,
  role         TEXT NOT NULL CHECK(role IN ('teacher','student','unknown')),
  line         TEXT CHECK(line IN ('thesis','mentor','grad','self')),
  first_seen   INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE TABLE chats (
  chat_id      TEXT PRIMARY KEY,
  chat_type    TEXT NOT NULL,
  peer_open_id TEXT,
  last_msg_at  INTEGER, poll_cursor INTEGER
);
CREATE TABLE messages (
  message_id     TEXT PRIMARY KEY,
  direction      TEXT NOT NULL CHECK(direction IN ('in','out')),
  transport      TEXT NOT NULL CHECK(transport IN ('ws','webhook','poll','api')),
  chat_id        TEXT NOT NULL, chat_type TEXT NOT NULL,
  sender_open_id TEXT, sender_type TEXT,
  msg_type       TEXT NOT NULL,
  text           TEXT,
  content_json   TEXT NOT NULL,
  reply_to       TEXT, root_id TEXT, thread_id TEXT,
  create_time    INTEGER NOT NULL,
  received_at    INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','processing','done','failed','ignored')),
  attempts       INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  raw_json       TEXT
);
CREATE INDEX ix_messages_status ON messages(status) WHERE status IN ('new','failed');
CREATE INDEX ix_messages_chat_time ON messages(chat_id, create_time);
CREATE TABLE attachments (
  id          INTEGER PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES messages(message_id),
  file_key    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK(kind IN ('image','file')),
  file_name   TEXT, mime TEXT, size INTEGER, sha256 TEXT,
  local_path  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','skipped','deferred','failed')),
  error TEXT, downloaded_at INTEGER,
  UNIQUE(message_id, file_key)
);
CREATE TABLE routes (
  relay_message_id  TEXT PRIMARY KEY,
  origin_message_id TEXT NOT NULL,
  origin_chat_id    TEXT NOT NULL,
  origin_open_id    TEXT NOT NULL,
  origin_kind       TEXT NOT NULL CHECK(origin_kind IN ('self','student','teacher','system')),
  line              TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX ix_routes_origin ON routes(origin_message_id);
CREATE TABLE outbox (
  id            INTEGER PRIMARY KEY,
  uuid          TEXT NOT NULL UNIQUE,
  target_type   TEXT NOT NULL CHECK(target_type IN ('open_id','chat_id')),
  target_id     TEXT NOT NULL,
  msg_type      TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  reply_to      TEXT,
  purpose       TEXT NOT NULL,
  route_origin  TEXT,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, last_error TEXT,
  message_id    TEXT,
  created_at    INTEGER NOT NULL, sent_at INTEGER
);
CREATE INDEX ix_outbox_due ON outbox(status, next_at);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
