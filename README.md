# Chess

<p align="center">
<a href="https://dash.yard.sh/projects?action=create&repo=https%3A%2F%2Fgithub.com%2Fyard-sh%2Fyard-chess"><img src="https://yard.sh/create-in-yard.png" width="200"alt="Create in Yard" /></a>
</p>

Online chess hosted end to end on Yard: create a match, send the link, play.
Clocks with increment, resign, draw offers, rematch, and a win/loss/draw record
per player. A static frontend, a fetch-handler backend, one realtime object per
match, a per-project SQLite database, and buyer sign-in. There is no separate
server, no auth code, and no build step.

Use the link above, or paste this repository's URL into the Create from GitHub
URL field of the Yard dashboard's Create Project dialog. Chess declares objects
(realtime rooms inside a service), which are part of Yard Pro, so creating it
needs a Pro plan. The project itself is free to play: one $0 tier, so signing in
is the only gate.

## Layout

    .yard/
      settings.json       every project setting: service, objects, landing page, pricing
      migrations/         applied in filename order at deploy, and by yard dev
      landing-page/       the marketing page
      dev/                local state written by yard dev; ignored by git
    play/                 the deployable bundle (the services[] entry with dir: play)
      _service.js         the entire backend: chess engine, fetch handler, Game object
      index.html          app shell
      app.js              routing, the socket, the side panel, the dialogs
      board.js            the board: rendering, drag or click to move
      pieces.js           piece glyphs
      styles.css          design tokens, light + dark

The service entry declares its mount path, access mode, database access, and the
object class it exports:

    "services": [
      { "dir": "play", "name": "play", "url": "/play",
        "access": "authenticated", "database_access": true,
        "objects": [{ "class": "Game", "binding": "GAMES" }] }
    ]

`yard push` sends that file along with the bundles, so changing how the service
deploys is an edit there followed by a push.

## How it fits together

**The server is the only chess engine.** `_service.js` generates the legal moves
and pushes the side to move a map of them (`{"e2": ["e3","e4"], ...}`). The
frontend knows no rules at all: it highlights what it is given and sends
`from`/`to` back. That is what keeps the project buildless, because there is no
engine to share between two runtimes when there is only one.

**One match is one object.** `_service.js` exports a class called `Game`. Yard
keeps one instance of it per match id, reachable through `env.GAMES`, and every
connection to that match lands on the same instance, so it is the single place
where moves are ordered and validated. The handler forwards the upgrade by id
and nothing else:

    return env.GAMES.get(env.GAMES.idFromName(id)).fetch(request);

**All of a match's state is in `ctx.storage`.** The object hibernates whenever it
is idle and wakes with a fresh constructor, so instance fields do not survive
between events and `this.board = ...` would be a bug. The position travels and is
stored as FEN, which keeps that storage tiny. The clock is enforced with
`ctx.storage.setAlarm`, not a timer, which is why a flag falls even when both
players have closed their laptops.

**The record is derived, never counted.** A finished game inserts one row into
`games` with `ON CONFLICT(id) DO NOTHING`, and a player's record is a `SELECT`
over that table. Nothing increments a counter, so no reconnect, retried alarm or
double resign can make the record drift. If the write fails, `recorded` stays
false and an alarm retries it. Structure that outlives a match (players, display
names, finished games) is in `env.DB`; the live position, clocks and sockets stay
in the object.

**Seats, and playing yourself.** The first two people to open a match link take
white and black; anyone after that watches. Reconnecting returns you to your own
seat. `?seat=` lets one person deliberately hold both, which is what the "Or take
the other seat yourself" button on the waiting screen uses. A game where both
seats are the same user is not a real result and is never written to anyone's
record.

Two details worth knowing before editing:

- **Relative URLs only.** The app is mounted at `/yard-chess/play/`, and one
  segment deeper again inside a sandbox, so every request is built from the
  page's own URL, never from a leading slash. Match selection lives in
  `location.hash` for the same reason. `yard service check` lints fetches and
  links, not socket URLs.
- **The class name is the identity.** Renaming `Game` in `settings.json` drops
  every match in progress at the next deploy; `yard push` warns before it does.
  Finished games are rows in the database and survive. Change the `binding` if
  only the name in `env` should change.

## Local development

    yard dev

serves the landing page at `http://localhost:9875/yard-chess/` and the app at
`http://localhost:9875/yard-chess/play/`, with the migration applied to a local
database and each match's object stored under `.yard/dev/objects/play/`. Use
`yard dev --port 4000` if 9875 is taken.

There is no sign-in code in this repo. Yard's edge signs people in and hands the
service trusted `X-Yard-*` headers; locally a **persona** stands in for a real
account:

| Persona     | Who they are           |
| ----------- | ---------------------- |
| `signed-in` | a signed-in visitor    |
| `trial`     | someone on a trial     |
| `user:base` | someone on the Base tier |
| `member`    | you, the project owner |

Pick one up front with `yard dev --as signed-in`, or switch at
`http://localhost:9875/yard-chess/play/__yard/auth/login`.

A persona is a cookie, so it is per browser profile: two tabs in the same window
are the same player. To get two players onto one board, either open the match
link in a normal window and again in a private window and pick a different
persona in the second, or create a match and click "Or take the other seat
yourself" to hold both seats at once.

Every save restarts the local runtime, which drops every open socket; the client
reconnects on its own, which is the same path it takes when a hosted session
reaches its 24-hour limit. `yard dev --reset-db` starts from an empty database
and `--reset-objects` deletes every stored match, and the two are independent: a
game row without its object is just a finished result with no live board.

## Shipping

    yard service check                        validate bundle + lint, no network
    yard status                               what a push would change
    yard push                                 upload service, page, and settings into the draft
    yard releases publish <tag>               publish the draft, which makes it live
    yard service open                         print/open the live app URL
    yard db query "select white_name, black_name, result from games"

Nothing serves a draft release, so pushing is safe to repeat as often as you
like; the app only changes for players at `yard releases publish`. Migrations
apply themselves at deploy; you never run them by hand.

A new project starts in the `draft` launch stage, where its hosted URL serves the
owning team only. To let people outside the team play, either advance the launch
stage to `published` in the dashboard, which is forward-only and irreversible, or
use a sandbox, which can be closed again:

    yard sandbox create preview
    yard sandbox pin                            hold the project on what it serves
    yard releases publish <tag>
    yard sandbox pin <tag> --sandbox preview
    yard sandbox visibility public --sandbox preview
    yard service open --sandbox preview         shareable preview URL
    yard sandbox unpin                          go live

Data never moves between the project and its sandboxes: a sandbox has its own
database and its own matches.

## Usage and cost

Objects are metered: requests, compute time while a message is being handled, and
stored bytes, with a monthly allowance on Pro and overage past it. An inbound
socket message counts as one twentieth of a request, and a match that is holding
sockets while both players think costs no compute. A hibernating match with an
armed clock alarm costs nothing until the alarm fires. The Usage page in the
dashboard shows the month so far.

Contracts: `/docs/v1/platform/services`, `/docs/v1/platform/services/objects`.
