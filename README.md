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

## Machines with Input and Output fields (e.g. imported from a real production sheet)

A machine's fields can now be split across two screens:
- **Start-stage fields** — answered when the operator clicks Start (e.g. work order, material, size — typically the "Input" side of a job).
- **Stop-stage fields** — answered when the operator finishes or cancels the job (e.g. output measurements, scrap, defects — the "Output" side).

Fields also support a third type beyond text/select: **number**, for measurements (length, RPM, thickness, etc — rendered as a numeric keypad-friendly input on the operator app). Each field can optionally have a **group label** (e.g. "Input", "Output", "Raw Materials", "Toolings") purely for visually sectioning the form — it has no effect on the data, only on how the form is laid out.

**Setting up a machine like this from a real sheet:** on the Machines page, select or create a machine, then click **Import from sheet**. Paste the CSV of a report that has a group header row (Input/Output/...) with the field-label row directly under it — the importer detects both rows, guesses text vs. number per column, and shows you an editable preview before creating anything. Review the group/type/screen (Start or Stop) for each field, adjust as needed, then confirm.

**Exporting a report back out:** on the Sessions page, filter to a specific machine (each machine has its own columns, so a machine must be selected) and click **Export CSV**. This reconstructs a two-row-header report — a group row, then a field-label row — matching the shape of the original sheet, with one row per recorded session.

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

6. Once both are live, open the admin panel's URL, log in (`admin` / `admin123` — **change this password**), and set things up.

7. **Seed the database once**, from Render's dashboard: go to the backend service → **Shell** tab → run:
   ```
   node scripts/seed.js
   ```
   This only needs to run once (it creates the admin login and prints your first machine's API key).

8. **Point the operator app at your live backend**: in `operator-app/config.json` (or the `.exe`'s config, see below), set:
   ```json
   { "apiBase": "https://factory-tracker-backend-xxxx.onrender.com/api", "machineApiKey": "..." }
   ```

**Free-tier limits worth knowing:**
- The backend goes to sleep after 15 minutes of no traffic, and takes ~30-60 seconds to wake up on the next request. Fine for a demo; for a real factory you'd want a paid tier (~$7/mo) so it's always instantly responsive.
- **Data does not persist.** Render's free web services don't support a persistent disk, so the SQLite database resets every time the service redeploys or restarts (a config change, a crash, or Render's own maintenance can all trigger this). Fine for trying the demo in one sitting; not fine for real factory data. When you're ready to actually run this for real, upgrade the backend service to a paid plan (~$7/mo) and add a persistent disk — at that point re-add a `disk:` block to `render.yaml` pointing `DATABASE_PATH` at a mounted path, the same way the very first version of this config did.
- If the backend ever redeploys or restarts, you'll need to re-run `node scripts/seed.js` from the Shell tab to get a working admin login and machine API keys again — the old ones will be gone along with the data.

## Building a standalone .exe for the operator app

```powershell
cd operator-app
npm install
npm run build
```

This produces `operator-app\dist\Factory Tracker 1.0.0.exe` — a single portable file, no installer, no admin rights needed. Copy that one file (plus a `config.json` next to it, see `config.example.json`) to any Windows PC and double-click to run.

To have it ship already configured for your friend (so they don't need to touch `config.json` at all), edit `operator-app/config.example.json` with your live Render backend URL and a real machine API key **before** running `npm run build`, then rename it to `config.json` and place it next to the built `.exe`.

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
