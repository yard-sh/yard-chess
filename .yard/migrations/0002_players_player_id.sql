-- players now holds guests too: a Yard user id, or guest:<guest id>.
ALTER TABLE players RENAME COLUMN user_id TO player_id;
