// Yard Chess — one self-contained ES module.
//
//   1. Chess engine   — the only source of chess truth in the app. Clients get a
//                       legal-move map pushed to them and know no rules at all.
//   2. Fetch handler  — HTTP routes + the WebSocket upgrade, forwarded by game id.
//   3. Game object    — one live match: holds both sockets, all state in storage.
//
// Nothing here may rely on instance fields surviving between events: an object
// hibernates whenever it is idle and wakes with a fresh constructor.

/* ═══════════════════════════════════════════════════════════════════════════
   1. CHESS ENGINE

   Board is a flat 64-array, index 0 = a8 … 63 = h1. Pieces are single letters,
   uppercase white / lowercase black, empty squares are null. Positions travel
   and are stored as FEN, which keeps the object's storage tiny.
   ═══════════════════════════════════════════════════════════════════════════ */

const WHITE = "w";
const BLACK = "b";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const fileOf = (sq) => sq & 7;
const rankOf = (sq) => 7 - (sq >> 3); // 0 = rank 1, 7 = rank 8
const squareAt = (file, rank) => (7 - rank) * 8 + file;
const onBoard = (file, rank) => file >= 0 && file < 8 && rank >= 0 && rank < 8;
const nameOf = (sq) => String.fromCharCode(97 + fileOf(sq)) + (rankOf(sq) + 1);

function squareFromName(name) {
  if (typeof name !== "string" || name.length !== 2) return -1;
  const file = name.charCodeAt(0) - 97;
  const rank = name.charCodeAt(1) - 49;
  return onBoard(file, rank) ? squareAt(file, rank) : -1;
}

const isWhitePiece = (p) => p !== null && p === p.toUpperCase();
const colorOf = (p) => (p === null ? null : isWhitePiece(p) ? WHITE : BLACK);
const kindOf = (p) => (p === null ? null : p.toLowerCase());
const other = (color) => (color === WHITE ? BLACK : WHITE);

const KNIGHT_STEPS = [
  [1, 2], [2, 1], [2, -1], [1, -2],
  [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const KING_STEPS = [
  [0, 1], [1, 1], [1, 0], [1, -1],
  [0, -1], [-1, -1], [-1, 0], [-1, 1],
];
const ROOK_RAYS = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const BISHOP_RAYS = [[1, 1], [1, -1], [-1, -1], [-1, 1]];

// ── FEN ────────────────────────────────────────────────────────────────────

function parseFEN(fen) {
  const [placement, turn, castling, ep, half, full] = fen.trim().split(/\s+/);
  const board = new Array(64).fill(null);
  let sq = 0;
  for (const ch of placement) {
    if (ch === "/") continue;
    if (ch >= "1" && ch <= "8") sq += Number(ch);
    else board[sq++] = ch;
  }
  return {
    board,
    turn: turn === BLACK ? BLACK : WHITE,
    castling: castling === "-" ? "" : castling,
    ep: ep && ep !== "-" ? squareFromName(ep) : null,
    half: Number(half) || 0,
    full: Number(full) || 1,
  };
}

function toFEN(state) {
  let placement = "";
  for (let rank = 0; rank < 8; rank++) {
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = state.board[rank * 8 + file];
      if (piece === null) {
        empty++;
      } else {
        if (empty) placement += empty;
        empty = 0;
        placement += piece;
      }
    }
    if (empty) placement += empty;
    if (rank < 7) placement += "/";
  }
  const ep = state.ep === null ? "-" : nameOf(state.ep);
  return `${placement} ${state.turn} ${state.castling || "-"} ${ep} ${state.half} ${state.full}`;
}

// The repetition key is a FEN without the move counters: the same position with
// the same rights and the same en-passant option is the same position.
const positionKey = (state) => toFEN(state).split(" ").slice(0, 4).join(" ");

// ── Attack detection ───────────────────────────────────────────────────────

// Is `sq` attacked by any piece of `by`? Used for check, castling paths, and
// for filtering pseudo-legal moves down to legal ones.
function isAttacked(board, sq, by) {
  const file = fileOf(sq);
  const rank = rankOf(sq);

  // Pawns. A white pawn on (f, r) attacks (f±1, r+1), so a square is attacked
  // by a white pawn if one sits one rank below it diagonally.
  const pawnRank = by === WHITE ? rank - 1 : rank + 1;
  for (const df of [-1, 1]) {
    if (!onBoard(file + df, pawnRank)) continue;
    const piece = board[squareAt(file + df, pawnRank)];
    if (piece !== null && colorOf(piece) === by && kindOf(piece) === "p") return true;
  }

  for (const [df, dr] of KNIGHT_STEPS) {
    if (!onBoard(file + df, rank + dr)) continue;
    const piece = board[squareAt(file + df, rank + dr)];
    if (piece !== null && colorOf(piece) === by && kindOf(piece) === "n") return true;
  }

  for (const [df, dr] of KING_STEPS) {
    if (!onBoard(file + df, rank + dr)) continue;
    const piece = board[squareAt(file + df, rank + dr)];
    if (piece !== null && colorOf(piece) === by && kindOf(piece) === "k") return true;
  }

  const rays = [
    [ROOK_RAYS, "r"],
    [BISHOP_RAYS, "b"],
  ];
  for (const [directions, sliding] of rays) {
    for (const [df, dr] of directions) {
      let f = file + df;
      let r = rank + dr;
      while (onBoard(f, r)) {
        const piece = board[squareAt(f, r)];
        if (piece !== null) {
          if (colorOf(piece) === by) {
            const kind = kindOf(piece);
            if (kind === sliding || kind === "q") return true;
          }
          break;
        }
        f += df;
        r += dr;
      }
    }
  }
  return false;
}

function kingSquare(board, color) {
  const king = color === WHITE ? "K" : "k";
  for (let sq = 0; sq < 64; sq++) if (board[sq] === king) return sq;
  return -1;
}

function inCheck(state, color) {
  const king = kingSquare(state.board, color);
  return king === -1 ? false : isAttacked(state.board, king, other(color));
}

// ── Move generation ────────────────────────────────────────────────────────

const PROMOTION_PIECES = ["q", "r", "b", "n"];

function pseudoLegalMoves(state) {
  const { board, turn } = state;
  const moves = [];
  const push = (move) => moves.push(move);

  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (piece === null || colorOf(piece) !== turn) continue;
    const file = fileOf(from);
    const rank = rankOf(from);
    const kind = kindOf(piece);

    if (kind === "p") {
      const forward = turn === WHITE ? 1 : -1;
      const startRank = turn === WHITE ? 1 : 6;
      const lastRank = turn === WHITE ? 7 : 0;

      const oneRank = rank + forward;
      if (onBoard(file, oneRank)) {
        const one = squareAt(file, oneRank);
        if (board[one] === null) {
          if (oneRank === lastRank) {
            for (const promo of PROMOTION_PIECES) push({ from, to: one, piece, promo });
          } else {
            push({ from, to: one, piece });
            const twoRank = rank + forward * 2;
            if (rank === startRank && board[squareAt(file, twoRank)] === null) {
              push({ from, to: squareAt(file, twoRank), piece, double: true });
            }
          }
        }
      }

      for (const df of [-1, 1]) {
        if (!onBoard(file + df, oneRank)) continue;
        const to = squareAt(file + df, oneRank);
        const target = board[to];
        if (target !== null && colorOf(target) !== turn) {
          if (oneRank === lastRank) {
            for (const promo of PROMOTION_PIECES) push({ from, to, piece, captured: target, promo });
          } else {
            push({ from, to, piece, captured: target });
          }
        } else if (target === null && state.ep !== null && to === state.ep) {
          const grabbed = squareAt(file + df, rank);
          push({ from, to, piece, captured: board[grabbed], enPassant: true });
        }
      }
      continue;
    }

    if (kind === "n" || kind === "k") {
      const steps = kind === "n" ? KNIGHT_STEPS : KING_STEPS;
      for (const [df, dr] of steps) {
        if (!onBoard(file + df, rank + dr)) continue;
        const to = squareAt(file + df, rank + dr);
        const target = board[to];
        if (target !== null && colorOf(target) === turn) continue;
        push({ from, to, piece, captured: target ?? undefined });
      }
      continue;
    }

    const directions =
      kind === "r" ? ROOK_RAYS : kind === "b" ? BISHOP_RAYS : [...ROOK_RAYS, ...BISHOP_RAYS];
    for (const [df, dr] of directions) {
      let f = file + df;
      let r = rank + dr;
      while (onBoard(f, r)) {
        const to = squareAt(f, r);
        const target = board[to];
        if (target !== null && colorOf(target) === turn) break;
        push({ from, to, piece, captured: target ?? undefined });
        if (target !== null) break;
        f += df;
        r += dr;
      }
    }
  }

  addCastlingMoves(state, push);
  return moves;
}

function addCastlingMoves(state, push) {
  const { board, turn, castling } = state;
  const homeRank = turn === WHITE ? 0 : 7;
  const kingFrom = squareAt(4, homeRank);
  const king = turn === WHITE ? "K" : "k";
  if (board[kingFrom] !== king) return;
  // Castling out of check is illegal; the two transit squares are checked below.
  if (isAttacked(board, kingFrom, other(turn))) return;

  const sides = [
    { right: turn === WHITE ? "K" : "k", rookFile: 7, empty: [5, 6], pass: [5, 6], kingFile: 6, side: "k" },
    { right: turn === WHITE ? "Q" : "q", rookFile: 0, empty: [1, 2, 3], pass: [3, 2], kingFile: 2, side: "q" },
  ];

  for (const spec of sides) {
    if (!castling.includes(spec.right)) continue;
    const rookFrom = squareAt(spec.rookFile, homeRank);
    const rook = turn === WHITE ? "R" : "r";
    if (board[rookFrom] !== rook) continue;
    if (spec.empty.some((file) => board[squareAt(file, homeRank)] !== null)) continue;
    if (spec.pass.some((file) => isAttacked(board, squareAt(file, homeRank), other(turn)))) continue;
    push({
      from: kingFrom,
      to: squareAt(spec.kingFile, homeRank),
      piece: board[kingFrom],
      castle: spec.side,
      rookFrom,
      rookTo: squareAt(spec.side === "k" ? 5 : 3, homeRank),
    });
  }
}

function applyMove(state, move) {
  const board = state.board.slice();
  const turn = state.turn;
  const kind = kindOf(move.piece);

  board[move.from] = null;
  board[move.to] = move.promo
    ? turn === WHITE
      ? move.promo.toUpperCase()
      : move.promo.toLowerCase()
    : move.piece;

  if (move.enPassant) {
    // The captured pawn sits beside the destination, not on it.
    board[squareAt(fileOf(move.to), rankOf(move.from))] = null;
  }
  if (move.castle) {
    board[move.rookTo] = board[move.rookFrom];
    board[move.rookFrom] = null;
  }

  // Castling rights fall away when a king or rook leaves home, or when a rook
  // is captured on its home square.
  let castling = state.castling;
  const drop = (chars) => {
    for (const ch of chars) castling = castling.replace(ch, "");
  };
  if (kind === "k") drop(turn === WHITE ? "KQ" : "kq");
  if (move.from === 56 || move.to === 56) drop("Q");
  if (move.from === 63 || move.to === 63) drop("K");
  if (move.from === 0 || move.to === 0) drop("q");
  if (move.from === 7 || move.to === 7) drop("k");

  const ep = move.double
    ? squareAt(fileOf(move.from), (rankOf(move.from) + rankOf(move.to)) / 2)
    : null;

  const captured = move.captured !== undefined && move.captured !== null;
  return {
    board,
    turn: other(turn),
    castling,
    ep,
    half: kind === "p" || captured ? 0 : state.half + 1,
    full: turn === BLACK ? state.full + 1 : state.full,
  };
}

// The public entry point: pseudo-legal moves minus any that leave our own king
// attacked. Everything else in the app consumes this.
function legalMoves(state) {
  const legal = [];
  for (const move of pseudoLegalMoves(state)) {
    const next = applyMove(state, move);
    if (!isAttacked(next.board, kingSquare(next.board, state.turn), other(state.turn))) {
      legal.push(move);
    }
  }
  return legal;
}

// { "e2": ["e3", "e4"], … } — exactly what the board UI needs to highlight
// destinations without knowing a single rule.
function legalMap(moves) {
  const map = {};
  for (const move of moves) {
    const from = nameOf(move.from);
    const to = nameOf(move.to);
    if (!map[from]) map[from] = [];
    if (!map[from].includes(to)) map[from].push(to);
  }
  return map;
}

// ── Algebraic notation ─────────────────────────────────────────────────────

function toSAN(state, move, moves) {
  if (move.castle) {
    return decorate(state, move, move.castle === "k" ? "O-O" : "O-O-O");
  }
  const kind = kindOf(move.piece);
  const target = nameOf(move.to);
  const captured = move.captured !== undefined && move.captured !== null;

  if (kind === "p") {
    let san = captured ? `${String.fromCharCode(97 + fileOf(move.from))}x${target}` : target;
    if (move.promo) san += `=${move.promo.toUpperCase()}`;
    return decorate(state, move, san);
  }

  // Disambiguate only against other moves of the same piece kind to the same
  // square: prefer the file, fall back to the rank, then to both.
  const rivals = moves.filter(
    (m) => m !== move && m.to === move.to && kindOf(m.piece) === kind && m.from !== move.from,
  );
  let hint = "";
  if (rivals.length) {
    const sameFile = rivals.some((m) => fileOf(m.from) === fileOf(move.from));
    const sameRank = rivals.some((m) => rankOf(m.from) === rankOf(move.from));
    if (!sameFile) hint = String.fromCharCode(97 + fileOf(move.from));
    else if (!sameRank) hint = String(rankOf(move.from) + 1);
    else hint = nameOf(move.from);
  }
  return decorate(state, move, `${kind.toUpperCase()}${hint}${captured ? "x" : ""}${target}`);
}

function decorate(state, move, san) {
  const next = applyMove(state, move);
  if (!inCheck(next, next.turn)) return san;
  return san + (legalMoves(next).length === 0 ? "#" : "+");
}

// ── Outcomes ───────────────────────────────────────────────────────────────

function insufficientMaterial(board) {
  const minor = [];
  for (let sq = 0; sq < 64; sq++) {
    const piece = board[sq];
    if (piece === null) continue;
    const kind = kindOf(piece);
    if (kind === "k") continue;
    if (kind === "p" || kind === "r" || kind === "q") return false;
    minor.push({ kind, color: colorOf(piece), light: (fileOf(sq) + rankOf(sq)) % 2 === 1 });
  }
  if (minor.length === 0) return true; // K vs K
  if (minor.length === 1) return true; // K+B or K+N vs K
  if (minor.length === 2) {
    const [a, b] = minor;
    // Two bishops on the same colour complex can never mate.
    if (a.kind === "b" && b.kind === "b" && a.color !== b.color && a.light === b.light) return true;
  }
  return false;
}

// `reps` maps a position key to how many times it has occurred, this position
// included. Returns null while the game is still alive.
function outcome(state, moves, reps) {
  if (moves.length === 0) {
    return inCheck(state, state.turn)
      ? { result: other(state.turn) === WHITE ? "white" : "black", reason: "checkmate" }
      : { result: "draw", reason: "stalemate" };
  }
  if (insufficientMaterial(state.board)) return { result: "draw", reason: "insufficient material" };
  if (state.half >= 100) return { result: "draw", reason: "fifty-move rule" };
  if ((reps?.[positionKey(state)] ?? 0) >= 3) return { result: "draw", reason: "threefold repetition" };
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. SHARED HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// The edge strips inbound X-Yard-* headers, so these are trustworthy.
function identity(request) {
  const h = request.headers;
  return {
    userId: h.get("X-Yard-User-Id") || "",
    email: h.get("X-Yard-Email") || "",
    entitlement: h.get("X-Yard-Entitlement") || "none",
  };
}

const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"; // no 0/1/i/l/o lookalikes

function newGameId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

function defaultDisplayName(userId, email) {
  if (email && email.includes("@")) return email.split("@")[0];
  const base = String(userId).replace(/^dev-user-/, "").replace(/[-_]+/g, " ").trim();
  return base ? base.replace(/\b\w/g, (c) => c.toUpperCase()) : "Player";
}

// Every entry point that knows a user id funnels through here, so a player row
// always exists by the time anything wants to show a name.
async function ensurePlayer(db, userId, email) {
  const fallback = defaultDisplayName(userId, email);
  if (!db || !userId) return { userId, email, displayName: fallback };
  const now = Date.now();
  const row = await db
    .prepare("SELECT display_name, email FROM players WHERE user_id = ?1")
    .bind(userId)
    .first();
  if (row) {
    if (email && row.email !== email) {
      await db
        .prepare("UPDATE players SET email = ?2, updated_at = ?3 WHERE user_id = ?1")
        .bind(userId, email, now)
        .run();
    }
    return { userId, email: email || row.email, displayName: row.display_name || fallback };
  }
  await db
    .prepare(
      "INSERT INTO players (user_id, display_name, email, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT(user_id) DO NOTHING",
    )
    .bind(userId, fallback, email, now)
    .run();
  return { userId, email, displayName: fallback };
}

// The record is derived from the games table rather than counted into columns,
// so it can never drift no matter how often a result write is retried.
async function playerRecord(db, userId) {
  const empty = { played: 0, wins: 0, losses: 0, draws: 0 };
  if (!db || !userId) return empty;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS played,
              SUM(CASE WHEN (white_id = ?1 AND result = 'white')
                         OR (black_id = ?1 AND result = 'black') THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN (white_id = ?1 AND result = 'black')
                         OR (black_id = ?1 AND result = 'white') THEN 1 ELSE 0 END) AS losses,
              SUM(CASE WHEN result = 'draw' THEN 1 ELSE 0 END) AS draws
         FROM games
        WHERE white_id = ?1 OR black_id = ?1`,
    )
    .bind(userId)
    .first();
  if (!row) return empty;
  return {
    played: Number(row.played) || 0,
    wins: Number(row.wins) || 0,
    losses: Number(row.losses) || 0,
    draws: Number(row.draws) || 0,
  };
}

async function recentGames(db, userId, limit = 8) {
  if (!db || !userId) return [];
  const { results } = await db
    .prepare(
      `SELECT id, white_id, black_id, white_name, black_name, result, reason, moves, ended_at
         FROM games
        WHERE white_id = ?1 OR black_id = ?1
        ORDER BY ended_at DESC
        LIMIT ?2`,
    )
    .bind(userId, limit)
    .all();
  return (results ?? []).map((row) => {
    const asWhite = row.white_id === userId;
    const outcomeFor =
      row.result === "draw" ? "draw" : (row.result === "white") === asWhite ? "win" : "loss";
    return {
      id: row.id,
      opponent: (asWhite ? row.black_name : row.white_name) || "Opponent",
      color: asWhite ? "white" : "black",
      outcome: outcomeFor,
      reason: row.reason,
      moves: row.moves,
      endedAt: row.ended_at,
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. FETCH HANDLER — routes only. All fan-out happens inside the Game object.
   ═══════════════════════════════════════════════════════════════════════════ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/_service.js") return new Response("Not found", { status: 404 });

    if (path === "/ws" && request.method === "GET") {
      const id = url.searchParams.get("game");
      if (!id) return new Response("game is required", { status: 400 });
      return gameObject(env, id).fetch(request);
    }

    if (path.startsWith("/api/")) {
      try {
        return await handleAPI(request, env, url);
      } catch (err) {
        console.error("api error", path, err && err.stack ? err.stack : String(err));
        return json({ error: "Something went wrong" }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};

const gameObject = (env, id) => env.GAMES.get(env.GAMES.idFromName(id));

async function handleAPI(request, env, url) {
  const path = url.pathname;
  const me = identity(request);
  if (!me.userId) return json({ error: "Sign in to play" }, 401);
  const db = env.DB ?? null;

  if (path === "/api/me" && request.method === "GET") {
    const player = await ensurePlayer(db, me.userId, me.email);
    return json({
      user_id: me.userId,
      email: me.email,
      display_name: player.displayName,
      entitlement: me.entitlement,
      record: await playerRecord(db, me.userId),
      recent: await recentGames(db, me.userId),
    });
  }

  if (path === "/api/me" && request.method === "PUT") {
    const body = await request.json().catch(() => ({}));
    const name = String(body.display_name ?? "").trim().slice(0, 32);
    if (!name) return json({ error: "A display name is required" }, 400);
    await ensurePlayer(db, me.userId, me.email);
    if (db) {
      await db
        .prepare("UPDATE players SET display_name = ?2, updated_at = ?3 WHERE user_id = ?1")
        .bind(me.userId, name, Date.now())
        .run();
    }
    return json({ display_name: name });
  }

  if (path === "/api/games" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const baseMs = Math.max(0, Math.min(180, Number(body.minutes) || 0)) * 60_000;
    const incMs = Math.max(0, Math.min(60, Number(body.increment) || 0)) * 1000;
    const player = await ensurePlayer(db, me.userId, me.email);
    const id = newGameId();
    await gameObject(env, id).fetch(
      new Request("https://game.internal/_create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          baseMs,
          incMs,
          creatorId: me.userId,
          creatorName: player.displayName,
        }),
      }),
    );
    return json({ id });
  }

  const summary = path.match(/^\/api\/games\/([a-z0-9]+)$/);
  if (summary && request.method === "GET") {
    return gameObject(env, summary[1]).fetch(new Request("https://game.internal/_summary"));
  }

  return json({ error: "Not found" }, 404);
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. THE GAME OBJECT — one live match.

   Every visitor of a game id reaches this same instance, so it owns both
   sockets and every broadcast. It handles one event at a time, so there is no
   locking to do. It also hibernates whenever it is idle: instance fields are
   gone by the next event, so *all* state is read from and written to
   ctx.storage, and the clock is enforced with an alarm rather than a timer.
   ═══════════════════════════════════════════════════════════════════════════ */

const DEFAULT_BASE_MS = 10 * 60_000;
const DEFAULT_INC_MS = 5_000;

function safeAttachment(ws) {
  try {
    return ws.deserializeAttachment() ?? null;
  } catch {
    return null;
  }
}

// Remaining time right now, counting down the side whose clock is running.
function clockNow(meta, clock, turnSeat, now) {
  let whiteMs = clock.whiteMs;
  let blackMs = clock.blackMs;
  if (meta.status === "active" && clock.runningSince !== null) {
    const elapsed = Math.max(0, now - clock.runningSince);
    if (turnSeat === "white") whiteMs = Math.max(0, whiteMs - elapsed);
    else blackMs = Math.max(0, blackMs - elapsed);
  }
  return { whiteMs, blackMs };
}

// Flag-fall is only a loss if the opponent could conceivably mate; with a lone
// king (or king and one minor) it is a draw instead.
function hasMatingMaterial(board, color) {
  let minors = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = board[sq];
    if (piece === null || colorOf(piece) !== color) continue;
    const kind = kindOf(piece);
    if (kind === "p" || kind === "r" || kind === "q") return true;
    if (kind === "b" || kind === "n") minors++;
  }
  return minors >= 2;
}

function capturedBy(history) {
  const white = [];
  const black = [];
  for (const entry of history) {
    if (!entry.captured) continue;
    if (isWhitePiece(entry.captured)) black.push(entry.captured);
    else white.push(entry.captured);
  }
  return { white, black };
}

export class Game {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  // ── storage ──────────────────────────────────────────────────────────────

  async readAll() {
    const s = this.ctx.storage;
    const [meta, fen, history, reps, clock, drawOffer, rematch] = await Promise.all([
      s.get("meta"),
      s.get("fen"),
      s.get("history"),
      s.get("reps"),
      s.get("clock"),
      s.get("drawOffer"),
      s.get("rematch"),
    ]);
    return {
      meta: meta ?? null,
      fen: fen ?? START_FEN,
      history: history ?? [],
      reps: reps ?? {},
      clock: clock ?? { whiteMs: 0, blackMs: 0, runningSince: null },
      drawOffer: drawOffer ?? null,
      rematch: rematch ?? {},
    };
  }

  freshMeta(id, baseMs, incMs) {
    return {
      id,
      gameNo: 1,
      createdAt: Date.now(),
      whiteId: "",
      whiteName: "",
      blackId: "",
      blackName: "",
      baseMs,
      incMs,
      status: "waiting",
      result: null,
      reason: null,
      startedAt: null,
      endedAt: null,
    };
  }

  // Puts the board back to the starting position under `meta`. Used both for a
  // brand-new game and for a rematch, which is why `recorded` resets here.
  async reset(meta) {
    const start = parseFEN(START_FEN);
    const s = this.ctx.storage;
    await Promise.all([
      s.put("meta", meta),
      s.put("fen", START_FEN),
      s.put("history", []),
      s.put("reps", { [positionKey(start)]: 1 }),
      s.put("clock", { whiteMs: meta.baseMs, blackMs: meta.baseMs, runningSince: null }),
      s.put("drawOffer", null),
      s.put("rematch", {}),
      s.put("recorded", false),
    ]);
  }

  // ── entry points ─────────────────────────────────────────────────────────

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/_create" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!(await this.ctx.storage.get("meta"))) {
        await this.reset(
          this.freshMeta(
            String(body.id ?? ""),
            Number.isFinite(body.baseMs) ? body.baseMs : DEFAULT_BASE_MS,
            Number.isFinite(body.incMs) ? body.incMs : DEFAULT_INC_MS,
          ),
        );
      }
      return json({ ok: true });
    }

    if (url.pathname === "/_summary") {
      const { meta, history } = await this.readAll();
      if (!meta) return json({ exists: false });
      return json({
        exists: true,
        id: meta.id,
        status: meta.status,
        white: meta.whiteId ? meta.whiteName : null,
        black: meta.blackId ? meta.blackName : null,
        baseMs: meta.baseMs,
        incMs: meta.incMs,
        moves: history.length,
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    return this.accept(request, url);
  }

  async accept(request, url) {
    const me = identity(request);
    const userId = me.userId || "anonymous";
    const seatHint = url.searchParams.get("seat");

    let { meta } = await this.readAll();
    if (!meta) {
      // A link that outlived its object (or was hand-typed) still opens as a
      // playable game rather than a dead end.
      meta = this.freshMeta(url.searchParams.get("game") ?? "", DEFAULT_BASE_MS, DEFAULT_INC_MS);
      await this.reset(meta);
    }

    const player = await ensurePlayer(this.env.DB ?? null, me.userId, me.email);
    const name = player.displayName;

    // Reconnecting returns you to your seat. Otherwise you take the first open
    // one — and `?seat=` lets one person deliberately hold both, which is what
    // makes a solo two-tab test work.
    const openSeat = (seat) => (seat === "white" ? !meta.whiteId : !meta.blackId);
    const ownSeat = (seat) => (seat === "white" ? meta.whiteId : meta.blackId) === userId;
    let seat = "spectator";
    if ((seatHint === "white" || seatHint === "black") && (openSeat(seatHint) || ownSeat(seatHint))) {
      seat = seatHint;
    } else if (meta.whiteId === userId) seat = "white";
    else if (meta.blackId === userId) seat = "black";
    else if (!meta.whiteId) seat = "white";
    else if (!meta.blackId) seat = "black";

    let changed = false;
    if (seat === "white" && (meta.whiteId !== userId || meta.whiteName !== name)) {
      meta.whiteId = userId;
      meta.whiteName = name;
      changed = true;
    }
    if (seat === "black" && (meta.blackId !== userId || meta.blackName !== name)) {
      meta.blackId = userId;
      meta.blackName = name;
      changed = true;
    }

    if (meta.status === "waiting" && meta.whiteId && meta.blackId) {
      meta.status = "active";
      meta.startedAt = Date.now();
      changed = true;
      if (meta.baseMs) {
        const clock = { whiteMs: meta.baseMs, blackMs: meta.baseMs, runningSince: Date.now() };
        await this.ctx.storage.put("clock", clock);
        await this.armAlarm(meta, clock, "white");
      }
    }
    if (changed) await this.ctx.storage.put("meta", meta);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [userId.slice(0, 60)]);
    server.serializeAttachment({ userId, seat, name });
    await this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 8192) return;
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const att = safeAttachment(ws) ?? { seat: "spectator", userId: "", name: "" };
    const store = await this.readAll();
    if (!store.meta) return;

    switch (msg.t) {
      case "sync":
        return this.sendState(ws, await this.snapshot(store));
      case "move":
        return this.onMove(ws, att, store, msg);
      case "resign":
        return this.onResign(ws, att, store);
      case "draw-offer":
        return this.onDrawOffer(ws, att, store);
      case "draw-accept":
        return this.onDrawAccept(ws, att, store);
      case "draw-decline":
        return this.onDrawDecline(ws, att, store);
      case "rematch":
        return this.onRematch(ws, att, store);
      default:
        return;
    }
  }

  async webSocketClose(ws) {
    await this.broadcast(ws);
  }

  async webSocketError(ws) {
    await this.broadcast(ws);
  }

  // The clock's only enforcement. Re-armed after every move; survives
  // hibernation, which a setTimeout would not.
  async alarm() {
    const store = await this.readAll();
    const { meta, fen, history, clock } = store;
    if (!meta) return;

    // A result that could not reach the database gets retried here.
    if (meta.status === "over") {
      if (!(await this.ctx.storage.get("recorded"))) await this.record(meta, history);
      return;
    }
    if (meta.status !== "active" || !meta.baseMs) return;

    const state = parseFEN(fen);
    const turnSeat = state.turn === WHITE ? "white" : "black";
    const now = Date.now();
    const live = clockNow(meta, clock, turnSeat, now);
    const remaining = turnSeat === "white" ? live.whiteMs : live.blackMs;

    if (remaining > 0) {
      // Woke early (or a move landed just in time) — re-arm and carry on.
      await this.ctx.storage.setAlarm(now + remaining);
      return;
    }

    clock.whiteMs = live.whiteMs;
    clock.blackMs = live.blackMs;
    clock.runningSince = null;
    await this.ctx.storage.put("clock", clock);

    const winner = turnSeat === "white" ? "black" : "white";
    const winnerColor = turnSeat === "white" ? BLACK : WHITE;
    if (hasMatingMaterial(state.board, winnerColor)) {
      await this.finish(meta, history, winner, "timeout");
    } else {
      await this.finish(meta, history, "draw", "timeout vs insufficient material");
    }
  }

  // ── actions ──────────────────────────────────────────────────────────────

  async onMove(ws, att, store, msg) {
    const { meta, fen, history, reps, clock } = store;
    if (meta.status !== "active") return this.error(ws, "The game is not in play.");
    if (att.seat !== "white" && att.seat !== "black") {
      return this.error(ws, "You are watching this game.");
    }

    const state = parseFEN(fen);
    const turnSeat = state.turn === WHITE ? "white" : "black";
    if (att.seat !== turnSeat) return this.error(ws, "It is not your turn.");

    // Anti-stale guard: a client that missed a snapshot cannot move into a
    // position that no longer exists.
    if (typeof msg.ply === "number" && msg.ply !== history.length) {
      return this.error(ws, "The board moved on — that move is out of date.");
    }

    const from = squareFromName(msg.from);
    const to = squareFromName(msg.to);
    const moves = legalMoves(state);
    const candidates = moves.filter((m) => m.from === from && m.to === to);
    if (candidates.length === 0) return this.error(ws, "That move is not legal.");

    const promo = typeof msg.promo === "string" ? msg.promo.toLowerCase() : null;
    const move =
      candidates.length === 1
        ? candidates[0]
        : (candidates.find((m) => m.promo === promo) ?? candidates.find((m) => m.promo === "q"));
    if (!move) return this.error(ws, "That move is not legal.");

    const san = toSAN(state, move, moves);
    const next = applyMove(state, move);
    const nextMoves = legalMoves(next);
    const key = positionKey(next);
    reps[key] = (reps[key] ?? 0) + 1;

    const now = Date.now();
    if (meta.baseMs) {
      const elapsed = clock.runningSince === null ? 0 : Math.max(0, now - clock.runningSince);
      if (turnSeat === "white") clock.whiteMs = Math.max(0, clock.whiteMs - elapsed) + meta.incMs;
      else clock.blackMs = Math.max(0, clock.blackMs - elapsed) + meta.incMs;
      clock.runningSince = now;
    }

    history.push({
      san,
      from: nameOf(move.from),
      to: nameOf(move.to),
      promo: move.promo ?? null,
      captured: move.captured ?? null,
      at: now,
    });

    const s = this.ctx.storage;
    await Promise.all([
      s.put("fen", toFEN(next)),
      s.put("history", history),
      s.put("reps", reps),
      s.put("clock", clock),
      s.put("drawOffer", null),
    ]);

    const done = outcome(next, nextMoves, reps);
    if (done) return this.finish(meta, history, done.result, done.reason);

    await this.armAlarm(meta, clock, next.turn === WHITE ? "white" : "black");
    await this.broadcast();
  }

  async onResign(ws, att, store) {
    const { meta, history } = store;
    if (meta.status !== "active") return;
    if (att.seat !== "white" && att.seat !== "black") {
      return this.error(ws, "You are watching this game.");
    }
    await this.finish(meta, history, att.seat === "white" ? "black" : "white", "resignation");
  }

  async onDrawOffer(ws, att, store) {
    const { meta } = store;
    if (meta.status !== "active") return;
    if (att.seat !== "white" && att.seat !== "black") return;
    await this.ctx.storage.put("drawOffer", att.seat);
    await this.broadcast();
  }

  async onDrawAccept(ws, att, store) {
    const { meta, history, drawOffer } = store;
    if (meta.status !== "active") return;
    if (att.seat !== "white" && att.seat !== "black") return;
    if (!drawOffer || drawOffer === att.seat) return;
    await this.finish(meta, history, "draw", "agreement");
  }

  async onDrawDecline(ws, att, store) {
    const { drawOffer } = store;
    if (!drawOffer || drawOffer === att.seat) return;
    await this.ctx.storage.put("drawOffer", null);
    await this.broadcast();
  }

  async onRematch(ws, att, store) {
    const { meta, rematch } = store;
    if (meta.status !== "over") return;
    if (att.seat !== "white" && att.seat !== "black") return;

    rematch[att.seat] = true;
    if (!(rematch.white && rematch.black)) {
      await this.ctx.storage.put("rematch", rematch);
      return this.broadcast();
    }

    // Both agreed: same room, next game, colours swapped.
    const next = {
      ...meta,
      gameNo: meta.gameNo + 1,
      whiteId: meta.blackId,
      whiteName: meta.blackName,
      blackId: meta.whiteId,
      blackName: meta.whiteName,
      status: "active",
      result: null,
      reason: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    await this.reset(next);

    for (const socket of this.ctx.getWebSockets()) {
      const a = safeAttachment(socket);
      if (!a) continue;
      if (a.seat === "white") socket.serializeAttachment({ ...a, seat: "black" });
      else if (a.seat === "black") socket.serializeAttachment({ ...a, seat: "white" });
    }

    if (next.baseMs) {
      const clock = { whiteMs: next.baseMs, blackMs: next.baseMs, runningSince: Date.now() };
      await this.ctx.storage.put("clock", clock);
      await this.armAlarm(next, clock, "white");
    }
    await this.broadcast();
  }

  // ── ending a game ────────────────────────────────────────────────────────

  async finish(meta, history, result, reason) {
    const fen = (await this.ctx.storage.get("fen")) ?? START_FEN;
    const clock = (await this.ctx.storage.get("clock")) ?? {
      whiteMs: 0,
      blackMs: 0,
      runningSince: null,
    };
    const turnSeat = parseFEN(fen).turn === WHITE ? "white" : "black";
    const live = clockNow(meta, clock, turnSeat, Date.now());

    meta.status = "over";
    meta.result = result;
    meta.reason = reason;
    meta.endedAt = Date.now();

    const s = this.ctx.storage;
    await Promise.all([
      s.put("meta", meta),
      s.put("clock", { whiteMs: live.whiteMs, blackMs: live.blackMs, runningSince: null }),
      s.put("drawOffer", null),
      s.put("rematch", {}),
      s.deleteAlarm(),
    ]);

    await this.record(meta, history);
    await this.broadcast();
  }

  // Write-once. The `recorded` flag is the cheap guard; ON CONFLICT DO NOTHING
  // against the per-game record id is the one correctness actually rests on,
  // because the flag can be lost and the flag is not what the record reads.
  async record(meta, history) {
    if (await this.ctx.storage.get("recorded")) return;

    const db = this.env.DB ?? null;
    // A game someone played against themselves is not a real result, and a
    // service can briefly deploy without env.DB before the first migration.
    if (!meta.whiteId || !meta.blackId || meta.whiteId === meta.blackId) {
      await this.ctx.storage.put("recorded", true);
      return;
    }
    if (!db) {
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
      return;
    }

    const pgn = history
      .map((entry, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : "") + entry.san)
      .join(" ");

    try {
      await db
        .prepare(
          `INSERT INTO games
             (id, white_id, black_id, white_name, black_name, result, reason, moves, pgn, created_at, ended_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          `${meta.id}#${meta.gameNo}`,
          meta.whiteId,
          meta.blackId,
          meta.whiteName,
          meta.blackName,
          meta.result,
          meta.reason,
          history.length,
          pgn,
          meta.createdAt,
          meta.endedAt,
        )
        .run();
      await this.ctx.storage.put("recorded", true);
    } catch (err) {
      // Leave `recorded` false and come back to it: the result is only really
      // saved once the row is in. ON CONFLICT DO NOTHING makes the retry safe.
      console.error("failed to record game", meta.id, err && err.stack ? err.stack : String(err));
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
    }
  }

  // ── talking to clients ───────────────────────────────────────────────────

  async armAlarm(meta, clock, sideToMove) {
    if (!meta.baseMs || meta.status !== "active") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const remaining = sideToMove === "white" ? clock.whiteMs : clock.blackMs;
    await this.ctx.storage.setAlarm((clock.runningSince ?? Date.now()) + remaining);
  }

  presence(exclude) {
    const seats = { white: false, black: false };
    let spectators = 0;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue;
      const att = safeAttachment(socket);
      if (!att) continue;
      if (att.seat === "white" || att.seat === "black") seats[att.seat] = true;
      else spectators++;
    }
    return { ...seats, spectators };
  }

  // One full snapshot per change. The board is tiny and the client is a pure
  // function of the last snapshot, which removes every desync bug deltas have.
  async snapshot(store, exclude) {
    const s = store ?? (await this.readAll());
    const { meta, fen, history, clock, drawOffer, rematch } = s;
    const state = parseFEN(fen);
    const turnSeat = state.turn === WHITE ? "white" : "black";
    const here = this.presence(exclude);
    const now = Date.now();
    const last = history.length ? history[history.length - 1] : null;

    return {
      t: "state",
      id: meta.id,
      gameNo: meta.gameNo,
      fen,
      turn: turnSeat,
      status: meta.status,
      result: meta.result,
      reason: meta.reason,
      ply: history.length,
      legal: meta.status === "active" ? legalMap(legalMoves(state)) : {},
      lastMove: last ? { from: last.from, to: last.to } : null,
      check: inCheck(state, state.turn) ? turnSeat : null,
      white: { id: meta.whiteId, name: meta.whiteName, connected: here.white },
      black: { id: meta.blackId, name: meta.blackName, connected: here.black },
      spectators: here.spectators,
      history: history.map((entry) => ({ san: entry.san, from: entry.from, to: entry.to })),
      captured: capturedBy(history),
      clock: meta.baseMs
        ? {
            ...clockNow(meta, clock, turnSeat, now),
            running: meta.status === "active" && clock.runningSince !== null ? turnSeat : null,
            baseMs: meta.baseMs,
            incMs: meta.incMs,
          }
        : null,
      drawOffer,
      rematch: Object.keys(rematch).filter((seat) => rematch[seat]),
    };
  }

  sendState(ws, base) {
    const att = safeAttachment(ws) ?? {};
    const seat = att.seat ?? "spectator";
    // Only the side to move is sent a legal-move map. Not a secret — anyone
    // can derive it from the FEN — but a client is never handed moves it has
    // no business making, and spectators are sent nothing to click.
    const mine = base.status === "active" && seat === base.turn;
    try {
      ws.send(
        JSON.stringify({
          ...base,
          legal: mine ? base.legal : {},
          you: { userId: att.userId ?? "", seat, name: att.name ?? "" },
        }),
      );
    } catch {
      // A socket mid-close is dropped by the runtime; nothing to do.
    }
  }

  async broadcast(exclude) {
    const base = await this.snapshot(null, exclude);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue;
      this.sendState(socket, base);
    }
  }

  error(ws, message) {
    try {
      ws.send(JSON.stringify({ t: "error", message }));
    } catch {
      // ditto
    }
  }
}
