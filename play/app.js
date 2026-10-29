// Controller: routing, the WebSocket, the side panel, and the dialogs.

import { createBoard, renderStaticBoard } from "./board.js";
import { pieceElement, VALUE } from "./pieces.js";

/* ── Where we are ─────────────────────────────────────────────────────────
   The service is mounted under a path prefix (and one segment deeper again
   inside a sandbox), so every URL is built relative to the page. A leading
   slash anywhere here would break both. */

const BASE = (() => {
  const here = new URL(location.href);
  let path = here.pathname;
  if (!path.endsWith("/")) {
    path = /\/[^/]*\.[^/]*$/.test(path) ? path.replace(/[^/]*$/, "") : `${path}/`;
  }
  return new URL(path, here.origin);
})();

const api = (path, options) =>
  fetch(new URL(path, BASE), { credentials: "same-origin", ...options });

const $ = (id) => document.getElementById(id);

/* ── State ───────────────────────────────────────────────────────────────── */

let profile = null;
let gameId = null;
let socket = null;
let snapshot = null;
let snapshotAt = 0;
let attempts = 0;
let pending = null;
let pendingTimer = null;
let promoChoice = null;
let clockTimer = null;
let resignArmed = null;

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const board = createBoard($("board"), { onMove: handleMove });

/* ── Small helpers ───────────────────────────────────────────────────────── */

let toastTimer = null;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

function initials(name) {
  const parts = String(name || "?").trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0]).toUpperCase();
}

function formatClock(ms) {
  if (ms === null) return "";
  const total = Math.max(0, ms);
  if (total < 20_000) return (total / 1000).toFixed(1);
  const seconds = Math.floor(total / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatWhen(value) {
  if (!value) return "";
  const then = new Date(Number(value));
  const minutes = Math.round((Date.now() - then.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  if (minutes < 10_080) return `${Math.round(minutes / 1440)}d ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const REASON_TEXT = {
  checkmate: "by checkmate",
  resignation: "by resignation",
  timeout: "on time",
  stalemate: "by stalemate",
  agreement: "by agreement",
  "fifty-move rule": "by the fifty-move rule",
  "threefold repetition": "by repetition",
  "insufficient material": "for insufficient material",
  "timeout vs insufficient material": "on time, with no mating material",
};

/* ── Profile ─────────────────────────────────────────────────────────────── */

// A signed-out visitor plays as a guest: the edge issues the browser a guest id
// and sends it with every request from then on, sockets included.
async function fetchProfile() {
  let response = await api("api/me");
  if (response.status === 401) {
    await api("__yard/auth/guest", { method: "POST" });
    response = await api("api/me");
  }
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

async function loadProfile() {
  try {
    profile = await fetchProfile();
  } catch {
    profile = null;
    $("profile-name").textContent = "Offline";
    $("profile-record").textContent = "";
    paintAccount();
    return;
  }
  paintAccount();
  const { display_name: name, record } = profile;
  const line = `${record.wins}W · ${record.losses}L · ${record.draws}D`;
  $("avatar").textContent = initials(name);
  $("profile-name").textContent = name;
  $("profile-record").textContent = line;
  $("lobby-avatar").textContent = initials(name);
  $("lobby-name").textContent = name;
  $("lobby-record").textContent = record.played ? line : "No games yet";
}

function renderGameList(target, games) {
  target.replaceChildren();
  if (!games.length) {
    const li = document.createElement("li");
    li.className = "muted empty";
    li.textContent = "No finished games yet.";
    target.append(li);
    return;
  }
  for (const game of games) {
    const li = document.createElement("li");

    const tag = document.createElement("span");
    tag.className = `tag ${game.outcome}`;
    tag.textContent = game.outcome === "win" ? "Won" : game.outcome === "loss" ? "Lost" : "Drew";

    const label = document.createElement("span");
    label.textContent = `${game.opponent} · ${REASON_TEXT[game.reason] ?? game.reason}`;

    const when = document.createElement("span");
    when.className = "when";
    when.textContent = formatWhen(game.endedAt);

    li.append(tag, label, when);
    target.append(li);
  }
}

// Sign-in and sign-out come back to this same page, the open match included.
// `return` is a path under the service, which is where this page lives.
function authHref(action) {
  const back = `/${location.search}`;
  return new URL(`__yard/auth/${action}?return=${encodeURIComponent(back)}`, BASE).href;
}

function paintAccount() {
  const signedIn = !!profile?.signed_in;
  $("guest-hint").hidden = !profile || signedIn;
  $("guest-signin").href = authHref("login");
  $("account-text").textContent = signedIn
    ? "Your record is kept on your Yard account."
    : "Playing as a guest. Sign in to keep your record on every device.";
  const link = $("account-link");
  link.textContent = signedIn ? "Sign out" : "Sign in";
  link.href = authHref(signedIn ? "logout" : "login");
  link.classList.toggle("btn-primary", !signedIn);
}

function openProfile() {
  if (!profile) return toast("Could not load your profile. Try again.");
  const { display_name: name, email, record, recent } = profile;
  $("dialog-avatar").textContent = initials(name);
  $("dialog-name").textContent = name;
  $("dialog-email").textContent = profile.signed_in ? email || "" : "Guest";
  $("rec-wins").textContent = record.wins;
  $("rec-losses").textContent = record.losses;
  $("rec-draws").textContent = record.draws;
  $("rec-total").textContent = record.played
    ? `${record.played} game${record.played === 1 ? "" : "s"} played.`
    : "No games yet. Start one and send the link.";
  $("name-input").value = name;
  renderGameList($("dialog-games"), recent ?? []);
  $("profile-dialog").showModal();
}

/* ── Lobby ───────────────────────────────────────────────────────────────── */

function showLobby() {
  disconnect();
  gameId = null;
  snapshot = null;
  $("view-game").hidden = true;
  $("view-lobby").hidden = false;
  $("nav-play").classList.add("is-active");
  if (!$("lobby-board").childElementCount) renderStaticBoard($("lobby-board"), START_FEN);
  const games = profile?.recent ?? [];
  $("lobby-history").hidden = games.length === 0;
  if (games.length) renderGameList($("lobby-games"), games);
}

$("time-controls").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  for (const other of $("time-controls").querySelectorAll(".chip")) {
    other.classList.toggle("is-selected", other === chip);
    other.setAttribute("aria-checked", String(other === chip));
  }
});

$("create-btn").addEventListener("click", async () => {
  const button = $("create-btn");
  const chip = $("time-controls").querySelector(".is-selected");
  button.disabled = true;
  button.textContent = "Creating…";
  try {
    const response = await api("api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        minutes: Number(chip?.dataset.minutes ?? 10),
        increment: Number(chip?.dataset.increment ?? 5),
      }),
    });
    if (!response.ok) throw new Error(String(response.status));
    const { id } = await response.json();
    navigate(`?game=${id}`);
  } catch {
    toast("Could not create the match. Try again.");
  } finally {
    button.disabled = false;
    button.textContent = "Create match";
  }
});

/* ── The live game ───────────────────────────────────────────────────────── */

function showGame(id) {
  $("view-lobby").hidden = true;
  $("view-game").hidden = false;
  $("nav-play").classList.remove("is-active");
  if (id === gameId && socket) return;
  disconnect();
  gameId = id;
  snapshot = null;
  attempts = 0;
  setStatus("Connecting…", "");
  connect();
}

function connect() {
  if (!gameId) return;
  const url = new URL(`ws?${new URLSearchParams({ game: gameId })}`, BASE);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    return scheduleReconnect();
  }
  socket = ws;

  ws.addEventListener("open", () => {
    attempts = 0;
  });
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.t === "state") applySnapshot(message);
    else if (message.t === "error") {
      releaseMoveLock();
      toast(message.message);
    }
  });
  ws.addEventListener("close", () => {
    // A socket we deliberately replaced is no longer `socket`; only the live
    // one is allowed to trigger a reconnect.
    if (socket !== ws) return;
    socket = null;
    scheduleReconnect();
  });
  ws.addEventListener("error", () => ws.close());
}

// Every close leads to a reconnect: the local runtime restarts on every file
// save, and a hosted socket is closed after 24 hours by design.
function scheduleReconnect() {
  if (!gameId || $("view-game").hidden) return;
  const delay = Math.min(8000, 400 * 2 ** attempts++) + Math.random() * 250;
  setStatus("Reconnecting…", "");
  setTimeout(() => {
    if (gameId && !socket) connect();
  }, delay);
}

function disconnect() {
  const ws = socket;
  socket = null;
  gameId = null;
  clearInterval(clockTimer);
  clockTimer = null;
  if (ws) ws.close();
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  else toast("Not connected. Hold on.");
}

function handleMove(from, to, needsPromotion) {
  if (!needsPromotion) return sendMove(from, to, null);
  promoChoice = { from, to, ply: snapshot.ply };
  board.lock(true);
  const row = $("promo-row");
  row.replaceChildren();
  for (const piece of board.promotionPieces(snapshot.turn)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "promo-btn";
    button.dataset.kind = piece.toLowerCase();
    button.append(pieceElement(piece));
    row.append(button);
  }
  $("promotion-dialog").showModal();
}

$("promo-row").addEventListener("click", (event) => {
  const button = event.target.closest(".promo-btn");
  if (!button || !promoChoice) return;
  const { from, to } = promoChoice;
  closePromotion();
  sendMove(from, to, button.dataset.kind);
});

function closePromotion() {
  promoChoice = null;
  if ($("promotion-dialog").open) $("promotion-dialog").close();
}

function sendMove(from, to, promo) {
  send({ t: "move", from, to, promo, ply: snapshot.ply });
  // Freeze input until the server answers, so a second click cannot race a
  // move that is already on the wire.
  pending = { from, to };
  board.lock(true);
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(releaseMoveLock, 5000);
}

function releaseMoveLock() {
  clearTimeout(pendingTimer);
  pending = null;
  board.lock(false);
}

function applySnapshot(next) {
  const previous = snapshot;
  snapshot = next;
  snapshotAt = Date.now();

  // A promotion picker left open across an opponent's move would apply a
  // choice to a move that no longer exists.
  if (promoChoice && promoChoice.ply !== next.ply) closePromotion();

  releaseMoveLock();
  board.render(next, next.you.seat);
  renderPanel(next, previous);
  startClockTicker();
}

/* ── Side panel ──────────────────────────────────────────────────────────── */

function renderPanel(snap, previous) {
  const you = snap.you.seat;
  const bottom = you === "black" ? "black" : "white";
  const top = bottom === "white" ? "black" : "white";

  paintSeat($("seat-top"), snap, top);
  paintSeat($("seat-bottom"), snap, bottom);
  paintCaptured($("captured-top"), snap.captured[top] ?? [], snap.captured[bottom] ?? []);
  paintCaptured($("captured-bottom"), snap.captured[bottom] ?? [], snap.captured[top] ?? []);

  paintStatus(snap);
  paintMoves(snap);
  paintShare(snap);
  paintActions(snap);

  $("board-veil").hidden = snap.status !== "waiting";

  if (previous && snap.status === "over" && previous.status !== "over") {
    void loadProfile();
  }
}

// Captures are grouped by kind, cheapest first, and the side ahead on material
// gets the difference: "+2".
const CAPTURE_ORDER = ["p", "n", "b", "r", "q"];

function paintCaptured(el, taken, lost) {
  const worth = (list) => list.reduce((sum, piece) => sum + VALUE[piece.toLowerCase()], 0);
  el.replaceChildren();
  for (const kind of CAPTURE_ORDER) {
    const group = taken.filter((piece) => piece.toLowerCase() === kind);
    if (!group.length) continue;
    const span = document.createElement("span");
    span.className = "capture-group";
    for (const piece of group) span.append(pieceElement(piece));
    el.append(span);
  }
  const lead = worth(taken) - worth(lost);
  if (lead > 0) {
    const score = document.createElement("span");
    score.className = "material";
    score.textContent = `+${lead}`;
    el.append(score);
  }
}

function paintSeat(el, snap, seat) {
  const player = snap[seat];
  el.dataset.color = seat;
  el.querySelector(".dot").dataset.connected = String(!!player.connected);
  el.querySelector(".seat-name").textContent =
    player.name || (seat === "white" ? "Waiting…" : "Waiting for an opponent…");
  const avatar = el.querySelector(".seat-avatar");
  avatar.textContent = player.name ? initials(player.name) : "?";
  avatar.classList.toggle("is-empty", !player.name);
  el.classList.toggle("is-turn", snap.status === "active" && snap.turn === seat);

  const clockEl = el.querySelector(".clock");
  if (!snap.clock) {
    clockEl.hidden = true;
    return;
  }
  clockEl.hidden = false;
  const ms = remainingFor(seat);
  clockEl.textContent = formatClock(ms);
  clockEl.classList.toggle("low", ms !== null && ms < 30_000);
}

function remainingFor(seat) {
  if (!snapshot?.clock) return null;
  const base = seat === "white" ? snapshot.clock.whiteMs : snapshot.clock.blackMs;
  if (snapshot.clock.running !== seat) return base;
  return Math.max(0, base - (Date.now() - snapshotAt));
}

// The clock is drawn from the last snapshot's numbers plus the time since it
// arrived. Nothing counts down on the server between moves, and no clock
// messages travel.
function startClockTicker() {
  clearInterval(clockTimer);
  clockTimer = null;
  if (!snapshot?.clock || snapshot.status !== "active" || !snapshot.clock.running) return;
  clockTimer = setInterval(() => {
    if (!snapshot) return;
    const you = snapshot.you.seat;
    const bottom = you === "black" ? "black" : "white";
    paintSeat($("seat-top"), snapshot, bottom === "white" ? "black" : "white");
    paintSeat($("seat-bottom"), snapshot, bottom);
  }, 150);
}

function setStatus(line, sub) {
  $("status-line").textContent = line;
  $("status-sub").textContent = sub ?? "";
}

const SIDE_NAME = { white: "White", black: "Black" };

function paintStatus(snap) {
  const you = snap.you.seat;
  const playing = you !== "spectator";
  const solo = you === "both";
  $("status").classList.toggle("is-over", snap.status === "over");

  if (snap.status === "waiting") {
    return setStatus("Waiting for an opponent", "Send them the link below.");
  }

  if (snap.status === "over") {
    const reason = REASON_TEXT[snap.reason] ?? snap.reason ?? "";
    if (snap.result === "draw") return setStatus("Draw", reason);
    if (solo) return setStatus(`${SIDE_NAME[snap.result]} won`, reason);
    const winnerName = snap[snap.result].name || snap.result;
    if (!playing) return setStatus(`${winnerName} won`, reason);
    return setStatus(snap.result === you ? "You won" : "You lost", reason);
  }

  const turnName = snap[snap.turn].name || snap.turn;
  const check = snap.check === snap.turn;
  if (solo) {
    const side = SIDE_NAME[snap.turn];
    return setStatus(`${side} to move`, check ? `${side} is in check.` : "You are playing both sides.");
  }
  if (!playing) {
    return setStatus(`${turnName} to move`, check ? `${turnName} is in check.` : "Spectating.");
  }
  if (snap.turn === you) {
    return setStatus("Your move", check ? "You are in check." : "");
  }
  return setStatus(`${turnName} is thinking`, check ? `${turnName} is in check.` : "");
}

function paintMoves(snap) {
  const list = $("moves");
  list.replaceChildren();
  if (!snap.history.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No moves yet.";
    list.append(li);
    return;
  }
  // One row per full move: number, white's move, black's move.
  let row = null;
  snap.history.forEach((entry, index) => {
    if (index % 2 === 0) {
      row = document.createElement("li");
      const no = document.createElement("span");
      no.className = "no";
      no.textContent = `${index / 2 + 1}.`;
      row.append(no);
      list.append(row);
    }
    const san = document.createElement("span");
    san.className = "san";
    san.textContent = entry.san;
    if (index === snap.history.length - 1) san.classList.add("latest");
    row.append(san);
  });
  list.parentElement.scrollTop = list.parentElement.scrollHeight;
}

function paintShare(snap) {
  const share = $("share");
  share.hidden = snap.status !== "waiting";
  if (share.hidden) return;
  $("share-input").value = location.href;
  // Taking both seats is genuinely useful (play both sides, or try it out
  // alone) and it is what makes a single-persona local test work. Such a game
  // is never written to anyone's record.
  $("second-seat-btn").hidden = !(snap.you.seat === "white" && !snap.black.seated);
}

$("copy-btn").addEventListener("click", async () => {
  const input = $("share-input");
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand?.("copy");
  }
  toast("Link copied.");
});

$("second-seat-btn").addEventListener("click", () => send({ t: "play-both" }));

function paintActions(snap) {
  const playing = snap.you.seat !== "spectator";
  const solo = snap.you.seat === "both";
  const active = snap.status === "active";
  const offeredByYou = snap.drawOffer === snap.you.seat;

  const drawBtn = $("draw-btn");
  drawBtn.hidden = !playing || solo || snap.status === "over";
  drawBtn.disabled = !active || offeredByYou;
  drawBtn.querySelector(".label").textContent = offeredByYou ? "Draw offered" : "Offer draw";

  const resignBtn = $("resign-btn");
  resignBtn.hidden = !playing || snap.status === "over";
  resignBtn.disabled = !active;
  if (!active) disarmResign();

  const rematchBtn = $("rematch-btn");
  const asked = snap.rematch.includes(snap.you.seat);
  rematchBtn.hidden = !playing || snap.status !== "over";
  rematchBtn.disabled = asked;
  rematchBtn.textContent = asked ? "Waiting for opponent…" : "Rematch";

  const offer = $("offer");
  const incoming = snap.drawOffer && snap.drawOffer !== snap.you.seat && playing && !solo && active;
  offer.hidden = !incoming;
  if (incoming) {
    $("offer-text").textContent = `${snap[snap.drawOffer].name || "Your opponent"} offers a draw.`;
  }

  const wantsRematch = snap.rematch.length === 1 && !asked && playing && !solo && snap.status === "over";
  if (wantsRematch) $("status-sub").textContent = "Your opponent wants a rematch.";
}

// Resigning takes two clicks on the same button, a few seconds apart at most,
// instead of a native confirm() that would freeze the clocks' repaint.
function disarmResign() {
  clearTimeout(resignArmed);
  resignArmed = null;
  $("resign-btn").classList.remove("is-armed");
  $("resign-btn").querySelector(".label").textContent = "Resign";
}

$("resign-btn").addEventListener("click", () => {
  if (resignArmed) {
    disarmResign();
    send({ t: "resign" });
    return;
  }
  $("resign-btn").classList.add("is-armed");
  $("resign-btn").querySelector(".label").textContent = "Confirm resign";
  resignArmed = setTimeout(disarmResign, 3500);
});
$("draw-btn").addEventListener("click", () => send({ t: "draw-offer" }));
$("accept-draw").addEventListener("click", () => send({ t: "draw-accept" }));
$("decline-draw").addEventListener("click", () => send({ t: "draw-decline" }));
$("rematch-btn").addEventListener("click", () => send({ t: "rematch" }));

/* ── Dialog wiring ───────────────────────────────────────────────────────── */

for (const id of ["profile-btn", "nav-profile"]) {
  $(id).addEventListener("click", async () => {
    await loadProfile();
    openProfile();
  });
}

$("name-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("name-input").value.trim();
  if (!name) return;
  try {
    const response = await api("api/me", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: name }),
    });
    if (!response.ok) throw new Error(String(response.status));
    await loadProfile();
    $("dialog-name").textContent = profile.display_name;
    $("dialog-avatar").textContent = initials(profile.display_name);
    toast("Name saved.");
  } catch {
    toast("Could not save that name.");
  }
});

$("promotion-dialog").addEventListener("close", () => {
  promoChoice = null;
  // Dismissed without choosing, but if a move already went out, the lock
  // belongs to that move and is released by its snapshot.
  if (!pending) releaseMoveLock();
});

/* ── Boot ────────────────────────────────────────────────────────────────── */

// The match is a query parameter, so it survives a sign-in round trip, which
// only ever returns a path and its query. Links from before used the hash.
function route() {
  const legacy = location.hash.match(/^#\/g\/([a-z0-9]+)$/i);
  if (legacy) history.replaceState(null, "", new URL(`?game=${legacy[1]}`, BASE));
  const id = new URLSearchParams(location.search).get("game");
  if (id && /^[a-z0-9]+$/i.test(id)) showGame(id);
  else showLobby();
  paintAccount();
}

function navigate(url) {
  history.pushState(null, "", new URL(url, BASE));
  route();
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-route]");
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  navigate(link.getAttribute("href"));
});

window.addEventListener("popstate", route);

await loadProfile();
route();
