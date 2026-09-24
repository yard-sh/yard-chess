// Piece artwork, drawn for this project on a 45×45 grid. Both colours use the
// same silhouettes; only the fill, outline and detail colours change, and those
// come from CSS (`.piece.w` / `.piece.b`), so a theme never touches this file.
//
// Shapes are listed bottom-up: a later shape covers the outline of an earlier
// one where they overlap, which is what draws the joins between parts.

const BASE = '<rect x="10.5" y="32" width="24" height="5.5" rx="2"/>';

const ART = {
  p: `
    <path d="M17 34c0-6 2.5-10 4-13h3c1.5 3 4 7 4 13z"/>
    <rect x="12" y="32.5" width="21" height="5" rx="2"/>
    <rect x="17.5" y="19" width="10" height="3" rx="1.5"/>
    <circle cx="22.5" cy="14.5" r="5"/>`,
  r: `
    <path d="M15.5 16.5h14l1 15h-16z"/>
    ${BASE}
    <rect x="13" y="28.5" width="19" height="4" rx="1.2"/>
    <path d="M12.5 8.5h4.5V12h3V8.5h5V12h3V8.5h4.5v8h-20z"/>`,
  n: `
    <path d="M15 32.5c.5-4.5 3-7.5 5.5-10l-7 2c-2.5.5-4.5-1-4-3.5.5-2.5 3.5-5.5 6.5-8.5L17 7.5l3 3c7 0 12 4.5 12 13.5l-.5 8.5z"/>
    ${BASE}
    <path class="detail" d="M22.5 12c4.5 1.5 7 5.5 7 11.5"/>
    <circle class="eye" cx="17.5" cy="14.5" r="1.3"/>`,
  b: `
    <path d="M18 25.5c0 2.5-1 4.5-2.5 6.5h14c-1.5-2-2.5-4-2.5-6.5z"/>
    ${BASE}
    <path d="M22.5 9c-5.5 3.5-7.5 8.5-5.5 13 2 2 9 2 11 0 2-4.5 0-9.5-5.5-13z"/>
    <path class="detail" d="M24.8 13l-4 5"/>
    <rect x="16.5" y="22.5" width="12" height="3.2" rx="1.6"/>
    <circle cx="22.5" cy="7" r="2.2"/>`,
  q: `
    <path d="M12 15l4.5 6.5 1-10.5 3 8.5 2-10.5 2 10.5 3-8.5 1 10.5L33 15l-3.5 13h-14z"/>
    ${BASE}
    <rect x="14" y="27" width="17" height="4.5" rx="1.5"/>
    <circle cx="12" cy="14" r="2"/>
    <circle cx="17.5" cy="10" r="2"/>
    <circle cx="22.5" cy="8" r="2"/>
    <circle cx="27.5" cy="10" r="2"/>
    <circle cx="33" cy="14" r="2"/>`,
  k: `
    <path d="M15 28.5c-4-3.5-5.5-8.5-2-11 3-2 7-1 9.5 2 2.5-3 6.5-4 9.5-2 3.5 2.5 2 7.5-2 11z"/>
    ${BASE}
    <rect x="14" y="27" width="17" height="4.5" rx="1.5"/>
    <path d="M22.5 12.5c-2.5 0-3 3-0 7.5 3-4.5 2.5-7.5 0-7.5z"/>
    <path d="M21.2 4.5h2.6v3h3v2.6h-3v3h-2.6v-3h-3V7.5h3z"/>`,
};

export const isWhite = (piece) => piece === piece.toUpperCase();
export const side = (piece) => (isWhite(piece) ? "w" : "b");

const NAME = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
export const describe = (piece) => `${isWhite(piece) ? "white" : "black"} ${NAME[piece.toLowerCase()]}`;

export const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export function pieceSvg(piece) {
  return `<svg viewBox="0 0 45 45" aria-hidden="true">${ART[piece.toLowerCase()]}</svg>`;
}

// "rnbqkbnr/pppppppp/8/…" -> { a8: "r", b8: "n", … }
export function piecesFromFen(fen) {
  const rows = String(fen).split(" ")[0].split("/");
  const map = {};
  rows.forEach((row, index) => {
    const rank = 8 - index;
    let file = 0;
    for (const ch of row) {
      if (ch >= "1" && ch <= "8") file += Number(ch);
      else map[String.fromCharCode(97 + file++) + rank] = ch;
    }
  });
  return map;
}

export function pieceElement(piece) {
  const el = document.createElement("span");
  el.className = `piece ${side(piece)}`;
  el.innerHTML = pieceSvg(piece);
  el.dataset.piece = piece;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", describe(piece));
  return el;
}
