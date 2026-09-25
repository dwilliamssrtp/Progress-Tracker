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
   or overwrites your existing `Accounts`, `Trainees`, `Items`, `History`,
   or `Sessions` data. The first time it creates the `Phases`/`ItemDefs`
   sheets it seeds them with the same content that used to be hardcoded, so
   nothing already in use changes. If you're updating from a version before
   `Tracks` existed, this run also creates one default "Engineer Trainee"
   track and silently assigns every existing Key Objective and employee to
   it, so today's checklists keep working exactly as before — nothing
   disappears or needs to be redone.
6. **Deploy → Manage deployments** → click the pencil icon on the existing
   web app deployment → **Version: New version** → Deploy.
   - Do **not** use "New deployment" — that mints a different `/exec` URL
     and breaks `index.html`, which points at the current one.
7. That's it — the same URL now serves the updated backend. No change to
   `API_URL` in `index.html` is needed.

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
- **`ItemDefs` sheet** — the checklist items (activities/criteria) that
  belong to each Key Objective. Also admin-editable from the site.
  Editing or deleting one here updates/removes it for every employee whose
  checklist already includes it; creating one adds it to every existing
  employee on that objective's Track automatically.
- **`ReviewerAssignments` sheet** — the review hierarchy. An admin can
  assign, per Key Objective, which account(s) are allowed to approve,
  request changes on, or directly mark complete an item — either as a
  program-wide default or as an override for one specific employee. Until
  an admin sets this up for a given objective, review authority falls back
  to the old behavior (any account with a supervisor-level role).
- **`markComplete` action** — a reviewer can now mark a checklist item done
  directly, without the employee having submitted it first. It records the
  reviewer as both submitter and approver so the trail stays honest.

None of this requires re-running `setup()` more than once, and none of it
touches the `Accounts`/`Trainees`/`Items` data you already have.
