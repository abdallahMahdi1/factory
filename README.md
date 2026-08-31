# Factory Tracker

Replaces paper time-sheets on the shop floor with a real Start / Pause / Stop
system that records exact times, works with no internet, and syncs
automatically once the connection is back.

Three parts:

```
backend/       Central API + database (Node.js + Express + SQLite)
admin-web/     Office admin panel (React) — runs in any browser
operator-app/  Shop-floor desktop app (Electron) — one install per machine PC
```

## How it fits together

- **backend** is the single source of truth. It exposes an admin API (JWT
  login) and a device API (each machine authenticates with its own API key).
- **admin-web** is what your friend (or whoever manages the factory) uses
  from an office computer: set up machines, their Start-form questions,
  operators, master lists (materials/tools/work orders), pause/stop reasons,
  and browse + correct recorded sessions.
- **operator-app** is installed on the PC next to each machine. It caches
  everything it needs locally, so an operator can identify themselves, start
  a job, pause, resume, and stop — entirely offline if needed. Every action
  is queued locally and pushed to the backend the moment there's a
  connection, safely and without duplicates even if it retries.

## 1. Run the backend

```bash
cd backend
npm install
cp .env.example .env      # if not already present — see below
npm run seed               # creates an admin login + one example machine
npm run dev                 # starts the API on http://localhost:4000
```

`.env` should contain:
```
DATABASE_PATH=./data.db
JWT_SECRET=change-this-secret-in-production
PORT=4000
OFFLINE_ALERT_MINUTES=20
LONG_SESSION_ALERT_HOURS=14
```

The seed script prints an admin login (`admin` / `admin123` by default —
**change this password after first login**) and one example machine's API
key. Set `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` env vars before
seeding to choose your own.

For real deployment: run this on a small server or PC that stays on and is
reachable from every machine PC on the factory network, and switch
`JWT_SECRET` to a long random value.

## 2. Run the admin panel

```bash
cd admin-web
npm install
npm run dev        # http://localhost:5173, talks to the backend at :4000
```

For a real deployment, `npm run build` and serve the `dist/` folder from any
static web server (or just leave it running via `npm run preview`). Set
`VITE_API_BASE` if the backend isn't on `localhost:4000`.

Log in with the admin credentials from the seed step, then:
1. **Master lists** — enter your real materials, tools, and work orders.
2. **Machines** — add each machine, and for each one, configure its
   Start-form fields (which questions the operator answers, text or select).
3. **Operators** — add each operator with their ID number, and assign them
   to whichever machine(s) they're allowed to work on.
4. Each machine's page shows its **API key** — you'll need this for step 3.

## 3. Set up the operator app on each machine's PC

```bash
cd operator-app
npm install
cp config.example.json config.json
```

Edit `config.json`:
```json
{
  "apiBase": "http://YOUR-SERVER-ADDRESS:4000/api",
  "machineApiKey": "the API key from that machine's page in the admin panel"
}
```

Then either run it directly:
```bash
npm start
```

...or build an installer for that PC's OS:
```bash
npm run build
```
This produces an installer in `operator-app/dist` (`.exe` for Windows,
`.AppImage` for Linux, `.dmg` for Mac) using `electron-builder`. Install it
on the machine's PC, put `config.json` next to the installed app, and launch.

**Each machine's PC needs its own `config.json`** with that machine's own
API key — that's what tells the app which machine it is and which operators
are authorized on it.

## How the offline sync actually works

- Every click (Start/Pause/Resume/Stop) is written to a local SQLite
  database on the machine's PC *immediately* — nothing ever waits on the
  network.
- Each event gets a unique ID generated on the device itself, right when it
  happens.
- A background loop (every 15s) tries to push any queued events to the
  server. If there's no connection, they just stay queued — nothing is
  lost, and nothing blocks the operator from continuing to work.
- If a batch is sent twice (e.g. the connection dropped right as the first
  attempt was finishing), the server recognizes the repeated event IDs and
  quietly ignores the duplicates — so retries are always safe.
- This logic is proven end-to-end in `operator-app/test/test-offline-flow.js`,
  which runs a full start → pause → resume → stop cycle completely offline,
  then brings the connection back and confirms everything arrives exactly
  once.

## What the admin dashboard flags automatically

- **Offline machines** — no sync received in the last `OFFLINE_ALERT_MINUTES`
  (default 20).
- **Unusually long sessions** — a job still running past
  `LONG_SESSION_ALERT_HOURS` (default 14), since the system deliberately
  does *not* auto-stop a forgotten session — you asked for manual review
  instead, so this is the flag that catches it.

## Work order queue (supervisor-planned jobs)

Operators no longer start jobs from scratch — a supervisor plans a queue of work orders per machine in the admin panel, and the operator app shows exactly that queue. A job can only be started by picking one from the queue; there's no free-form "Start" anymore.

- **Planning a queue**: Machines page → select a machine → **Work order queue** section. Add jobs one at a time, or **Bulk import** by pasting rows from a planning sheet (Job No, Description, Process, Quantity, Priority, Due Date, Special Instruction, Remarks — column names are matched loosely). Reorder with the ↑/↓ buttons — the operator app shows this exact order.
- **Operator app**: the Home screen is now a **Queue** tab (pending jobs, tap one to start it) and a **Finished** tab (recently completed jobs). Tapping a job shows its details plus a single **Running hour (start)** field — the machine's counter/hour-meter reading — then Start.
- **Finishing a job**: marking a job **Finished** on Stop removes it from the queue for good. Marking it **Incomplete** puts it back in the pending queue (session_id cleared) so someone can pick it up and finish it later — the attempt itself stays recorded in Sessions either way.
- Session records (Sessions page, session detail, Dashboard) show the linked work order's job number for easy cross-reference.

## Start table and End table (multi-row Input/Output data per job)

Rather than a one-time form, each job now has two live, editable **tables** that stay open for the whole time the job is running or paused — the operator can add as many rows as the job needs (minimum 1 before finishing), edit any cell at any time, and remove a row if it was added by mistake.

- **Start table** columns come from a machine's Start-stage fields; **End table** columns come from its Stop-stage fields — configured exactly the same way as before (Machines page → select a machine → add/edit fields, choose Start or Stop, optionally a group label and type: text, number, or select). Nothing about *configuring* fields changed — only when and how the operator fills them in.
- **Running hour start/end**: a machine counter/hour-meter reading, entered once at Start and once at Stop — **Operating Hours** is computed automatically (end minus start) and shown on the session detail and in the CSV export.
- **Continue next shift**: pauses the job with no specific reason recorded — it's a handoff, not a "why did we stop" reason. The job stays open with its running-hour-start and every row already entered intact, ready for whoever's at the PC next (any shift) to tap Resume.
- **Delete job**: removes a job entirely, but only while it's still open (running/paused) — once a job is finished or marked incomplete, it's a permanent record and can't be deleted this way.
- Minimum-1-row is only enforced when marking a job **Finished** — an **Incomplete** job can be stopped with zero rows in either table (e.g. the machine broke down before any data was recorded).

**Exporting a report:** on the Sessions page, filter to a specific machine (each machine has its own columns, so a machine must be selected) and click **Export CSV**. This produces one row per (session, table-row) pair — Start-table row 1 paired with End-table row 1, row 2 with row 2, and so on — plus Running Hour Start/End/Operating Hours columns, with a two-row header (group row, then field-label row) matching the shape of a real production sheet.

## Machines with Input and Output fields (e.g. imported from a real production sheet)

A machine's fields can be split into two groups:
- **Start-stage fields** — become columns of the Start table (typically the "Input" side of a job: material, size, work-order details).
- **Stop-stage fields** — become columns of the End table (typically the "Output" side: measurements, scrap, defects).

Fields support three types: text, **number** (for measurements — rendered as a numeric-friendly input), and select (dropdown from a shared master list). Each field can optionally have a **group label** (e.g. "Input", "Output", "Raw Materials", "Toolings") purely for visually sectioning the admin field list — it has no effect on the data.

**Setting up a machine like this from a real sheet:** on the Machines page, select or create a machine, then click **Import from sheet**. Paste the CSV of a report that has a group header row (Input/Output/...) with the field-label row directly under it — the importer detects both rows, guesses text vs. number per column, and shows you an editable preview before creating anything. Review the group/type/screen (Start or Stop) for each field, adjust as needed, then confirm.

## Pause/stop reason codes

Instead of tapping a reason from a list, the operator types a short **code** on a numeric keypad — the same style as the ID-login screen — and gets a live preview of which reason it matches before confirming. This is meant for factories that already use standardized downtime codes (e.g. "01" = Break, "02" = Waiting for material).

**Setting codes up:** on the Master Lists page, every pause reason and stop reason now has a **Code** field alongside its label. Keep codes short and numeric — the operator's keypad only produces digits, so a code like "P01" (with a letter) can never actually be typed in. Existing reasons on an already-running system will show a blank code until you edit them to add one.

## What's editable from the admin dashboard

- **Machines page**: add/remove Start and Stop fields per machine, edit a field's label/group/required-ness, move a field between Start and Stop, or bulk-import a whole field set from a pasted sheet.
- **Dashboard**: live per-machine card shows the current session's Input values (e.g. Size, WO#) alongside the running/paused timeline — so you can see not just *that* a machine is running, but *what* it's running, without opening the session detail.
- **Sessions page**: click into any session to see its Input values (recorded at start) and Output values (recorded at finish) separately, alongside the full work/pause timeline — and correct any of the built-in time/status fields, with every edit logged to the audit trail.

## Free hosting for a demo (Render.com)

This deploys the backend + admin panel to the internet for free, so you can share a real link with your friend instead of running everything on your own PC.

1. **Push this project to a GitHub repo** (Render deploys from GitHub). If you don't already have one: create a new repo on github.com, then from the project's root folder:
   ```
   git init
   git add .
   git commit -m "Factory Tracker"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/factory-tracker.git
   git push -u origin main
   ```

2. **Sign up at render.com** (free, no credit card needed for this).

3. **New → Blueprint**, connect your GitHub account, and select the `factory-tracker` repo. Render reads `render.yaml` at the project root automatically and sets up two services: `factory-tracker-backend` (the API) and `factory-tracker-admin` (the admin panel).

4. Click **Apply**. The backend deploys first — wait for it to go live, then copy its URL (shown on its service page, looks like `https://factory-tracker-backend-xxxx.onrender.com`).

5. Go to the **factory-tracker-admin** service → **Environment** → set `VITE_API_BASE` to that backend URL **plus `/api`**, e.g.:
   ```
   https://factory-tracker-backend-xxxx.onrender.com/api
   ```
   Save, which triggers a rebuild of the admin panel pointing at your live backend.

6. Once both are live, open the admin panel's URL. **The backend seeds itself automatically the first time it boots** — no Shell access needed (Render's free tier doesn't allow Shell anyway). Log in with:
   - Username: `admin`
   - Password: `admin123`

   **Change this password after logging in** — anyone who finds your admin URL can log in with the default otherwise.

7. **Point the operator app at your live backend**: in `operator-app/config.json` (or the `.exe`'s config, see below), set:
   ```json
   { "apiBase": "https://factory-tracker-backend-xxxx.onrender.com/api", "machineApiKey": "..." }
   ```
   Get the machine API key from the admin panel's Machines page after logging in (the auto-seed creates one example machine, "CNC Machine 1," to start from).

**Free-tier limits worth knowing:**
- The backend goes to sleep after 15 minutes of no traffic, and takes ~30-60 seconds to wake up on the next request. Fine for a demo; for a real factory you'd want a paid tier (~$7/mo) so it's always instantly responsive.
- **Data does not persist.** Render's free web services don't support a persistent disk, so the SQLite database resets every time the service redeploys or restarts (a config change, a crash, or Render's own maintenance can all trigger this). Fine for trying the demo in one sitting; not fine for real factory data. When you're ready to actually run this for real, upgrade the backend service to a paid plan (~$7/mo) and add a persistent disk — at that point re-add a `disk:` block to `render.yaml` pointing `DATABASE_PATH` at a mounted path, the same way the very first version of this config did.
- If the backend ever redeploys or restarts, it will automatically re-seed itself on the next boot (same default admin login, but a **new** machine API key each time) — no manual step needed, but you will need to re-copy the new machine API key into any operator app's `config.json` afterward. Set `SKIP_AUTO_SEED=1` as an env var if you ever want to disable this (e.g. once you're on a paid plan with real persistent data and don't want any automatic writes on boot).

## Backups (important on free hosting)

Render's free tier has **no persistent disk**: the database is wiped every
time the service restarts, sleeps and wakes, or redeploys. The app re-seeds
itself so it still starts, but everything recorded is gone. Until you move to
a paid instance with a disk, treat backups as essential rather than optional.

### Download one by hand

Admin panel → **Backup** → *Download backup*. One JSON file containing
machines, operators, work orders, sessions, attendance and scrap. Keep it
somewhere that isn't the server.

### Restore after a wipe

Admin panel → **Backup** → pick your file under *Restore from a backup*. It
replaces everything currently in the database, so it asks for confirmation
first. Use it after a wipe, or to move to a new server.

### Automatic hourly backups

The server can't reliably back itself up — a sleeping service isn't running to
trigger anything, and its disk doesn't survive anyway. So the pull has to come
from a machine you control:

```bash
node backend/scripts/pull-backup.js \
  --url https://your-app.onrender.com/api \
  --user admin --password YOUR_PASSWORD \
  --out ./backups --keep 48
```

It waits out the ~30-60s cold start of a sleeping free-tier service, saves a
timestamped file, and prunes to the newest `--keep` files. If the server can't
be reached it writes nothing rather than leaving a truncated file.

Schedule it hourly:

- **Windows** — Task Scheduler → Create Task → Trigger: daily, repeat every
  1 hour → Action: `node C:\path\to\backend\scripts\pull-backup.js`
- **macOS / Linux** — `crontab -e`, then:
  ```
  0 * * * * cd /path/to/backend && node scripts/pull-backup.js >> backup.log 2>&1
  ```

With `--keep 48` you hold two days of hourly snapshots, which is enough to
recover from a wipe nobody noticed overnight.

## Building and releasing the operator app

The operator app installs from an NSIS installer and **updates itself** from
GitHub Releases. You publish a new version once; every shop-floor PC picks it
up on its own.

### One-time setup on your build machine

You need a GitHub token so electron-builder can upload the release:

```powershell
# A classic personal access token with the "repo" scope
$env:GH_TOKEN = "ghp_xxxxxxxxxxxxxxxx"
```

Create it at GitHub → Settings → Developer settings → Personal access tokens.

### Publishing a new version

1. **Bump the version** in `operator-app/package.json` — this is what the
   updater compares, so a release with an unchanged version is ignored:
   ```json
   "version": "1.0.1"
   ```
2. Build and publish:
   ```powershell
   cd operator-app
   npm install
   npm run build -- --publish always
   ```

That uploads the installer plus a `latest.yml` (the file the updater reads) to
a GitHub Release. Within about six hours every running machine downloads it in
the background; the update installs the next time that app is closed.

To build without publishing — for testing — use plain `npm run build`.

### Installing on a new machine

1. Download and run `Factory Tracker Setup <version>.exe` from your GitHub
   Releases page. It's a one-click, per-user install, so it needs no admin
   password.
2. Create the machine's `config.json` at the path the app shows on its "Setup
   needed" screen — normally:
   ```
   %APPDATA%\factory-tracker-operator-app\config.json
   ```
   ```json
   {
     "apiBase": "https://your-backend.onrender.com/api",
     "machineApiKey": "paste-this-machines-key-from-the-admin-panel",
     "language": "en"
   }
   ```
   `language` is `en`, `ar` (right-to-left), or `hi`.

Upgrading from the old portable build: put the machine's existing
`config.json` next to the installed `.exe` and launch once — the app copies it
into the user-data folder itself and reports the path it used.

### How updates behave on the floor

- **Downloaded in the background**, then installed when the app is next
  closed. The updater will never restart the app on its own, because on a
  shop floor that could happen mid-job.
- **`config.json` lives in user-data, not the install folder**, so an update
  can't wipe a machine's API key or language.
- **A failed check is silent** — the app is built to work offline, and the
  next check simply retries.
- The running version shows in the top bar, with a quiet note when an update
  is staged.

## What's intentionally left for you to configure per factory

- Master lists (materials, tools, work orders) — enter your real ones.
- Each machine's Start-form questions — fully configurable per machine.
- Pause reasons and stop reasons — edit the seeded examples to match reality.
- Operators and their machine assignments.

## Not yet built (natural next steps, not needed for a working MVP)

- Reporting/analytics dashboard (OEE, downtime by reason, productivity) —
  all the raw data for this already exists in `sessions` / `pause_events`,
  it just needs report views added on top.
- Multi-tenant support (several separate factories in one deployment) — the
  data model doesn't block this, but there's no "company" layer yet.
- Automated packaging/signing for distributing the operator-app installer
  to many PCs at once (currently: build once per OS, install manually).
