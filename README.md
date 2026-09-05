# Yard Chess

Online chess on Yard. Create a match, send the link, play. Wins, losses and
draws are kept per player and shown in a profile dialog.

```
yard dev --port 4000
```

Then open <http://localhost:4000/yard-chess/>. (Port 9875, the default, is in
use on this machine.)

## Playing against someone locally

Sign-in is Yard's, and `yard dev` replaces it with **personas**. A persona is a
cookie, so it is per browser profile — two tabs in the same window are the same
player.

To get two players on one machine, either:

- **Two windows.** Open the match link in a normal window and again in a private
  window, then visit `…/play/__yard/auth/login` in the second one and pick a
  different persona (`signed-in`, `trial`, `customer:base`, `member`).
- **One window.** Create a match and click **"Or take the other seat yourself"**
  on the waiting screen. One person can hold both seats — useful for trying it
  out or playing both sides. Such a game is never written to anyone's record.

## How it fits together

| Piece | Where |
| --- | --- |
| Chess rules, HTTP routes, and the live match | `play/_service.js` |
| Board rendering and input | `play/board.js`, `play/pieces.js` |
| Routing, WebSocket, panel, dialogs | `play/app.js` |
| Players and finished games | `.yard/migrations/0001_init.sql` |
| Landing page | `.yard/landing-page/` |

Three decisions worth knowing before changing anything:

**The server is the only chess engine.** `_service.js` generates legal moves and
pushes the side-to-move a map of them (`{"e2": ["e3","e4"], …}`). The frontend
knows no rules at all — it highlights what it is given and sends `from`/`to`
back. That is what keeps the project buildless: there is no engine to share
between two runtimes, because there is only one.

**A match is one object, and all of its state is in `ctx.storage`.** The `Game`
class holds both WebSockets and hibernates between moves, so instance fields do
not survive — `this.board = …` would be a bug. The clock is enforced with
`ctx.storage.setAlarm`, not a timer, which is why a flag falls even when both
players have closed their laptops.

**The win/loss record is derived, never counted.** A finished game inserts one
row into `games` with `ON CONFLICT(id) DO NOTHING`; a player's record is a
`SELECT` over that table. Nothing increments a counter, so no reconnect, retried
alarm or double resign can make the record drift.

## Deploying

Nothing has been pushed. The project is a `draft`, so its hosted URL currently
serves the owning team only.

```sh
yard push                                   # into the draft release
yard releases publish v1.0.0                # go live on the Production channel
```

To let people outside the team play, either advance the launch stage to
`published` in the dashboard (**forward-only, and irreversible**) or use a
sandbox, which can be closed again:

```sh
yard sandbox create preview
yard sandbox pin v1.0.0 --sandbox preview
yard sandbox visibility public --sandbox preview
yard service open --sandbox preview
```
