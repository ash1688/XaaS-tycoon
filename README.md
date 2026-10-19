# XaaS Tycoon

An educational business sim for teaching IaaS, PaaS and SaaS to T Level students. The design notes are in [xaas-tycoon-design.md](xaas-tycoon-design.md), and the alpha PRD is issue #1.

## Layout

- `sim`: the simulation, a pure TypeScript module with no I/O. All balance numbers are in `sim/src/config.ts`.
- `server`: Fastify + Drizzle/Postgres. Runs the sim and stores every game, so students can't edit values in the browser.
- `web`: the Vue + Vite client.
- `e2e`: Playwright smoke tests.

## Running locally

You need Node 24 and Docker.

```bash
npm install
cp .env.example .env
npm run db:up
npm run dev
```

`npm run dev` starts the server on http://localhost:3080 and the web client on http://localhost:5180 (open this one). Postgres runs in Docker on host port 5433, so it doesn't clash with a local Postgres install.

To run the whole thing in Docker instead (app on http://localhost:3080):

```bash
docker compose up --build
```

Set `TEACHER_PASSWORD` and `SESSION_SECRET` in your environment first; the compose defaults are for local use only.

## Using it

1. Go to `/staff`, sign in with `TEACHER_PASSWORD`, and create a login code for each student.
2. Students enter their code on the home page, start a company and press **Continue** to play a day at a time.
3. The game ends after day 180, or sooner if the company goes bankrupt, and shows a summary: final cash, users and uptime, where the money went, migrations made and a cost-over-time chart. Reopening a finished game from the company list shows its summary again.

To try the end of a game without playing 180 days, set `GAME_FINAL_DAY` (for example `GAME_FINAL_DAY=10` in `.env`). The server reads it at startup; leave it unset for the real 180-day game. The e2e tests run with `GAME_FINAL_DAY=30`.

### Timed flow (off by default)

The alpha plays one day per **Continue** click. A timed flow is built in but switched off: set `TIMED_FLOW=on` and the game page gets a **Play/Pause** button that plays a day every `TIMED_FLOW_SECONDS` (default 15), with a countdown to the next day. It's a server setting, read at startup and passed to the page through `/api/meta`, so you can try it by restarting the server, without rebuilding the web client. Each timed day calls the same continue endpoint as the button, one request at a time. It pauses while the tab is hidden and carries on when the student comes back, and stops when the game ends or a day fails. Actions such as hiring or starting a migration still work while it plays.

## Tests

The server and e2e tests need the Docker database running (`npm run db:up`).

```bash
npm test            # sim unit tests and server API tests (real Postgres, database xaas_test)
npm run test:e2e    # Playwright smoke test (database xaas_e2e, servers on ports 3180 and 3184, the second with timed flow on)
npm run typecheck
```

The first time you run the e2e tests, install the browser with `npx playwright install chromium`.

## Database changes

Edit `server/src/db/schema.ts`, then generate a migration:

```bash
npm run db:generate -w server
```

Migrations in `server/drizzle` run automatically when the server starts.
