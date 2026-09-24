// Board rendering and input.
//
// This module knows *no* chess rules. Which squares a piece may move to comes
// entirely from `snapshot.legal`, which the server computes and pushes. The
// only rule-shaped thing here is noticing that a pawn reaching the last rank
// needs a promotion choice, which is a question about the destination square
// rather than about legality.

import { piecesFromFen, pieceElement, side } from "./pieces.js";

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = [8, 7, 6, 5, 4, 3, 2, 1];
const DRAG_THRESHOLD = 5;

export function createBoard(root, { onMove }) {
  const squares = new Map();
  let orientation = "white";
  let snapshot = null;
  let seat = "spectator";
  let selected = null;
  let locked = false;
  let rendered = new Map();
  let drag = null;

  for (const rank of RANKS) {
    for (const file of FILES) {
      const name = file + rank;
      const el = document.createElement("div");
      const dark = (FILES.indexOf(file) + rank) % 2 === 1;
      el.className = `sq ${dark ? "dark" : "light"}`;
      el.dataset.square = name;
      el.setAttribute("role", "gridcell");
      el.setAttribute("aria-label", name);
      squares.set(name, el);
    }
  }
  layout();

  root.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", cancelDrag);

  // ── rendering ────────────────────────────────────────────────────────────

  function layout() {
    const files = orientation === "black" ? [...FILES].reverse() : FILES;
    const ranks = orientation === "black" ? [...RANKS].reverse() : RANKS;
    const fragment = document.createDocumentFragment();

    ranks.forEach((rank, row) => {
      files.forEach((file, column) => {
        const el = squares.get(file + rank);
        el.querySelectorAll(".coord").forEach((node) => node.remove());
        if (row === 7) el.append(coord("coord-file", file));
        if (column === 0) el.append(coord("coord-rank", String(rank)));
        fragment.append(el);
      });
    });
    root.append(fragment);
  }

  function coord(className, text) {
    const span = document.createElement("span");
    span.className = `coord ${className}`;
    span.textContent = text;
    return span;
  }

  function render(next, mySeat) {
    snapshot = next;
    const wanted = mySeat === "black" ? "black" : "white";
    if (wanted !== orientation) {
      orientation = wanted;
      layout();
    }
    seat = mySeat;
    if (selected && !movableFrom(selected)) selected = null;
    paint();
  }

  // Only touched squares are rewritten, so a presence-only update does not
  // recreate 32 elements and make the board flicker.
  function paint() {
    if (!snapshot) return;
    const pieces = piecesFromFen(snapshot.fen);
    const targets = selected ? (snapshot.legal?.[selected] ?? []) : [];
    const last = snapshot.lastMove;

    for (const [name, el] of squares) {
      const piece = pieces[name] ?? null;
      if (rendered.get(name) !== piece) {
        el.querySelector(".piece")?.remove();
        if (piece) el.append(pieceElement(piece));
        rendered.set(name, piece);
      }

      const isTarget = targets.includes(name);
      el.classList.toggle("selected", name === selected);
      el.classList.toggle("target", isTarget);
      el.classList.toggle("occupied", isTarget && piece !== null);
      el.classList.toggle("last", !!last && (last.from === name || last.to === name));
      el.classList.toggle(
        "check",
        !!snapshot.check && piece !== null && piece.toLowerCase() === "k" &&
          side(piece) === snapshot.check[0],
      );
    }
  }

  // ── input ────────────────────────────────────────────────────────────────

  function myTurn() {
    return (
      !locked &&
      snapshot &&
      snapshot.status === "active" &&
      (seat === "white" || seat === "black") &&
      snapshot.turn === seat
    );
  }

  function movableFrom(name) {
    return myTurn() && Array.isArray(snapshot.legal?.[name]) && snapshot.legal[name].length > 0;
  }

  function squareUnder(x, y) {
    const el = document.elementFromPoint(x, y)?.closest?.(".sq");
    return el?.dataset.square ?? null;
  }

  // A pawn arriving on the far rank always needs a piece chosen.
  function isPromotion(from, to) {
    const piece = piecesFromFen(snapshot.fen)[from];
    if (!piece || piece.toLowerCase() !== "p") return false;
    return to[1] === (side(piece) === "w" ? "8" : "1");
  }

  function attempt(from, to) {
    if (!from || !to || from === to) return false;
    if (!(snapshot.legal?.[from] ?? []).includes(to)) return false;
    selected = null;
    onMove(from, to, isPromotion(from, to));
    paint();
    return true;
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    const name = squareUnder(event.clientX, event.clientY);
    if (!name) return;

    // Completing a move onto a highlighted square always wins over re-selecting.
    if (selected && (snapshot.legal?.[selected] ?? []).includes(name)) {
      event.preventDefault();
      attempt(selected, name);
      return;
    }

    if (!movableFrom(name)) {
      if (selected) {
        selected = null;
        paint();
      }
      return;
    }

    event.preventDefault();
    selected = name;
    paint();

    const pieceEl = squares.get(name)?.querySelector(".piece");
    if (pieceEl) {
      drag = { from: name, pieceEl, startX: event.clientX, startY: event.clientY, ghost: null };
    }
  }

  function onPointerMove(event) {
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.ghost && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

    if (!drag.ghost) {
      const rect = drag.pieceEl.getBoundingClientRect();
      const ghost = drag.pieceEl.cloneNode(true);
      ghost.classList.add("drag-ghost");
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      document.body.append(ghost);
      drag.ghost = ghost;
      drag.pieceEl.classList.add("dragging");
    }
    drag.ghost.style.left = `${event.clientX}px`;
    drag.ghost.style.top = `${event.clientY}px`;
  }

  function onPointerUp(event) {
    if (!drag) return;
    const dragged = !!drag.ghost;
    const from = drag.from;
    cancelDrag();
    // Without a drag this was a click, and the selection stays put so the
    // player can click the destination next.
    if (!dragged) return;
    const to = squareUnder(event.clientX, event.clientY);
    if (!attempt(from, to)) paint();
  }

  function cancelDrag() {
    if (!drag) return;
    drag.ghost?.remove();
    drag.pieceEl?.classList.remove("dragging");
    drag = null;
  }

  return {
    render,
    lock(value) {
      locked = value;
      if (locked) {
        selected = null;
        cancelDrag();
        paint();
      }
    },
    // The four choices as FEN letters, in the colour of the side promoting.
    promotionPieces(colour) {
      return ["q", "r", "b", "n"].map((kind) => (colour === "white" ? kind.toUpperCase() : kind));
    },
  };
}

// A board that only shows a position: the lobby's preview. No input, no
// highlights, and none of the window listeners the live board installs.
export function renderStaticBoard(root, fen) {
  const pieces = piecesFromFen(fen);
  const fragment = document.createDocumentFragment();
  RANKS.forEach((rank, row) => {
    FILES.forEach((file, column) => {
      const el = document.createElement("div");
      const dark = (column + rank) % 2 === 1;
      el.className = `sq ${dark ? "dark" : "light"}`;
      const piece = pieces[file + rank];
      if (piece) el.append(pieceElement(piece));
      if (row === 7) {
        const span = document.createElement("span");
        span.className = "coord coord-file";
        span.textContent = file;
        el.append(span);
      }
      if (column === 0) {
        const span = document.createElement("span");
        span.className = "coord coord-rank";
        span.textContent = String(rank);
        el.append(span);
      }
      fragment.append(el);
    });
  });
  root.replaceChildren(fragment);
}
