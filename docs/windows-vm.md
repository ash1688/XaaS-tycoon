# Running XaaS Tycoon on a Windows VM (no Docker)

This runs the game with plain Node.js against a PostgreSQL server the VM already has. Docker isn't needed: it only
supplied Postgres in development. One Node process serves both the game and the staff dashboard.

## What you need

- **Node.js 24** (LTS) from <https://nodejs.org>. Check with `node -v`.
- **Git** to clone the repo, or download it as a zip from GitHub.
- **PostgreSQL 13 or newer**, already running on the VM or reachable from it. The database uses `gen_random_uuid()`, which is built in from version 13. Check with `psql --version`.
- Internet access for `npm install`.

## 1. Create the database

In `psql` as a Postgres admin (for example `psql -U postgres`), make a login and a database for the game. Use your own password:

```sql
CREATE ROLE xaas LOGIN PASSWORD 'choose-a-password';
CREATE DATABASE xaas OWNER xaas;
```

The server creates its tables itself the first time it starts, and updates them on later starts.

## 2. Get the code and install

In PowerShell, in a folder of your choice:

```powershell
git clone https://github.com/ash1688/XaaS-tycoon.git
cd XaaS-tycoon
npm install
```

## 3. Settings

Copy the example settings to a file named `.env` in the repo folder (git ignores it):

```powershell
Copy-Item .env.example .env
```

Then edit `.env`:

| Setting | What to put |
| --- | --- |
| `DATABASE_URL` | `postgres://xaas:choose-a-password@127.0.0.1:5432/xaas`. Use the VM's Postgres port (normally 5432) and `127.0.0.1` rather than `localhost`. If the password has symbols such as `@ : / # %`, write them percent-encoded (`@` is `%40`), or pick a password of letters and digits. |
| `TEACHER_PASSWORD` | The staff dashboard password. |
| `SESSION_SECRET` | At least 32 random characters. Make one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `PORT` | The port students connect to, for example `3080`. |

Leave `GAME_FINAL_DAY` unset (or delete the line) so games last the full 180 days. Every other setting in `.env.example` is optional; the deployment section of the README describes each one.

## 4. Start it

```powershell
npm run serve
```

This builds the web client and starts the server with the settings in `.env`. When it's ready it logs a `Server listening at http://...:3080` line for each of the VM's network addresses; the one with the VM's college IP is the address students use. Open `http://localhost:3080` on the VM to check. The staff dashboard is at `/staff`.

To start again later without rebuilding, for example after a reboot, use `npm run serve -w server`. Rebuild with `npm run serve` after pulling an update.

## 5. Let students in

Students browse to `http://<the VM's name or IP>:3080`. Find the VM's IP with `ipconfig`.

Windows Firewall blocks the port by default. In PowerShell **as administrator**:

```powershell
New-NetFirewallRule -DisplayName "XaaS Tycoon" -Direction Inbound -Protocol TCP -LocalPort 3080 -Action Allow
```

The college network may also need to allow it. If students can't connect but the VM can, ask IT to open the port on the network.

This runs over plain HTTP. The teacher's sign-in cookie still works, but it isn't marked `Secure`. That's fine on the college network; use the Dokploy deployment in the README for HTTPS on the internet.

## Keeping it running

The game runs while the PowerShell window stays open. To start it automatically when the VM boots, add a Task Scheduler task:

1. **Create Task**, name it *XaaS Tycoon*, and choose **Run whether user is logged on or not**.
2. **Triggers:** At startup.
3. **Actions:** start the program `npm.cmd` with the arguments `run serve -w server`, starting in the repo folder (for example `C:\XaaS-tycoon`).
4. **Settings:** untick *Stop the task if it runs longer than*.

## Updating

```powershell
git pull
npm install
npm run serve
```

Database changes run automatically when the server starts.

## Backing up

With the PostgreSQL tools on the VM:

```powershell
pg_dump -U xaas -Fc xaas -f "xaas-$(Get-Date -Format yyyy-MM-dd).dump"
```

Restore with `pg_restore -U xaas -d xaas --clean --if-exists <file>.dump`.

## Troubleshooting

- **`Missing environment variable ...`**: the `.env` file is missing, isn't in the repo folder, or that line is empty.
- **`password authentication failed` or `ECONNREFUSED`**: check `DATABASE_URL`: the user, password, port and database name, and that the Postgres service is running (`Get-Service postgresql*`).
- **`EADDRINUSE`**: something else uses the port. Pick another `PORT`, or find it with `Get-NetTCPConnection -LocalPort 3080`.
- **Slow pages with `localhost` in `DATABASE_URL`**: use `127.0.0.1`. On some Windows machines `localhost` goes over IPv6 and adds a delay to every request.
