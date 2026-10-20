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
cp .env.example .env.local
npm run db:up
npm run dev
```

`npm run dev` starts the server on http://localhost:3080 and the web client on http://localhost:5180 (open this one). Postgres runs in Docker on host port 5433, so it doesn't clash with a local Postgres install.

To run the whole thing in Docker instead (app on http://localhost:3080):

```bash
docker compose up --build
```

Set `TEACHER_PASSWORD` and `SESSION_SECRET` in your environment first; the compose defaults are for local use only.

## Deploying with Dokploy

Production runs on a VPS through [Dokploy](https://dokploy.com), from `docker-compose.prod.yml`: the app and Postgres 18, with the database in a named volume so it survives redeploys. Postgres isn't published to the internet; only Dokploy's Traefik proxy reaches the app, and adds HTTPS.

The image is a multi-stage build: production dependencies only, running as the `node` user with `NODE_ENV=production`. The server still runs its TypeScript through tsx, as in development, rather than a compiled build. A `HEALTHCHECK` calls `/api/health`, which answers `{"ok":true}` when the server can reach the database. Migrations run when the server starts.

### Setting it up

1. **Create the project.** In Dokploy, create a project (for example *XaaS Tycoon*), then **Create Service → Compose**.
2. **Point it at the repo.** Choose GitHub (or Git) as the provider, pick `ash1688/XaaS-tycoon`, branch `main`, and set the compose path to `./docker-compose.prod.yml`. The compose type is *Docker Compose*.
3. **Set the environment.** In the service's **Environment** tab, add the variables below. Make each secret with `openssl rand -hex 32`, and keep them in a password manager, not in the repo.
4. **Attach the domain.** In **Domains**, add your domain (for example `xaas.example.co.uk`) for service `app`, container port `3080`, with HTTPS on and Let's Encrypt as the certificate. Point the domain's DNS A record at the VPS first, or the certificate can't be issued.
5. **Deploy.** Press **Deploy** and watch the log. A missing secret stops it early with `required variable ... is missing a value`. When the app container shows as healthy, run the checks below.
6. **Redeploy.** Press **Deploy** again after merging to `main`, or turn on auto-deploy in the service's settings. Redeploying rebuilds the app and keeps the `pgdata` volume, so games and codes stay.

| Variable | Required | What it does |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | Yes | The database password. The compose file builds `DATABASE_URL` from it, so use letters and digits only (`openssl rand -hex 32`). Keep it once set: Postgres only reads it when the volume is first created. |
| `TEACHER_PASSWORD` | Yes | The password for `/staff`. Share it only with teaching staff. |
| `SESSION_SECRET` | Yes | Signs the teacher's sign-in cookie; at least 32 characters. Changing it signs every teacher out. |
| `TRUST_PROXY` | No | The proxy addresses to trust for the client's IP and HTTPS. Defaults to `uniquelocal` (the private ranges Traefik connects from), which marks the teacher cookie `Secure` over HTTPS and lets the rate limits tell clients apart. Don't publish the app's port while this is on. |
| `RATE_LIMIT_CODE_FAILURES` | No | Failed student code lookups allowed per client IP in the window before it gets a 429. Default 100. A whole class behind the college's network usually shares one public IP, so keep this generous; only failures count, so normal play never uses it up. |
| `RATE_LIMIT_LOGIN_FAILURES` | No | Wrong teacher passwords allowed per client IP in the window. Default 10. |
| `RATE_LIMIT_WINDOW_MINUTES` | No | The rate limit window. Default 15. A blocked IP gets back in when it ends. |
| `GAME_FINAL_DAY` | No | Ends games after this many days instead of 180. Leave unset in production. |
| `TIMED_FLOW` | No | `on` gives the game page Play/Pause. Off unless set. |
| `TIMED_FLOW_SECONDS` | No | Seconds per day with timed flow on. Default 15. |

`DATABASE_URL` and `PORT` are set by the compose file. The server checks `DATABASE_URL`, `TEACHER_PASSWORD` and `SESSION_SECRET` before connecting to anything, and exits with a message naming the one that's missing.

### Backing up the database

Dokploy's database backups only cover databases it created itself, so back up this one with `pg_dump` on the VPS. Find the container with `docker ps --filter name=db`, then:

```bash
docker exec <db-container> pg_dump -U xaas -Fc xaas > xaas-$(date +%F).dump
```

Run it from cron (or a Dokploy schedule) daily, and copy the files off the VPS. To restore into a running deployment:

```bash
docker exec -i <db-container> pg_restore -U xaas -d xaas --clean --if-exists < xaas-2026-10-20.dump
```

The data itself is in the Docker volume named `<compose project>_pgdata` (`docker volume ls`). Don't delete it, and don't remove the service with its volumes, unless you mean to lose every game.

### Checking a deployment

From a college machine, on the college network:

1. `https://<your domain>/api/health` shows `{"ok":true}`, with a padlock and no certificate warning.
2. `https://<your domain>/staff`: a wrong password is refused, and `TEACHER_PASSWORD` signs in.
3. Create a login code.
4. In a private window, enter that code on the home page, start a company and press **Continue** a few times.
5. Back on `/staff`, the dashboard shows that company.
6. Redeploy in Dokploy, then reload: the code and company are still there.
7. If something's blocked on the college network, check the college's web filter allows the domain.

## Using it

1. Go to `/staff`, sign in with `TEACHER_PASSWORD`, and create a login code for each student.
2. Students enter their code on the home page, start a company and press **Continue** to play a day at a time.
3. The game ends after day 180, or sooner if the company goes bankrupt, and shows a summary: final cash, users and uptime, where the money went, migrations made and a cost-over-time chart. Reopening a finished game from the company list shows its summary again.

To try the end of a game without playing 180 days, set `GAME_FINAL_DAY` (for example `GAME_FINAL_DAY=10` in `.env.local`). The server reads it at startup; leave it unset for the real 180-day game. The e2e tests run with `GAME_FINAL_DAY=30`.

### Game config

The staff dashboard's **Game config** page (`/staff/config`) edits the game's numbers: starting cash, costs, growth, capacity, staff, migration and event days and effects. They're grouped, and each shows its default, what it does and the range it can take, with a reset per number and a **Reset all**. Saving changes what **games started from then on** use. Each company stores a snapshot of its full config when it starts, and every request about that game runs on that snapshot, so changing the config never alters a game already being played.

How it fits with the env settings:

- **`GAME_FINAL_DAY` sets the base.** The server's base config is the built-in defaults with `GAME_FINAL_DAY` applied. The config page shows that base as each number's default and stores only the numbers that differ from it, so the e2e tests (`GAME_FINAL_DAY=30`) still get 30-day games unless a test changes it. A game length saved on the page wins over `GAME_FINAL_DAY` for new games.
- **Timed flow stays env-only.** `TIMED_FLOW` and `TIMED_FLOW_SECONDS` are how the server runs, not game balance, so they're not on the page.

Adding a number to `GameConfig` (in `sim/src/config.ts`) means listing it in `configFields` in `sim/src/configSchema.ts`, with its group, explanation and range, or adding it to `CONFIG_EXCLUSIONS` with a reason. A test fails until it's one or the other.

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

## Old saved games

Saved games are stored with a game-state version, and only games from the current version load. Older ones aren't upgraded: opening, continuing or acting on one shows "This game is from an older version", and it's left out of the student's list of companies. The teacher's dashboard still lists it, so it can be deleted there.

Round two (from issue #41) bumped the version, so a local database from before then holds games that won't load. Clear them out by emptying the companies table:

```bash
docker compose exec db psql -U xaas -d xaas -c "truncate companies"
```

or start the database again from scratch, which also deletes login codes:

```bash
docker compose down -v
npm run db:up
```

## Database changes

Edit `server/src/db/schema.ts`, then generate a migration:

```bash
npm run db:generate -w server
```

Migrations in `server/drizzle` run automatically when the server starts.
