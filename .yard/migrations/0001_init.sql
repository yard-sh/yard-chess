CREATE TABLE IF NOT EXISTS players (
  user_id      TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id         TEXT PRIMARY KEY,
  white_id   TEXT,
  black_id   TEXT,
  white_name TEXT,
  black_name TEXT,
  result     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  moves      INTEGER NOT NULL DEFAULT 0,
  pgn        TEXT,
  created_at INTEGER NOT NULL,
  ended_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_games_white ON games (white_id, ended_at);

CREATE INDEX IF NOT EXISTS idx_games_black ON games (black_id, ended_at);
