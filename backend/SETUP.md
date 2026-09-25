# Deploying `Code.gs` (backend update)

This repo's `backend/Code.gs` is a checked-in copy of the Google Apps Script
that powers the tracker. Editing it here does **not** change the live app —
Apps Script isn't hosted from GitHub. After pulling changes to this file,
push them into the actual deployment by hand:

1. Open the Google Sheet the tracker is bound to.
2. **Extensions → Apps Script**.
3. Select the existing `Code.gs` file in the editor, select all (Ctrl/Cmd+A),
   delete, and paste in the full contents of `backend/Code.gs` from this repo.
4. Save (Ctrl/Cmd+S).
5. Run `setup()` once from the editor's function dropdown + Run button.
   This is safe to re-run — it only creates sheets/rows that don't exist yet
   (`Phases`, `ItemDefs`, `ReviewerAssignments`, `Tracks`) and never deletes
   your existing `Items`, `History`, or `Sessions` data. It *does* update
   two things in `Accounts` and `Trainees` on this run — see **Read this
   before you run setup() this time** below, it changes who can review whom.
6. **Deploy → Manage deployments** → click the pencil icon on the existing
   web app deployment → **Version: New version** → Deploy.
   - Do **not** use "New deployment" — that mints a different `/exec` URL
     and breaks `index.html`, which points at the current one.
7. That's it — the same URL now serves the updated backend. No change to
   `API_URL` in `index.html` is needed.

## Read this before you run setup() this time — permissions changed

Two things used to be tangled together: an account's **Role** (a job-title
string) and whether that person could **review** other people's checklist
items. That's now split apart:

- **Role is now just a department label** — one of `Engineer`, `Sales`,
  `Manufacturing`, or `Admin`. It grants no review permission by itself.
  A "VP of Engineering" is `Role: Engineer`, same as a brand-new hire on
  that track — nothing about the label makes them a reviewer.
- **Review permission is now fully explicit**, set per Key Objective from
  its **"Reports to"** picker in Manage Program (pick one or more
  accounts — replaces the old free-text field), plus optional per-employee
  overrides. Admin can always review everything; nobody else gets an
  implicit fallback any more.
- **The Team Roster is now scoped by that same permission** — a non-Admin
  account only sees, in Team Roster, the employees they're an assigned
  reviewer for. Nobody automatically sees the whole company any more.
- **Every non-Admin account now gets its own career-development
  record/Track**, not just accounts you'd labeled "Trainee". A "my
  development" link in the header lets anyone reach their own checklist
  regardless of what their Team Roster shows.

**When you run `setup()` on this version, it will, once:**
1. Map every existing account's old Role value onto the new set
   (`Manufacturing Manager`→`Manufacturing`, `VP Production & Engineering`
   and `CTO`→`Engineer`, `Trainee`/`Viewer`→`Engineer`, `Admin` unchanged).
2. Give any existing non-Admin account that doesn't already have one a
   personal career-development record on the default track.

**What it will *not* do:** recreate the review permissions your old
Managers/VPs/CTOs had implicitly by virtue of their role. After this run,
go to **Manage Program**, open each Key Objective, and set its "Reports
to" (and any per-employee overrides you need) — until you do, only Admin
can review anything on it. This is a one-time setup cost for real,
per-person permissioning instead of a role-shaped guess.

## What's new in this version

- **`Tracks` sheet** — a role or program (e.g. "Engineer Trainee", "Sales",
  "Operations Manager"). Every Key Objective belongs to exactly one Track,
  and every employee is on exactly one Track — they only ever see the
  objectives that belong to their own Track. Admins create/edit/delete
  Tracks, and reassign an employee's Track, from the site's **Manage
  Program** tab. Reassigning an employee onto a new Track seeds them any
  checklist items from that Track they don't already have; it never
  deletes their history on the old Track, it just stops being shown.
- **`Phases` sheet** — the "Key Objectives" (what used to be hardcoded
  program stages), each scoped to one Track. Admins can create/edit/delete
  these from the site's **Manage Program** tab instead of editing code.
  Its "Reports to" is now a multi-account picker (see above), not text.
- **`ItemDefs` sheet** — the checklist items (activities/criteria) that
  belong to each Key Objective. Also admin-editable from the site.
  Editing or deleting one here updates/removes it for every employee whose
  checklist already includes it; creating one adds it to every existing
  employee on that objective's Track automatically.
- **`ReviewerAssignments` sheet** — the review hierarchy (see above). An
  admin can assign, per Key Objective, which account(s) are allowed to
  approve, request changes on, or directly mark complete an item — either
  as a program-wide default (via "Reports to") or as an override for one
  specific employee (Manage Program's "Per-Employee Overrides").
- **`markComplete` action** — a reviewer can now mark a checklist item done
  directly, without the employee having submitted it first. It records the
  reviewer as both submitter and approver so the trail stays honest.
- **Edit/delete accounts** — Manage Accounts now has Edit (name, username,
  email, Track) and Delete buttons per account. Delete removes the login
  only; any career-development history stays on the roster.

None of this requires re-running `setup()` more than once, and it never
touches your `Items`/`History` data.
