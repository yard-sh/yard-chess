// The filled Unicode chess glyphs are used for BOTH colours, and the two sides
// are told apart by fill and outline instead. Using the outline glyphs (♔♕♖)
// for white is what makes most quick chess UIs look weak: the two sides end up
// with visibly different stroke weights. One glyph set, two fills, identical
// silhouettes.
const GLYPH = {
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟",
};

export const isWhite = (piece) => piece === piece.toUpperCase();
export const glyph = (piece) => GLYPH[piece.toLowerCase()];
export const side = (piece) => (isWhite(piece) ? "w" : "b");

const NAME = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
export const describe = (piece) => `${isWhite(piece) ? "white" : "black"} ${NAME[piece.toLowerCase()]}`;

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
  el.textContent = glyph(piece);
  el.dataset.piece = piece;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", describe(piece));
  return el;
}
