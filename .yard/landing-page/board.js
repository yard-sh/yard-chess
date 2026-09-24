// Draws the static boards on the landing page. The piece artwork is a copy of
// play/pieces.js: the app sits behind sign-in, so this page cannot load from it.

const BASE = '<rect x="10.5" y="32" width="24" height="5.5" rx="2"/>';

const ART = {
  p: `<path d="M17 34c0-6 2.5-10 4-13h3c1.5 3 4 7 4 13z"/><rect x="12" y="32.5" width="21" height="5" rx="2"/><rect x="17.5" y="19" width="10" height="3" rx="1.5"/><circle cx="22.5" cy="14.5" r="5"/>`,
  r: `<path d="M15.5 16.5h14l1 15h-16z"/>${BASE}<rect x="13" y="28.5" width="19" height="4" rx="1.2"/><path d="M12.5 8.5h4.5V12h3V8.5h5V12h3V8.5h4.5v8h-20z"/>`,
  n: `<path d="M15 32.5c.5-4.5 3-7.5 5.5-10l-7 2c-2.5.5-4.5-1-4-3.5.5-2.5 3.5-5.5 6.5-8.5L17 7.5l3 3c7 0 12 4.5 12 13.5l-.5 8.5z"/>${BASE}<path class="detail" d="M22.5 12c4.5 1.5 7 5.5 7 11.5"/><circle class="eye" cx="17.5" cy="14.5" r="1.3"/>`,
  b: `<path d="M18 25.5c0 2.5-1 4.5-2.5 6.5h14c-1.5-2-2.5-4-2.5-6.5z"/>${BASE}<path d="M22.5 9c-5.5 3.5-7.5 8.5-5.5 13 2 2 9 2 11 0 2-4.5 0-9.5-5.5-13z"/><path class="detail" d="M24.8 13l-4 5"/><rect x="16.5" y="22.5" width="12" height="3.2" rx="1.6"/><circle cx="22.5" cy="7" r="2.2"/>`,
  q: `<path d="M12 15l4.5 6.5 1-10.5 3 8.5 2-10.5 2 10.5 3-8.5 1 10.5L33 15l-3.5 13h-14z"/>${BASE}<rect x="14" y="27" width="17" height="4.5" rx="1.5"/><circle cx="12" cy="14" r="2"/><circle cx="17.5" cy="10" r="2"/><circle cx="22.5" cy="8" r="2"/><circle cx="27.5" cy="10" r="2"/><circle cx="33" cy="14" r="2"/>`,
  k: `<path d="M15 28.5c-4-3.5-5.5-8.5-2-11 3-2 7-1 9.5 2 2.5-3 6.5-4 9.5-2 3.5 2.5 2 7.5-2 11z"/>${BASE}<rect x="14" y="27" width="17" height="4.5" rx="1.5"/><path d="M22.5 12.5c-2.5 0-3 3 0 7.5 3-4.5 2.5-7.5 0-7.5z"/><path d="M21.2 4.5h2.6v3h3v2.6h-3v3h-2.6v-3h-3V7.5h3z"/>`,
};

const FILES = "abcdefgh";

function draw(root) {
  const placement = root.dataset.fen.split(" ")[0].split("/");
  const marks = (root.dataset.marks || "").split(" ").filter(Boolean);
  const coords = root.hasAttribute("data-coords");
  const html = [];

  placement.forEach((row, index) => {
    const rank = 8 - index;
    const cells = [];
    for (const ch of row) {
      if (ch >= "1" && ch <= "8") for (let i = 0; i < Number(ch); i++) cells.push(null);
      else cells.push(ch);
    }
    cells.forEach((piece, file) => {
      const name = FILES[file] + rank;
      const tone = (file + rank) % 2 === 0 ? "light" : "dark";
      let inner = "";
      if (piece) {
        const colour = piece === piece.toUpperCase() ? "w" : "b";
        inner += `<svg class="pc ${colour}" viewBox="0 0 45 45">${ART[piece.toLowerCase()]}</svg>`;
      }
      if (coords && rank === 1) inner += `<span class="cf">${FILES[file]}</span>`;
      if (coords && file === 0) inner += `<span class="cr">${rank}</span>`;
      html.push(`<div class="${tone}${marks.includes(name) ? " mark" : ""}">${inner}</div>`);
    });
  });

  root.innerHTML = html.join("");
}

document.querySelectorAll(".mini-board[data-fen]").forEach(draw);
