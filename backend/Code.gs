/**
 * Career Development Tracker — Apps Script backend.
 *
 * Deploy: Extensions > Apps Script in the Google Sheet this is bound to,
 * paste this file in as Code.gs, run setup() once (approve permissions when
 * asked — note the admin password it shows you, you'll need it), then
 * Deploy > New deployment > Web app, "Execute as: Me", "Who has access:
 * Anyone". Paste the resulting /exec URL into API_URL near the top of
 * index.html. See SETUP.md for the full walkthrough.
 *
 * Updating an existing deployment: edit this file in the Apps Script
 * editor, then Deploy > Manage deployments > pencil icon > New version.
 * "New deployment" mints a different URL and breaks index.html — don't use
 * it for updates. Re-running setup() after an update is safe: it only fills
 * in sheets/rows that are missing, it never touches existing data.
 *
 * PROGRAM MODEL — employees belong to a `Tracks` entry (a role/program,
 * e.g. "Engineer Trainee", "Sales", "Operations Manager"). The checklist
 * is organized as a list of "Key Objectives" (the `Phases` sheet — a stage
 * of a career development plan, e.g. a rotation, a project phase, a review
 * period) each holding a list of checklist items (the `ItemDefs` sheet —
 * activities/criteria). Every Key Objective belongs to exactly one Track,
 * and an employee only ever sees the objectives on their own Track. Tracks,
 * objectives and items are all admin-editable from the site (Manage
 * Program tab) instead of being hardcoded here; this file only seeds
 * sensible starting content the first time it runs, via setup().
 *
 * REVIEW HIERARCHY / PERMISSIONS — `Role` (Engineer / Sales / Manufacturing /
 * Admin) is just a department label now; it grants no review rights by
 * itself (Admin excepted — an Admin can always review, edit, and see
 * everything). Who can review whom is entirely explicit, via
 * `ReviewerAssignments`: an assignment is either a program-wide default for
 * a Key Objective (TraineeId blank — set from that objective's "Reports to"
 * picker) or an override for one specific employee on that objective. A
 * "VP of Engineering" is Role=Engineer like anyone else on that track; what
 * makes them a manager is being named in `ReviewerAssignments` for the
 * objectives their reports are on. The Team Roster a non-Admin account sees
 * is scoped the same way: only employees they're an assigned reviewer for
 * (see `visibleTraineesFor_`). Until an admin sets up an objective's
 * "Reports to", nobody but Admin can review it — nothing falls back to a
 * role-based default any more.
 *
 * AUTH MODEL — lightweight, not enterprise-grade: accounts live in the
 * `Accounts` sheet with a salted SHA-256 password hash (Utilities.computeDigest,
 * not a slow KDF like bcrypt — fine for a small internal tool, not something
 * to expose to the open internet at scale). Login issues a random session
 * token stored in `Sessions`; the front end holds it in localStorage and
 * sends it with every call. The server resolves every action's actor
 * (name/role/traineeId) from the session — never from anything the client
 * claims — so this is real authorization, not just a UI picker.
 */

var SHEET_ITEMS = 'Items';
var SHEET_HISTORY = 'History';
var SHEET_TRAINEES = 'Trainees';
var SHEET_ACCOUNTS = 'Accounts';
var SHEET_SESSIONS = 'Sessions';
var SHEET_PHASES = 'Phases';
var SHEET_ITEMDEFS = 'ItemDefs';
var SHEET_REVIEWERS = 'ReviewerAssignments';
var SHEET_TRACKS = 'Tracks';

var ITEM_HEADERS = ['TraineeId', 'ItemId', 'Phase', 'Kind', 'Order', 'Text', 'Status', 'Note',
  'SubmittedByName', 'SubmittedByRole', 'SubmittedAt',
  'ReviewedByName', 'ReviewedByRole', 'ReviewedAt', 'ReviewNote'];
var HISTORY_HEADERS = ['RowId', 'TraineeId', 'ItemId', 'Phase', 'Action', 'ActorName', 'ActorRole', 'Timestamp', 'Detail'];
// TrackId is appended at the END, not inserted earlier in the list — this
// sheet may already have data from before Tracks existed, and ensureSheet_
// only ever rewrites row 1 (the header). Appending keeps every existing
// column's position (and therefore its data) untouched; inserting it
// earlier would relabel already-populated columns without moving their
// data, corrupting every existing row.
var TRAINEE_HEADERS = ['TraineeId', 'Name', 'StartDate', 'Status', 'CreatedAt', 'CreatedBy', 'TrackId'];
var ACCOUNT_HEADERS = ['AccountId', 'Username', 'Name', 'Role', 'TraineeId', 'Email',
  'PasswordHash', 'PasswordSalt', 'Active', 'CreatedAt', 'CreatedBy'];
var SESSION_HEADERS = ['Token', 'AccountId', 'CreatedAt', 'ExpiresAt'];
// Same append-only reasoning as TRAINEE_HEADERS above.
var PHASE_HEADERS = ['PhaseId', 'Tag', 'Title', 'RangeLabel', 'Location', 'ReportingLabel', 'Output', 'ObjectiveText', 'Order', 'TrackId'];
var ITEMDEF_HEADERS = ['ItemId', 'Phase', 'Kind', 'Text', 'Order'];
var REVIEWER_HEADERS = ['AssignmentId', 'PhaseId', 'TraineeId', 'ReviewerAccountId', 'CreatedAt', 'CreatedBy'];
var TRACK_HEADERS = ['TrackId', 'Name', 'Description', 'CreatedAt', 'CreatedBy'];

// Just a department label — it grants no permissions by itself. Who can
// review/manage whom is entirely explicit via ReviewerAssignments (see the
// PROGRAM MODEL / REVIEW HIERARCHY comment above). Admin is the one
// exception: it's both the department-less "runs the whole site" role and
// an implicit superuser for review/visibility everywhere.
var ROLES = ['Engineer', 'Sales', 'Manufacturing', 'Admin'];
// Old role values, from before roles were simplified to the list above —
// used once by setup() to migrate any existing Accounts rows. Add to this
// if you rename roles again later.
var LEGACY_ROLE_MAP = {
  'Trainee': 'Engineer',
  'Manufacturing Manager': 'Manufacturing',
  'VP Production & Engineering': 'Engineer',
  'CTO': 'Engineer',
  'Viewer': 'Engineer'
};
var SESSION_DAYS = 30;

// Fill in to email people automatically (employee submits -> supervisors;
// supervisor reviews -> that employee's own account email). Leave blank to skip.
var NOTIFY_SUPERVISOR_EMAILS = []; // e.g. ['manager@specialtyrtp.com', 'vp@specialtyrtp.com']

// ---------------------------------------------------------------------
// SEED CONTENT — only used by setup() the first time the Phases/ItemDefs
// sheets are empty. After that, the sheets themselves (editable from the
// site's Manage Program tab, or by hand) are authoritative; nothing here
// is read again.
// ---------------------------------------------------------------------
var PHASE_SEED = [
  { id: '1a', tag: '1A', title: 'Core Station Rotations', rangeLabel: 'Months 1–3', location: 'Production Floor',
    reportingLabel: 'Manufacturing Manager / VP Production & Engineering', output: 'Competency in Baseline, Braidline, Coverline operations; equipment familiarity',
    objectiveText: 'Build hands-on working knowledge of all three primary production stages and supporting maintenance activities. Develop the foundational shop floor literacy required to credibly engage in process improvement work in Phase 2.', order: 1 },
  { id: '1b', tag: '1B', title: 'Full Cycle, Field & Supply Chain', rangeLabel: 'Months 3–6', location: 'Production Floor + Field',
    reportingLabel: 'Manufacturing Manager / VP Production & Engineering', output: 'Quality/testing proficiency; inventory & supply chain literacy; minimum 1 field install',
    objectiveText: 'Deepen production competency across all stations, gain exposure to quality/testing leadership functions, complete supply chain and inventory literacy, and participate in at least one field installation to understand the end-to-end product lifecycle.', order: 2 },
  { id: '2', tag: '2', title: 'Process Improvement', rangeLabel: 'Months 6–18', location: 'Office + Shop Floor',
    reportingLabel: 'VP Production & Engineering', output: 'Documented improvement projects; project plan portfolio; shop efficiency metrics',
    objectiveText: 'Transition from operator-level contributor to a hybrid engineering function. Leverage shop floor knowledge to identify, plan, and implement measurable process and equipment improvements. Develop project management capability in a real operational context.', order: 3 },
  { id: '3', tag: '3', title: 'Design, Planning & Technical Development', rangeLabel: 'Months 18–24', location: 'Office + Cross-functional',
    reportingLabel: 'CTO / VP Production & Engineering', output: 'Technical design contributions; planning documents; readiness for senior role',
    objectiveText: 'Develop as a credible technical contributor in product design, process engineering, and capital planning. Support the CTO and VP Production & Engineering in design activities, process validation, and engineering documentation.', order: 4 }
];

var ITEM_SEED = [
  // Phase 1A
  {id:'1a-a1', phase:'1a', kind:'activity', text:'Baseline Station (max. 3 weeks) — extrusion parameters, line speed, material handling, dimensional inspection with calipers & Pi tape, production records, shift handover'},
  {id:'1a-a2', phase:'1a', kind:'activity', text:'Braidline Station (max. 3 weeks) — braid angle & fiber tension, overlap/coverage, fiber count verification, in-process inspection per QWI QC 004'},
  {id:'1a-a3', phase:'1a', kind:'activity', text:'Coverline Station (max. 3 weeks) — cover extrusion temperatures, wall thickness via PosiTector UTG, adhesion requirements, in-process inspection per QWI QC 005'},
  {id:'1a-a4', phase:'1a', kind:'activity', text:'Quality & Testing Lab (max. 2 weeks) — short-term burst test (QWI QC 001), hydrostatic testing (QWI QC 002), calibration tools, NCR & RED-tag procedure'},
  {id:'1a-a5', phase:'1a', kind:'activity', text:'Equipment Maintenance (max. 1 week) — PM schedules, fault logging, basic electrical/mechanical troubleshooting'},
  {id:'1a-a6', phase:'1a', kind:'activity', text:'QMS Orientation — quality policy, document control, nonconforming product procedure, HSE safety training (within first 30 days)'},
  {id:'1a-a7', phase:'1a', kind:'activity', text:'Morning production meetings — attend daily; observe schedule, quality hold, and resource communication across shifts'},
  {id:'1a-c1', phase:'1a', kind:'criterion', text:'Can set up, operate, and complete production records at all three stations without constant supervision'},
  {id:'1a-c2', phase:'1a', kind:'criterion', text:'Understands in-process inspection hold points and the NCR/RED-tag process'},
  {id:'1a-c3', phase:'1a', kind:'criterion', text:'Can identify and report equipment fault conditions for each station'},
  {id:'1a-c4', phase:'1a', kind:'criterion', text:'Completed QMS onboarding training and signed competency acknowledgements'},
  {id:'1a-c5', phase:'1a', kind:'criterion', text:'Has demonstrated ability to work safely and comply with all QHSE requirements'},
  // Phase 1B
  {id:'1b-a1', phase:'1b', kind:'activity', text:'Continued station rotations — operate all three stations with increasing independence; lead shift-level tasks under Senior Lead supervision'},
  {id:'1b-a2', phase:'1b', kind:'activity', text:'Quality & Testing — review/verify inspection records; assist Quality & HSE Manager on audit-readiness; API Spec 15S context'},
  {id:'1b-a3', phase:'1b', kind:'activity', text:'Swaging & Fitting — learn and demonstrate the swaging process per QWI; fitting inspection criteria and documentation'},
  {id:'1b-a4', phase:'1b', kind:'activity', text:'Field Installation — accompany at least one field crew; observe fitting/connection procedures, pressure test protocols, site documentation'},
  {id:'1b-a5', phase:'1b', kind:'activity', text:'Inventory & Receiving — rotate Shipping & Receiving and raw materials store; receiving inspection, material ID/traceability, storage, lot control, inventory system'},
  {id:'1b-a6', phase:'1b', kind:'activity', text:'Procurement basics — purchase requisition/PO process, approved vendor list, lead time management, material specs for key RTP inputs'},
  {id:'1b-a7', phase:'1b', kind:'activity', text:'Process gap identification — informal log of inefficiencies, equipment issues, and improvement opportunities; monthly review with VP Production & Engineering'},
  {id:'1b-a8', phase:'1b', kind:'activity', text:'Improvement project scoping — select one or two opportunities from the gap log to develop into formal project proposals for Phase 2'},
  {id:'1b-c1', phase:'1b', kind:'criterion', text:'Has participated in at least one field installation and can describe the end-to-end product lifecycle from raw material to installed pipe'},
  {id:'1b-c2', phase:'1b', kind:'criterion', text:'Can independently complete the swaging process per QWI and pass quality inspection'},
  {id:'1b-c3', phase:'1b', kind:'criterion', text:'Demonstrates working knowledge of receiving, material traceability, and inventory management procedures'},
  {id:'1b-c4', phase:'1b', kind:'criterion', text:'Has produced a documented improvement opportunity log with at least two scoped proposals ready for Phase 2'},
  {id:'1b-c5', phase:'1b', kind:'criterion', text:'Compensation review conducted at Month 12; trajectory toward entry-level engineering rate confirmed or adjusted'},
  // Phase 2
  {id:'2-a1', phase:'2', kind:'activity', text:'Process improvement project ownership — maintain a prioritized improvement project list; own scoping, planning, sourcing, and execution for assigned projects'},
  {id:'2-a2', phase:'2', kind:'activity', text:'Production scheduling awareness — use equipment downtime and transition windows proactively for project implementation'},
  {id:'2-a3', phase:'2', kind:'activity', text:'Equipment improvement projects — e.g. dry air systems, hose/connection organization, tooling standardization, 5S systems, test bench upgrades'},
  {id:'2-a4', phase:'2', kind:'activity', text:'Documentation — project proposals, cost-benefit summaries, implementation plans, and post-completion reviews in a consistent format'},
  {id:'2-a5', phase:'2', kind:'activity', text:'Technical writing development — contribute to or update work instructions, equipment setup checklists, and process parameter records under QMS oversight'},
  {id:'2-a6', phase:'2', kind:'activity', text:'Sourcing & procurement coordination — vendor contact, quote comparison, and supply coordination with Procurement Specialist'},
  {id:'2-a7', phase:'2', kind:'activity', text:'Materials science foundation — structured self-study and mentored sessions with CTO on pipe materials, RTP design principles, force/pressure analysis, API Spec 15S / ASTM methods'},
  {id:'2-a8', phase:'2', kind:'activity', text:'Regular review cadence — monthly structured review with VP Production & Engineering; quarterly summary to CEO'},
  {id:'2-c1', phase:'2', kind:'criterion', text:'Has completed and documented at least two measurable improvement projects with before/after performance data'},
  {id:'2-c2', phase:'2', kind:'criterion', text:'Has produced professionally formatted project plans and completion reports suitable for executive review'},
  {id:'2-c3', phase:'2', kind:'criterion', text:'Demonstrates ability to plan and schedule project activities around the production schedule without disrupting output'},
  {id:'2-c4', phase:'2', kind:'criterion', text:'Has begun structured study in materials science and pipe design principles; can explain basic RTP design rationale'},
  {id:'2-c5', phase:'2', kind:'criterion', text:'Compensation review conducted; benchmarked against junior process engineer market rate'},
  // Phase 3
  {id:'3-a1', phase:'3', kind:'activity', text:'Product design exposure — RTP product specifications, design calculations, qualification testing requirements under API Spec 15S, management of change (MOC) documentation'},
  {id:'3-a2', phase:'3', kind:'activity', text:'Process validation — contribute to or own documentation for QP-021 and associated work instructions WI-BL-001, WI-BR-001, WI-CL-001'},
  {id:'3-a3', phase:'3', kind:'activity', text:'Capital project development — progress high-priority Phase 2 proposals into formal capital project submissions: ROI analysis, equipment specs, vendor evaluation'},
  {id:'3-a4', phase:'3', kind:'activity', text:'Technical specification writing — draft or update engineering specs, TDS/MDS documents, and product data sheets under CTO review'},
  {id:'3-a5', phase:'3', kind:'activity', text:'Cross-functional planning — production planning, order execution, and customer delivery coordination (QP-037)'},
  {id:'3-a6', phase:'3', kind:'activity', text:'Advanced materials study — material compatibility, failure modes, pressure/temperature rating methodology'},
  {id:'3-a7', phase:'3', kind:'activity', text:'Field technical role assessment — assess aptitude and interest for a field technical leadership function'},
  {id:'3-a8', phase:'3', kind:'activity', text:'Leadership and communication — present improvement results and technical proposals at management level; client-facing and API audit communication'},
  {id:'3-c1', phase:'3', kind:'criterion', text:'Can contribute meaningfully to product design reviews and process validation documentation'},
  {id:'3-c2', phase:'3', kind:'criterion', text:'Has produced at least one capital project proposal accepted for implementation by the CEO/VP'},
  {id:'3-c3', phase:'3', kind:'criterion', text:'Can explain SRTP’s RTP design rationale, material selection criteria, and API Spec 15S qualification requirements'},
  {id:'3-c4', phase:'3', kind:'criterion', text:'Is assessed and confirmed as ready for a formal Process/Design Engineer or equivalent designation'},
  {id:'3-c5', phase:'3', kind:'criterion', text:'Performance and compensation review conducted; pathway to senior role defined'}
];

/* ---------------- setup ---------------- */

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_ITEMS, ITEM_HEADERS);
  ensureSheet_(ss, SHEET_HISTORY, HISTORY_HEADERS);
  var trainees = ensureSheet_(ss, SHEET_TRAINEES, TRAINEE_HEADERS);
  var accounts = ensureSheet_(ss, SHEET_ACCOUNTS, ACCOUNT_HEADERS);
  ensureSheet_(ss, SHEET_SESSIONS, SESSION_HEADERS);
  var tracks = ensureSheet_(ss, SHEET_TRACKS, TRACK_HEADERS);
  var phases = ensureSheet_(ss, SHEET_PHASES, PHASE_HEADERS);
  var itemDefs = ensureSheet_(ss, SHEET_ITEMDEFS, ITEMDEF_HEADERS);
  ensureSheet_(ss, SHEET_REVIEWERS, REVIEWER_HEADERS);

  var msg = 'Setup complete.';

  var defaultTrackId = 'track_default';
  if (tracks.getLastRow() < 2) {
    tracks.appendRow([defaultTrackId, 'Engineer Trainee', 'The original engineering trainee career development program.', new Date(), 'setup()']);
    msg += '\n\nSeeded the Tracks sheet with a default "Engineer Trainee" track. Add more tracks (Sales, Operations, etc.) from the site\'s Manage Program tab to build objectives for other roles.';
  } else {
    defaultTrackId = sheetToObjects_(tracks, TRACK_HEADERS)[0].TrackId;
  }

  if (phases.getLastRow() < 2) {
    var phaseRows = PHASE_SEED.map(function (p) {
      return [p.id, p.tag, p.title, p.rangeLabel, p.location, p.reportingLabel, p.output, p.objectiveText, p.order, defaultTrackId];
    });
    phases.getRange(2, 1, phaseRows.length, PHASE_HEADERS.length).setValues(phaseRows);
    msg += '\n\nSeeded the Phases sheet with the default Key Objectives, all under the default track — edit/add/remove them (and add other tracks) from the site\'s Manage Program tab any time.';
  } else {
    // Migration: back-fill TrackId on any Phases rows saved before Tracks existed.
    var phaseObjs = sheetToObjects_(phases, PHASE_HEADERS);
    var migratedPhases = 0;
    phaseObjs.forEach(function (p, idx) {
      if (!p.TrackId) { phases.getRange(idx + 2, PHASE_HEADERS.indexOf('TrackId') + 1).setValue(defaultTrackId); migratedPhases++; }
    });
    if (migratedPhases) msg += '\n\nAssigned ' + migratedPhases + ' existing Key Objective(s) to the default track.';
  }

  if (itemDefs.getLastRow() < 2) {
    var defRows = ITEM_SEED.map(function (d, i) {
      return [d.id, d.phase, d.kind, d.text, i + 1];
    });
    itemDefs.getRange(2, 1, defRows.length, ITEMDEF_HEADERS.length).setValues(defRows);
    msg += '\n\nSeeded the ItemDefs sheet with the default checklist items.';
  }

  // Migration: back-fill TrackId on any Trainees rows saved before Tracks existed.
  var traineeObjs = sheetToObjects_(trainees, TRAINEE_HEADERS);
  var migratedTrainees = 0;
  traineeObjs.forEach(function (t, idx) {
    if (!t.TrackId) { trainees.getRange(idx + 2, TRAINEE_HEADERS.indexOf('TrackId') + 1).setValue(defaultTrackId); migratedTrainees++; }
  });
  if (migratedTrainees) msg += '\n\nAssigned ' + migratedTrainees + ' existing employee(s) to the default track.';

  // Migration: collapse old role values onto the new Engineer/Sales/
  // Manufacturing/Admin set. Role no longer grants review permissions by
  // itself — only ReviewerAssignments does (see the REVIEW HIERARCHY /
  // PERMISSIONS comment at the top of this file).
  var accountObjs = sheetToObjects_(accounts, ACCOUNT_HEADERS);
  var migratedRoles = 0;
  accountObjs.forEach(function (a, idx) {
    if (ROLES.indexOf(a.Role) === -1) {
      var newRole = LEGACY_ROLE_MAP[a.Role] || 'Engineer';
      accounts.getRange(idx + 2, ACCOUNT_HEADERS.indexOf('Role') + 1).setValue(newRole);
      migratedRoles++;
    }
  });
  if (migratedRoles) msg += '\n\nMapped ' + migratedRoles + ' existing account(s) onto the new Engineer/Sales/Manufacturing/Admin roles. IMPORTANT: role alone no longer grants review permission — anyone who used to review people by virtue of their old role (Manager/VP/CTO) needs to be explicitly set as a Key Objective\'s "Reports to" (or a per-employee override) in Manage Program, or they will not be able to review anyone until you do.';

  // Migration: give every non-Admin account without one a personal
  // career-development record, same as if they'd been created fresh — a
  // department role no longer determines whether someone gets a Track.
  accountObjs = sheetToObjects_(accounts, ACCOUNT_HEADERS); // re-read: roles above may have changed
  var migratedAccounts = 0;
  accountObjs.forEach(function (a, idx) {
    if (a.Role !== 'Admin' && !a.TraineeId) {
      var newTraineeId = newId_('t');
      trainees.appendRow([newTraineeId, a.Name, '', 'active', new Date(), 'setup() migration', defaultTrackId]);
      seedItemsForTrainee_(newTraineeId, defaultTrackId);
      accounts.getRange(idx + 2, ACCOUNT_HEADERS.indexOf('TraineeId') + 1).setValue(newTraineeId);
      migratedAccounts++;
    }
  });
  if (migratedAccounts) msg += '\n\nGave ' + migratedAccounts + ' existing account(s) a personal career-development record on the default track (they didn\'t have one before) — reassign them to the right Track from Manage Program\'s Employees & Tracks table if needed.';

  var existingAdmin = findAccountByUsername_('admin');
  if (!existingAdmin) {
    var tempPassword = makeTempPassword_();
    createAccountRow_({
      username: 'admin', name: 'Site Admin', role: 'Admin', traineeId: '', email: '',
      password: tempPassword, createdBy: 'setup()'
    });
    msg += '\n\nCreated the first admin account:\n  Username: admin\n  Password: ' + tempPassword +
      '\n\nLog in with this once, then use Manage Accounts in the site to create real accounts ' +
      '(including your own) and change this password — it is not shown again.';
  } else {
    msg += '\n\nAn admin account already exists; left it as-is.';
  }
  SpreadsheetApp.getUi().alert(msg);
}

function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  var firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var needsHeader = headers.some(function (h, i) { return firstRow[i] !== h; });
  if (needsHeader) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function makeTempPassword_() {
  var words = ['pipe', 'braid', 'cover', 'reel', 'swage', 'flange', 'taper', 'winder'];
  var w = words[Math.floor(Math.random() * words.length)];
  var n = Math.floor(1000 + Math.random() * 9000);
  return w + '-' + n;
}

/* ---------------- generic sheet helpers ---------------- */

function sheetToObjects_(sheet, headers) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values
    .filter(function (r) { return r[0] !== ''; })
    .map(function (r) {
      var o = {};
      headers.forEach(function (h, i) { o[h] = r[i]; });
      return o;
    });
}

function findRowIndex_(sheet, headers, colName, value) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var col = headers.indexOf(colName) + 1;
  var values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(value)) return i + 2;
  }
  return -1;
}

function deleteRowsWhere_(sheet, headers, predicate) {
  var rows = sheetToObjects_(sheet, headers);
  // Walk bottom-up so deleting a row doesn't shift the index of rows not yet visited.
  for (var i = rows.length - 1; i >= 0; i--) {
    if (predicate(rows[i])) sheet.deleteRow(i + 2);
  }
}

function newId_(prefix) {
  return prefix + '_' + new Date().getTime() + Math.random().toString(36).slice(2, 7);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- password / session helpers ---------------- */

function makeSalt_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function hashPassword_(password, salt) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(password) + ':' + salt);
  return digest.map(function (b) {
    var v = (b < 0 ? b + 256 : b);
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

function getAccountsSheet_() { return ensureSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_ACCOUNTS, ACCOUNT_HEADERS); }
function getSessionsSheet_() { return ensureSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_SESSIONS, SESSION_HEADERS); }
function getTraineesSheet_() { return ensureSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_TRAINEES, TRAINEE_HEADERS); }
function getItemsSheet_() { return ensureSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_ITEMS, ITEM_HEADERS); }
function getPhasesSheet_() { return ensureSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_PHASES, PHASE_HEADERS); }
function getItemDefsSheet_() { return ensureSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_ITEMDEFS, ITEMDEF_HEADERS); }
function getReviewersSheet_() { return ensureSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_REVIEWERS, REVIEWER_HEADERS); }
function getTracksSheet_() { return ensureSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_TRACKS, TRACK_HEADERS); }

function findAccountByUsername_(username) {
  var sheet = getAccountsSheet_();
  var rows = sheetToObjects_(sheet, ACCOUNT_HEADERS);
  var uname = String(username || '').trim().toLowerCase();
  return rows.filter(function (r) { return String(r.Username).toLowerCase() === uname; })[0] || null;
}

function findAccountById_(accountId) {
  var rows = sheetToObjects_(getAccountsSheet_(), ACCOUNT_HEADERS);
  return rows.filter(function (r) { return String(r.AccountId) === String(accountId); })[0] || null;
}

function createAccountRow_(opts) {
  var sheet = getAccountsSheet_();
  var salt = makeSalt_();
  var hash = hashPassword_(opts.password, salt);
  var accountId = newId_('acct');
  sheet.appendRow([
    accountId, opts.username, opts.name, opts.role, opts.traineeId || '', opts.email || '',
    hash, salt, true, new Date(), opts.createdBy || ''
  ]);
  return accountId;
}

function publicAccount_(acc) {
  return { accountId: acc.AccountId, username: acc.Username, name: acc.Name, role: acc.Role, traineeId: acc.TraineeId || '', email: acc.Email || '' };
}

function resolveSession_(token) {
  if (!token) return null;
  var sheet = getSessionsSheet_();
  var rows = sheetToObjects_(sheet, SESSION_HEADERS);
  var row = rows.filter(function (r) { return r.Token === token; })[0];
  if (!row) return null;
  if (new Date(row.ExpiresAt).getTime() < Date.now()) return null;
  var accounts = sheetToObjects_(getAccountsSheet_(), ACCOUNT_HEADERS);
  var acc = accounts.filter(function (a) { return a.AccountId === row.AccountId; })[0];
  if (!acc || acc.Active === false) return null;
  return acc;
}

function requireAuth_(body) {
  var acc = resolveSession_(body.token);
  if (!acc) { var e = new Error('Not signed in'); e.authError = true; throw e; }
  return acc;
}

function requireAdmin_(acc) {
  if (acc.Role !== 'Admin') { var e = new Error('Admin only'); e.authError = true; throw e; }
}

/* ---------------- program config: tracks, phases & item defs ---------------- */

function tracksList_() {
  return sheetToObjects_(getTracksSheet_(), TRACK_HEADERS).map(function (t) {
    return { id: t.TrackId, name: t.Name, description: t.Description };
  });
}

// Key Objectives, optionally filtered to one Track. Pass no trackId to get
// every objective across every Track (used by the admin Manage Program view).
function phasesList_(trackId) {
  var rows = sheetToObjects_(getPhasesSheet_(), PHASE_HEADERS);
  if (trackId) rows = rows.filter(function (p) { return String(p.TrackId) === String(trackId); });
  return rows
    .sort(function (a, b) { return (a.Order || 0) - (b.Order || 0); })
    .map(function (p) {
      return {
        id: p.PhaseId, trackId: p.TrackId, tag: p.Tag, title: p.Title, range: p.RangeLabel, location: p.Location,
        reporting: p.ReportingLabel, output: p.Output, objective: p.ObjectiveText, order: p.Order
      };
    });
}

// The Key Objectives visible to one specific employee: only the ones on
// their own Track.
function phasesForTrainee_(traineeId) {
  var t = sheetToObjects_(getTraineesSheet_(), TRAINEE_HEADERS).filter(function (x) { return String(x.TraineeId) === String(traineeId); })[0];
  return phasesList_(t ? t.TrackId : '');
}

function itemDefsList_() {
  return sheetToObjects_(getItemDefsSheet_(), ITEMDEF_HEADERS)
    .sort(function (a, b) { return (a.Order || 0) - (b.Order || 0); });
}

/* ---------------- review hierarchy ---------------- */

function reviewerAssignments_() {
  return sheetToObjects_(getReviewersSheet_(), REVIEWER_HEADERS);
}

// Reviewer account ids for a phase, resolved for a specific employee:
// a per-employee override for that phase wins if any exist, otherwise the
// program-wide default (TraineeId blank) for that phase, otherwise [] (no
// hierarchy configured — caller should fall back to legacy role check).
function reviewerIdsForPhase_(phaseId, traineeId) {
  var rows = reviewerAssignments_();
  var overrides = rows.filter(function (r) { return String(r.PhaseId) === String(phaseId) && r.TraineeId && String(r.TraineeId) === String(traineeId); });
  var defaults = rows.filter(function (r) { return String(r.PhaseId) === String(phaseId) && !r.TraineeId; });
  var chosen = overrides.length ? overrides : defaults;
  return chosen.map(function (r) { return r.ReviewerAccountId; });
}

// Review permission is fully explicit now — Admin aside, nothing falls
// back to a role check. If a Key Objective has no "Reports to" set and no
// per-employee override, nobody but Admin can review it yet.
function canReview_(acc, phaseId, traineeId) {
  if (acc.Role === 'Admin') return true;
  var ids = reviewerIdsForPhase_(phaseId, traineeId);
  return ids.indexOf(acc.AccountId) !== -1;
}

function requireReviewer_(acc, phaseId, traineeId) {
  if (!canReview_(acc, phaseId, traineeId)) { var e = new Error('You are not a reviewer for this Key Objective'); e.authError = true; throw e; }
}

// True if `acc` manages `traineeId` in some capacity — a reviewer on at
// least one of their Key Objectives. Admin always qualifies. Used to gate
// things like editing an employee's name/start date.
function isManagerOf_(acc, traineeId) {
  if (acc.Role === 'Admin') return true;
  return phasesForTrainee_(traineeId).some(function (p) { return canReview_(acc, p.id, traineeId); });
}

function requireManagerOf_(acc, traineeId) {
  if (!isManagerOf_(acc, traineeId)) { var e = new Error('Not authorized'); e.authError = true; throw e; }
}

// Every employee `acc` is allowed to see in the Team Roster: Admin sees
// everyone; anyone else sees only the employees they manage (see
// isManagerOf_). This is what makes "certain people report to him" a real
// visibility boundary, not just a review-button gate.
function visibleTraineesFor_(acc) {
  var all = sheetToObjects_(getTraineesSheet_(), TRAINEE_HEADERS);
  if (acc.Role === 'Admin') return all;
  return all.filter(function (t) { return isManagerOf_(acc, t.TraineeId); });
}

// Resolved reviewers for every phase, for one employee — used by the front
// end to show "Reviewed by" and to gate action buttons in the UI. Falls
// back to listing Admin accounts when nothing is configured yet, so the
// "who reviews this" display is never silently empty.
// `phases` should be that employee's own Track's objectives (phasesForTrainee_);
// defaults to every objective across every Track if omitted.
function reviewersByPhaseFor_(traineeId, phases) {
  var accountsById = {};
  sheetToObjects_(getAccountsSheet_(), ACCOUNT_HEADERS).forEach(function (a) { accountsById[a.AccountId] = a; });
  var out = {};
  (phases || phasesList_()).forEach(function (p) {
    var ids = reviewerIdsForPhase_(p.id, traineeId);
    var usingDefault = ids.length === 0;
    var list;
    if (usingDefault) {
      list = sheetToObjects_(getAccountsSheet_(), ACCOUNT_HEADERS)
        .filter(function (a) { return a.Role === 'Admin'; });
    } else {
      list = ids.map(function (id) { return accountsById[id]; }).filter(Boolean);
    }
    out[p.id] = list.map(function (a) { return { accountId: a.AccountId, name: a.Name, role: a.Role }; });
  });
  return out;
}

/* ---------------- trainees & items ---------------- */

function seedItemsForTrainee_(traineeId, trackId) {
  var sheet = getItemsSheet_();
  var phaseIds = phasesList_(trackId).map(function (p) { return p.id; });
  var defs = itemDefsList_().filter(function (d) { return phaseIds.indexOf(d.Phase) !== -1; });
  var rows = defs.map(function (d) {
    return [traineeId, d.ItemId, d.Phase, d.Kind, d.Order, d.Text, 'open', '', '', '', '', '', '', '', ''];
  });
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, ITEM_HEADERS.length).setValues(rows);
}

function itemsForTrainee_(traineeId) {
  return sheetToObjects_(getItemsSheet_(), ITEM_HEADERS).filter(function (r) { return String(r.TraineeId) === String(traineeId); });
}

function findItemRow_(sheet, traineeId, itemId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues(); // TraineeId, ItemId
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(traineeId) && String(values[i][1]) === String(itemId)) return i + 2;
  }
  return -1;
}

function readItemRow_(sheet, row) {
  var values = sheet.getRange(row, 1, 1, ITEM_HEADERS.length).getValues()[0];
  var o = {};
  ITEM_HEADERS.forEach(function (h, i) { o[h] = values[i]; });
  return o;
}

function writeItemRow_(sheet, row, patch) {
  var current = readItemRow_(sheet, row);
  var merged = Object.assign(current, patch);
  var values = ITEM_HEADERS.map(function (h) { return merged[h]; });
  sheet.getRange(row, 1, 1, ITEM_HEADERS.length).setValues([values]);
  return merged;
}

function traineeCounts_(traineeId) {
  var items = itemsForTrainee_(traineeId);
  var approved = 0, submitted = 0;
  items.forEach(function (it) { if (it.Status === 'approved') approved++; if (it.Status === 'submitted') submitted++; });
  return { total: items.length, approved: approved, submitted: submitted };
}

function rosterList_(trainees) {
  trainees = trainees || sheetToObjects_(getTraineesSheet_(), TRAINEE_HEADERS);
  var trackNameById = {};
  sheetToObjects_(getTracksSheet_(), TRACK_HEADERS).forEach(function (t) { trackNameById[t.TrackId] = t.Name; });
  return trainees.map(function (t) {
    var c = traineeCounts_(t.TraineeId);
    return {
      traineeId: t.TraineeId, name: t.Name, startDate: t.StartDate, status: t.Status,
      trackId: t.TrackId || '', trackName: trackNameById[t.TrackId] || '',
      total: c.total, approved: c.approved, submitted: c.submitted
    };
  });
}

/* ---------------- email ---------------- */

function maybeEmail_(addresses, subject, body) {
  (addresses || []).filter(Boolean).forEach(function (addr) {
    try { MailApp.sendEmail(addr, subject, body); } catch (e) { /* bad address, skip */ }
  });
}

function itemLookup_(itemId) {
  var def = itemDefsList_().filter(function (d) { return d.ItemId === itemId; })[0];
  return def ? def.Text : itemId;
}

function traineeAccountEmails_(traineeId) {
  var accounts = sheetToObjects_(getAccountsSheet_(), ACCOUNT_HEADERS);
  return accounts
    .filter(function (a) { return String(a.TraineeId) === String(traineeId) && a.TraineeId && a.Email; })
    .map(function (a) { return a.Email; });
}

function appendHistory_(traineeId, itemId, phase, action, actorName, actorRole, detail) {
  var sheet = ensureSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_HISTORY, HISTORY_HEADERS);
  sheet.appendRow([newId_('h'), traineeId, itemId, phase, action, actorName, actorRole, new Date(), detail || '']);
}

/* ---------------- HTTP entry points ---------------- */

function doGet(e) {
  try {
    var acc = resolveSession_(e.parameter.token);
    if (!acc) return json_({ ok: false, error: 'auth', code: 'session_invalid' });

    if (acc.Role === 'Trainee') {
      var trainee = sheetToObjects_(getTraineesSheet_(), TRAINEE_HEADERS).filter(function (t) { return String(t.TraineeId) === String(acc.TraineeId); })[0];
      var myPhases = phasesForTrainee_(acc.TraineeId);
      return json_({
        ok: true, mode: 'trainee', account: publicAccount_(acc),
        trainee: trainee ? { traineeId: trainee.TraineeId, name: trainee.Name, startDate: trainee.StartDate, trackId: trainee.TrackId || '' } : null,
        items: itemsForTrainee_(acc.TraineeId),
        phases: myPhases,
        reviewersByPhase: reviewersByPhaseFor_(acc.TraineeId, myPhases)
      });
    }

    var requestedTraineeId = e.parameter.traineeId;
    if (requestedTraineeId) {
      var t2 = sheetToObjects_(getTraineesSheet_(), TRAINEE_HEADERS).filter(function (t) { return String(t.TraineeId) === String(requestedTraineeId); })[0];
      if (!t2) return json_({ ok: false, error: 'Unknown employee' });
      var theirPhases = phasesForTrainee_(requestedTraineeId);
      // A non-Trainee-role account (Manager, VP, etc.) can also have a
      // personal Track of their own now; when they drill into themselves
      // from the roster, isOwn lets the front end treat it like the
      // 'trainee' mode above (they can submit/withdraw their own items).
      return json_({
        ok: true, mode: 'detail', account: publicAccount_(acc),
        isOwn: !!acc.TraineeId && String(requestedTraineeId) === String(acc.TraineeId),
        trainee: { traineeId: t2.TraineeId, name: t2.Name, startDate: t2.StartDate, trackId: t2.TrackId || '' },
        items: itemsForTrainee_(requestedTraineeId),
        phases: theirPhases,
        reviewersByPhase: reviewersByPhaseFor_(requestedTraineeId, theirPhases)
      });
    }

    return json_({ ok: true, mode: 'roster', account: publicAccount_(acc), trainees: rosterList_(visibleTraineesFor_(acc)), phases: phasesList_() });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Bad request body' });
  }

  if (body.action === 'login') return handleLogin_(body);

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var acc = requireAuth_(body);
    switch (body.action) {
      case 'markDone': return handleMarkDone_(acc, body);
      case 'markComplete': return handleMarkComplete_(acc, body);
      case 'withdraw': return handleWithdraw_(acc, body);
      case 'approve': return handleApprove_(acc, body);
      case 'requestChanges': return handleRequestChanges_(acc, body);
      case 'updateTraineeMeta': return handleUpdateTraineeMeta_(acc, body);
      case 'changePassword': return handleChangePassword_(acc, body);
      case 'listAccounts': return handleListAccounts_(acc, body);
      case 'createAccount': return handleCreateAccount_(acc, body);
      case 'resetPassword': return handleResetPassword_(acc, body);
      case 'setAccountActive': return handleSetAccountActive_(acc, body);
      case 'updateAccount': return handleUpdateAccount_(acc, body);
      case 'deleteAccount': return handleDeleteAccount_(acc, body);
      case 'listProgram': return handleListProgram_(acc, body);
      case 'createPhase': return handleCreatePhase_(acc, body);
      case 'updatePhase': return handleUpdatePhase_(acc, body);
      case 'deletePhase': return handleDeletePhase_(acc, body);
      case 'createItemDef': return handleCreateItemDef_(acc, body);
      case 'updateItemDef': return handleUpdateItemDef_(acc, body);
      case 'deleteItemDef': return handleDeleteItemDef_(acc, body);
      case 'setReviewerAssignment': return handleSetReviewerAssignment_(acc, body);
      case 'removeReviewerAssignment': return handleRemoveReviewerAssignment_(acc, body);
      case 'createTrack': return handleCreateTrack_(acc, body);
      case 'updateTrack': return handleUpdateTrack_(acc, body);
      case 'deleteTrack': return handleDeleteTrack_(acc, body);
      case 'setTraineeTrack': return handleSetTraineeTrack_(acc, body);
      default: return json_({ ok: false, error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    if (err && err.authError) return json_({ ok: false, error: 'auth', code: 'session_invalid' });
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- auth actions ---------------- */

function handleLogin_(body) {
  var acc = findAccountByUsername_(body.username);
  if (!acc || acc.Active === false) return json_({ ok: false, error: 'Invalid username or password' });
  var hash = hashPassword_(body.password, acc.PasswordSalt);
  if (hash !== acc.PasswordHash) return json_({ ok: false, error: 'Invalid username or password' });

  var token = Utilities.getUuid();
  var expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  getSessionsSheet_().appendRow([token, acc.AccountId, new Date(), expires]);

  return json_({ ok: true, token: token, account: publicAccount_(acc) });
}

function handleChangePassword_(acc, body) {
  var hash = hashPassword_(body.oldPassword, acc.PasswordSalt);
  if (hash !== acc.PasswordHash) return json_({ ok: false, error: 'Current password is incorrect' });
  if (!body.newPassword || String(body.newPassword).length < 6) return json_({ ok: false, error: 'New password must be at least 6 characters' });

  var sheet = getAccountsSheet_();
  var row = findRowIndex_(sheet, ACCOUNT_HEADERS, 'AccountId', acc.AccountId);
  var salt = makeSalt_();
  var newHash = hashPassword_(body.newPassword, salt);
  sheet.getRange(row, ACCOUNT_HEADERS.indexOf('PasswordHash') + 1).setValue(newHash);
  sheet.getRange(row, ACCOUNT_HEADERS.indexOf('PasswordSalt') + 1).setValue(salt);
  return json_({ ok: true });
}

/* ---------------- admin actions: accounts ---------------- */

function handleListAccounts_(acc, body) {
  requireAdmin_(acc);
  var accounts = sheetToObjects_(getAccountsSheet_(), ACCOUNT_HEADERS).map(publicAccount_);
  var trainees = sheetToObjects_(getTraineesSheet_(), TRAINEE_HEADERS);
  return json_({ ok: true, accounts: accounts, trainees: trainees, tracks: tracksList_() });
}

function handleCreateAccount_(acc, body) {
  requireAdmin_(acc);
  var username = String(body.username || '').trim();
  var role = body.role;
  if (!username) return json_({ ok: false, error: 'Username is required' });
  if (!body.name) return json_({ ok: false, error: 'Name is required' });
  if (ROLES.indexOf(role) === -1) return json_({ ok: false, error: 'Invalid role' });
  if (!body.password || String(body.password).length < 6) return json_({ ok: false, error: 'Password must be at least 6 characters' });
  if (findAccountByUsername_(username)) return json_({ ok: false, error: 'That username is already taken' });

  // Every non-Admin account gets their own career-development record —
  // this isn't reserved for the "Trainee" role label any more. A Manager
  // or VP has their own Track too, reviewed by whoever's above them.
  var traineeId = '';
  if (role !== 'Admin') {
    var trackId = String(body.trackId || '').trim();
    if (!trackId || findRowIndex_(getTracksSheet_(), TRACK_HEADERS, 'TrackId', trackId) < 0) return json_({ ok: false, error: 'Choose a valid Track for this employee' });
    traineeId = newId_('t');
    getTraineesSheet_().appendRow([traineeId, body.name, body.startDate || '', 'active', new Date(), acc.Name, trackId]);
    seedItemsForTrainee_(traineeId, trackId);
  }

  var accountId = createAccountRow_({
    username: username, name: body.name, role: role, traineeId: traineeId, email: body.email || '',
    password: body.password, createdBy: acc.Name
  });

  return json_({ ok: true, accountId: accountId, traineeId: traineeId });
}

function handleResetPassword_(acc, body) {
  requireAdmin_(acc);
  if (!body.newPassword || String(body.newPassword).length < 6) return json_({ ok: false, error: 'Password must be at least 6 characters' });
  var sheet = getAccountsSheet_();
  var row = findRowIndex_(sheet, ACCOUNT_HEADERS, 'AccountId', body.accountId);
  if (row < 0) return json_({ ok: false, error: 'Unknown account' });
  var salt = makeSalt_();
  var hash = hashPassword_(body.newPassword, salt);
  sheet.getRange(row, ACCOUNT_HEADERS.indexOf('PasswordHash') + 1).setValue(hash);
  sheet.getRange(row, ACCOUNT_HEADERS.indexOf('PasswordSalt') + 1).setValue(salt);
  return json_({ ok: true });
}

function handleSetAccountActive_(acc, body) {
  requireAdmin_(acc);
  var sheet = getAccountsSheet_();
  var row = findRowIndex_(sheet, ACCOUNT_HEADERS, 'AccountId', body.accountId);
  if (row < 0) return json_({ ok: false, error: 'Unknown account' });
  sheet.getRange(row, ACCOUNT_HEADERS.indexOf('Active') + 1).setValue(!!body.active);
  return json_({ ok: true });
}

function handleUpdateAccount_(acc, body) {
  requireAdmin_(acc);
  var sheet = getAccountsSheet_();
  var row = findRowIndex_(sheet, ACCOUNT_HEADERS, 'AccountId', body.accountId);
  if (row < 0) return json_({ ok: false, error: 'Unknown account' });
  var current = sheetToObjects_(sheet, ACCOUNT_HEADERS).filter(function (a) { return a.AccountId === body.accountId; })[0];

  if (body.username !== undefined) {
    var newUsername = String(body.username).trim();
    if (!newUsername) return json_({ ok: false, error: 'Username is required' });
    var existing = findAccountByUsername_(newUsername);
    if (existing && existing.AccountId !== body.accountId) return json_({ ok: false, error: 'That username is already taken' });
    sheet.getRange(row, ACCOUNT_HEADERS.indexOf('Username') + 1).setValue(newUsername);
  }
  if (body.name !== undefined) {
    var newName = String(body.name).trim();
    if (!newName) return json_({ ok: false, error: 'Name is required' });
    sheet.getRange(row, ACCOUNT_HEADERS.indexOf('Name') + 1).setValue(newName);
    // Keep the linked Trainee record's display name in sync — the roster
    // reads Trainees.Name, not Accounts.Name.
    if (current.TraineeId) {
      var traineeRow = findRowIndex_(getTraineesSheet_(), TRAINEE_HEADERS, 'TraineeId', current.TraineeId);
      if (traineeRow >= 0) getTraineesSheet_().getRange(traineeRow, TRAINEE_HEADERS.indexOf('Name') + 1).setValue(newName);
    }
  }
  if (body.email !== undefined) {
    sheet.getRange(row, ACCOUNT_HEADERS.indexOf('Email') + 1).setValue(body.email);
  }

  // Assigning a Track here works for any non-Admin account, including one
  // created before Tracks existed (or before every role got a personal
  // checklist) — it creates the Trainee record on the spot if missing.
  if (body.trackId) {
    if (findRowIndex_(getTracksSheet_(), TRACK_HEADERS, 'TrackId', body.trackId) < 0) return json_({ ok: false, error: 'Unknown track' });
    if (current.TraineeId) {
      assignTraineeTrack_(current.TraineeId, body.trackId);
    } else {
      var traineeId = newId_('t');
      var traineeName = body.name !== undefined ? String(body.name).trim() : current.Name;
      getTraineesSheet_().appendRow([traineeId, traineeName, '', 'active', new Date(), acc.Name, body.trackId]);
      seedItemsForTrainee_(traineeId, body.trackId);
      sheet.getRange(row, ACCOUNT_HEADERS.indexOf('TraineeId') + 1).setValue(traineeId);
    }
  }

  return json_({ ok: true });
}

function handleDeleteAccount_(acc, body) {
  requireAdmin_(acc);
  if (String(body.accountId) === String(acc.AccountId)) return json_({ ok: false, error: 'You cannot delete your own account' });
  var row = findRowIndex_(getAccountsSheet_(), ACCOUNT_HEADERS, 'AccountId', body.accountId);
  if (row < 0) return json_({ ok: false, error: 'Unknown account' });
  // Deletes the login only — their Trainee/Items history (if any) stays on
  // the roster; an admin can hand it to a new account later if needed.
  getAccountsSheet_().deleteRow(row);
  deleteRowsWhere_(getSessionsSheet_(), SESSION_HEADERS, function (s) { return String(s.AccountId) === String(body.accountId); });
  return json_({ ok: true });
}

/* ---------------- admin actions: program (Key Objectives / items / hierarchy) ---------------- */

function handleListProgram_(acc, body) {
  requireAdmin_(acc);
  var accounts = sheetToObjects_(getAccountsSheet_(), ACCOUNT_HEADERS).map(publicAccount_);
  var trainees = sheetToObjects_(getTraineesSheet_(), TRAINEE_HEADERS);
  return json_({
    ok: true,
    tracks: tracksList_(),
    phases: phasesList_(),
    itemDefs: itemDefsList_(),
    reviewerAssignments: reviewerAssignments_(),
    accounts: accounts,
    trainees: trainees
  });
}

function handleCreateTrack_(acc, body) {
  requireAdmin_(acc);
  var name = String(body.name || '').trim();
  if (!name) return json_({ ok: false, error: 'Name is required' });
  var id = body.trackId ? String(body.trackId) : newId_('track');
  if (findRowIndex_(getTracksSheet_(), TRACK_HEADERS, 'TrackId', id) >= 0) return json_({ ok: false, error: 'That Track ID is already used' });
  getTracksSheet_().appendRow([id, name, body.description || '', new Date(), acc.Name]);
  return json_({ ok: true, trackId: id });
}

function handleUpdateTrack_(acc, body) {
  requireAdmin_(acc);
  var sheet = getTracksSheet_();
  var row = findRowIndex_(sheet, TRACK_HEADERS, 'TrackId', body.trackId);
  if (row < 0) return json_({ ok: false, error: 'Unknown track' });
  if (body.name !== undefined) sheet.getRange(row, TRACK_HEADERS.indexOf('Name') + 1).setValue(body.name);
  if (body.description !== undefined) sheet.getRange(row, TRACK_HEADERS.indexOf('Description') + 1).setValue(body.description);
  return json_({ ok: true });
}

function handleDeleteTrack_(acc, body) {
  requireAdmin_(acc);
  var trackId = body.trackId;
  var row = findRowIndex_(getTracksSheet_(), TRACK_HEADERS, 'TrackId', trackId);
  if (row < 0) return json_({ ok: false, error: 'Unknown track' });
  if (phasesList_(trackId).length) return json_({ ok: false, error: 'Move or delete this track\'s Key Objectives first' });
  var traineesOnTrack = sheetToObjects_(getTraineesSheet_(), TRAINEE_HEADERS).filter(function (t) { return String(t.TrackId) === String(trackId); });
  if (traineesOnTrack.length) return json_({ ok: false, error: 'Reassign employees off this track first' });
  getTracksSheet_().deleteRow(row);
  return json_({ ok: true });
}

// Move an employee onto a different Track. Their existing checklist history
// is left alone (it just stops being shown, since the front end only
// renders the objectives on the employee's current Track); any objectives
// on the new Track they don't already have an item row for are seeded in
// as 'open', same as a brand-new employee on that Track. Shared by
// handleSetTraineeTrack_ and handleUpdateAccount_ (assigning a Track to an
// account that didn't have one before creates the Trainee row first).
function assignTraineeTrack_(traineeId, trackId) {
  var sheet = getTraineesSheet_();
  var row = findRowIndex_(sheet, TRAINEE_HEADERS, 'TraineeId', traineeId);
  if (row < 0) return;
  sheet.getRange(row, TRAINEE_HEADERS.indexOf('TrackId') + 1).setValue(trackId);

  var existingItemIds = {};
  itemsForTrainee_(traineeId).forEach(function (it) { existingItemIds[it.ItemId] = true; });
  var phaseIds = phasesList_(trackId).map(function (p) { return p.id; });
  var defs = itemDefsList_().filter(function (d) { return phaseIds.indexOf(d.Phase) !== -1 && !existingItemIds[d.ItemId]; });
  var rows = defs.map(function (d) {
    return [traineeId, d.ItemId, d.Phase, d.Kind, d.Order, d.Text, 'open', '', '', '', '', '', '', '', ''];
  });
  if (rows.length) {
    var itemsSheet = getItemsSheet_();
    itemsSheet.getRange(itemsSheet.getLastRow() + 1, 1, rows.length, ITEM_HEADERS.length).setValues(rows);
  }
}

function handleSetTraineeTrack_(acc, body) {
  requireAdmin_(acc);
  if (findRowIndex_(getTraineesSheet_(), TRAINEE_HEADERS, 'TraineeId', body.traineeId) < 0) return json_({ ok: false, error: 'Unknown employee' });
  if (findRowIndex_(getTracksSheet_(), TRACK_HEADERS, 'TrackId', body.trackId) < 0) return json_({ ok: false, error: 'Unknown track' });
  assignTraineeTrack_(body.traineeId, body.trackId);
  return json_({ ok: true });
}

// The "Reports to" shown on a Key Objective is now a real multi-account
// picker, not free text — this is the display string derived from it.
function reportingLabelFor_(reviewerAccountIds) {
  var accountsById = {};
  sheetToObjects_(getAccountsSheet_(), ACCOUNT_HEADERS).forEach(function (a) { accountsById[a.AccountId] = a; });
  return (reviewerAccountIds || []).map(function (id) { var a = accountsById[id]; return a ? a.Name : id; }).join(', ');
}

// Replaces a Key Objective's program-wide default reviewers (the ones with
// no TraineeId) with exactly this set of accounts. Per-employee overrides
// are untouched.
function replacePhaseDefaultReviewers_(phaseId, reviewerAccountIds, actorName) {
  deleteRowsWhere_(getReviewersSheet_(), REVIEWER_HEADERS, function (r) { return String(r.PhaseId) === String(phaseId) && !r.TraineeId; });
  (reviewerAccountIds || []).forEach(function (id) {
    getReviewersSheet_().appendRow([newId_('rev'), phaseId, '', id, new Date(), actorName]);
  });
}

function handleCreatePhase_(acc, body) {
  requireAdmin_(acc);
  var title = String(body.title || '').trim();
  if (!title) return json_({ ok: false, error: 'Title is required' });
  var trackId = String(body.trackId || '').trim();
  if (!trackId || findRowIndex_(getTracksSheet_(), TRACK_HEADERS, 'TrackId', trackId) < 0) return json_({ ok: false, error: 'Choose a valid Track' });
  var id = body.phaseId ? String(body.phaseId) : newId_('phase');
  if (findRowIndex_(getPhasesSheet_(), PHASE_HEADERS, 'PhaseId', id) >= 0) return json_({ ok: false, error: 'That Key Objective ID is already used' });
  var existing = phasesList_(trackId);
  var order = body.order !== undefined ? body.order : (existing.length ? Math.max.apply(null, existing.map(function (p) { return Number(p.order) || 0; })) + 1 : 1);
  var reviewerAccountIds = Array.isArray(body.reviewerAccountIds) ? body.reviewerAccountIds : [];
  getPhasesSheet_().appendRow([
    id, body.tag || title.slice(0, 3).toUpperCase(), title, body.range || '', body.location || '',
    reportingLabelFor_(reviewerAccountIds), body.output || '', body.objective || '', order, trackId
  ]);
  replacePhaseDefaultReviewers_(id, reviewerAccountIds, acc.Name);
  return json_({ ok: true, phaseId: id });
}

function handleUpdatePhase_(acc, body) {
  requireAdmin_(acc);
  var sheet = getPhasesSheet_();
  var row = findRowIndex_(sheet, PHASE_HEADERS, 'PhaseId', body.phaseId);
  if (row < 0) return json_({ ok: false, error: 'Unknown Key Objective' });
  if (body.trackId !== undefined) {
    if (findRowIndex_(getTracksSheet_(), TRACK_HEADERS, 'TrackId', body.trackId) < 0) return json_({ ok: false, error: 'Unknown track' });
    sheet.getRange(row, PHASE_HEADERS.indexOf('TrackId') + 1).setValue(body.trackId);
  }
  if (Array.isArray(body.reviewerAccountIds)) {
    replacePhaseDefaultReviewers_(body.phaseId, body.reviewerAccountIds, acc.Name);
    sheet.getRange(row, PHASE_HEADERS.indexOf('ReportingLabel') + 1).setValue(reportingLabelFor_(body.reviewerAccountIds));
  }
  var fieldMap = { tag: 'Tag', title: 'Title', range: 'RangeLabel', location: 'Location', output: 'Output', objective: 'ObjectiveText', order: 'Order' };
  Object.keys(fieldMap).forEach(function (k) {
    if (body[k] !== undefined) sheet.getRange(row, PHASE_HEADERS.indexOf(fieldMap[k]) + 1).setValue(body[k]);
  });
  return json_({ ok: true });
}

function handleDeletePhase_(acc, body) {
  requireAdmin_(acc);
  var phaseId = body.phaseId;
  var row = findRowIndex_(getPhasesSheet_(), PHASE_HEADERS, 'PhaseId', phaseId);
  if (row < 0) return json_({ ok: false, error: 'Unknown Key Objective' });
  getPhasesSheet_().deleteRow(row);
  // Cascade: remove this objective's checklist items (definitions + every
  // employee's instances) and any reviewer assignments for it.
  deleteRowsWhere_(getItemDefsSheet_(), ITEMDEF_HEADERS, function (d) { return String(d.Phase) === String(phaseId); });
  deleteRowsWhere_(getItemsSheet_(), ITEM_HEADERS, function (it) { return String(it.Phase) === String(phaseId); });
  deleteRowsWhere_(getReviewersSheet_(), REVIEWER_HEADERS, function (r) { return String(r.PhaseId) === String(phaseId); });
  return json_({ ok: true });
}

function handleCreateItemDef_(acc, body) {
  requireAdmin_(acc);
  var phase = body.phase;
  var kind = body.kind;
  var text = String(body.text || '').trim();
  var phaseRow = findRowIndex_(getPhasesSheet_(), PHASE_HEADERS, 'PhaseId', phase);
  if (!phase || phaseRow < 0) return json_({ ok: false, error: 'Unknown Key Objective' });
  if (!text) return json_({ ok: false, error: 'Description is required' });
  if (['activity', 'criterion'].indexOf(kind) === -1) return json_({ ok: false, error: 'Invalid kind' });

  var phaseTrackId = getPhasesSheet_().getRange(phaseRow, PHASE_HEADERS.indexOf('TrackId') + 1).getValue();

  var id = body.itemId ? String(body.itemId) : newId_('item');
  var existing = itemDefsList_().filter(function (d) { return d.Phase === phase; });
  var order = body.order !== undefined ? body.order : (existing.length ? Math.max.apply(null, existing.map(function (d) { return Number(d.Order) || 0; })) + 1 : 1);

  getItemDefsSheet_().appendRow([id, phase, kind, text, order]);

  // Add this item to the checklist of every existing employee on this
  // objective's Track (not everyone) so it shows up immediately without
  // them having to be re-seeded.
  var trainees = sheetToObjects_(getTraineesSheet_(), TRAINEE_HEADERS).filter(function (t) { return String(t.TrackId) === String(phaseTrackId); });
  var itemsSheet = getItemsSheet_();
  var rows = trainees.map(function (t) {
    return [t.TraineeId, id, phase, kind, order, text, 'open', '', '', '', '', '', '', '', ''];
  });
  if (rows.length) itemsSheet.getRange(itemsSheet.getLastRow() + 1, 1, rows.length, ITEM_HEADERS.length).setValues(rows);

  return json_({ ok: true, itemId: id });
}

function handleUpdateItemDef_(acc, body) {
  requireAdmin_(acc);
  var sheet = getItemDefsSheet_();
  var row = findRowIndex_(sheet, ITEMDEF_HEADERS, 'ItemId', body.itemId);
  if (row < 0) return json_({ ok: false, error: 'Unknown checklist item' });

  var patch = {};
  ['phase:Phase', 'kind:Kind', 'text:Text', 'order:Order'].forEach(function (pair) {
    var parts = pair.split(':'); var bodyKey = parts[0], col = parts[1];
    if (body[bodyKey] !== undefined) {
      sheet.getRange(row, ITEMDEF_HEADERS.indexOf(col) + 1).setValue(body[bodyKey]);
      patch[col] = body[bodyKey];
    }
  });

  // Keep every employee's already-seeded copy of this item in sync so
  // wording/grouping edits don't silently diverge from the definition.
  if (Object.keys(patch).length) {
    var itemsSheet = getItemsSheet_();
    var allItems = sheetToObjects_(itemsSheet, ITEM_HEADERS);
    for (var i = allItems.length - 1; i >= 0; i--) {
      if (allItems[i].ItemId === body.itemId) {
        var rowNum = i + 2;
        Object.keys(patch).forEach(function (col) {
          itemsSheet.getRange(rowNum, ITEM_HEADERS.indexOf(col) + 1).setValue(patch[col]);
        });
      }
    }
  }
  return json_({ ok: true });
}

function handleDeleteItemDef_(acc, body) {
  requireAdmin_(acc);
  var row = findRowIndex_(getItemDefsSheet_(), ITEMDEF_HEADERS, 'ItemId', body.itemId);
  if (row < 0) return json_({ ok: false, error: 'Unknown checklist item' });
  getItemDefsSheet_().deleteRow(row);
  deleteRowsWhere_(getItemsSheet_(), ITEM_HEADERS, function (it) { return it.ItemId === body.itemId; });
  return json_({ ok: true });
}

function handleSetReviewerAssignment_(acc, body) {
  requireAdmin_(acc);
  var phaseId = body.phaseId;
  var reviewerAccountId = body.reviewerAccountId;
  var traineeId = body.traineeId || '';
  if (findRowIndex_(getPhasesSheet_(), PHASE_HEADERS, 'PhaseId', phaseId) < 0) return json_({ ok: false, error: 'Unknown Key Objective' });
  if (!findAccountById_(reviewerAccountId)) return json_({ ok: false, error: 'Unknown reviewer account' });

  // Replace any existing assignment for this exact (phase, employee-or-default) pair.
  deleteRowsWhere_(getReviewersSheet_(), REVIEWER_HEADERS, function (r) {
    return String(r.PhaseId) === String(phaseId) && String(r.TraineeId || '') === String(traineeId) && String(r.ReviewerAccountId) === String(reviewerAccountId);
  });
  var id = newId_('rev');
  getReviewersSheet_().appendRow([id, phaseId, traineeId, reviewerAccountId, new Date(), acc.Name]);
  return json_({ ok: true, assignmentId: id });
}

function handleRemoveReviewerAssignment_(acc, body) {
  requireAdmin_(acc);
  var row = findRowIndex_(getReviewersSheet_(), REVIEWER_HEADERS, 'AssignmentId', body.assignmentId);
  if (row < 0) return json_({ ok: false, error: 'Unknown assignment' });
  getReviewersSheet_().deleteRow(row);
  return json_({ ok: true });
}

/* ---------------- employee/reviewer actions ---------------- */

function handleMarkDone_(acc, body) {
  if (!acc.TraineeId || String(acc.TraineeId) !== String(body.traineeId)) return json_({ ok: false, error: 'auth', code: 'forbidden' });
  var sheet = getItemsSheet_();
  var row = findItemRow_(sheet, body.traineeId, body.itemId);
  if (row < 0) return json_({ ok: false, error: 'Unknown item: ' + body.itemId });

  var updated = writeItemRow_(sheet, row, {
    Status: 'submitted', Note: body.note || '',
    SubmittedByName: acc.Name, SubmittedByRole: acc.Role, SubmittedAt: new Date(),
    ReviewedByName: '', ReviewedByRole: '', ReviewedAt: '', ReviewNote: ''
  });
  appendHistory_(body.traineeId, body.itemId, updated.Phase, 'submitted', acc.Name, acc.Role, body.note || '');

  maybeEmail_(NOTIFY_SUPERVISOR_EMAILS, '[CDP] ' + acc.Name + ' marked an item done — needs review',
    itemLookup_(body.itemId) + '\n\nSubmitted by: ' + acc.Name + (body.note ? '\nNote: ' + body.note : ''));

  return json_({ ok: true, item: updated });
}

// A reviewer completing an item directly — no employee submission first.
// Goes straight to 'approved' with the reviewer recorded as both the
// submitter and the reviewer, so the trace reads honestly (nobody but them
// vouched for it) rather than inventing a fake employee submission.
function handleMarkComplete_(acc, body) {
  var sheet = getItemsSheet_();
  var row = findItemRow_(sheet, body.traineeId, body.itemId);
  if (row < 0) return json_({ ok: false, error: 'Unknown item: ' + body.itemId });
  var current = readItemRow_(sheet, row);
  requireReviewer_(acc, current.Phase, body.traineeId);

  var now = new Date();
  var updated = writeItemRow_(sheet, row, {
    Status: 'approved', Note: body.note || '',
    SubmittedByName: acc.Name, SubmittedByRole: acc.Role, SubmittedAt: now,
    ReviewedByName: acc.Name, ReviewedByRole: acc.Role, ReviewedAt: now, ReviewNote: ''
  });
  appendHistory_(body.traineeId, body.itemId, updated.Phase, 'marked_complete_by_reviewer', acc.Name, acc.Role, body.note || '');

  maybeEmail_(traineeAccountEmails_(body.traineeId), '[CDP] Item marked complete',
    itemLookup_(body.itemId) + '\n\nMarked complete by: ' + acc.Name + ' (' + acc.Role + ')' + (body.note ? '\nNote: ' + body.note : ''));

  return json_({ ok: true, item: updated });
}

function handleWithdraw_(acc, body) {
  if (!acc.TraineeId || String(acc.TraineeId) !== String(body.traineeId)) return json_({ ok: false, error: 'auth', code: 'forbidden' });
  var sheet = getItemsSheet_();
  var row = findItemRow_(sheet, body.traineeId, body.itemId);
  if (row < 0) return json_({ ok: false, error: 'Unknown item: ' + body.itemId });

  var updated = writeItemRow_(sheet, row, { Status: 'open' });
  appendHistory_(body.traineeId, body.itemId, updated.Phase, 'withdrawn', acc.Name, acc.Role, '');
  return json_({ ok: true, item: updated });
}

function handleApprove_(acc, body) {
  var sheet = getItemsSheet_();
  var row = findItemRow_(sheet, body.traineeId, body.itemId);
  if (row < 0) return json_({ ok: false, error: 'Unknown item: ' + body.itemId });
  var current = readItemRow_(sheet, row);
  requireReviewer_(acc, current.Phase, body.traineeId);

  var updated = writeItemRow_(sheet, row, {
    Status: 'approved',
    ReviewedByName: acc.Name, ReviewedByRole: acc.Role, ReviewedAt: new Date(), ReviewNote: ''
  });
  appendHistory_(body.traineeId, body.itemId, updated.Phase, 'approved', acc.Name, acc.Role, '');

  maybeEmail_(traineeAccountEmails_(body.traineeId), '[CDP] Item approved',
    itemLookup_(body.itemId) + '\n\nApproved by: ' + acc.Name + ' (' + acc.Role + ')');

  return json_({ ok: true, item: updated });
}

function handleRequestChanges_(acc, body) {
  var reason = (body.reason || '').trim();
  if (!reason) return json_({ ok: false, error: 'A reason is required to request changes' });

  var sheet = getItemsSheet_();
  var row = findItemRow_(sheet, body.traineeId, body.itemId);
  if (row < 0) return json_({ ok: false, error: 'Unknown item: ' + body.itemId });
  var current = readItemRow_(sheet, row);
  requireReviewer_(acc, current.Phase, body.traineeId);

  var updated = writeItemRow_(sheet, row, {
    Status: 'changes',
    ReviewedByName: acc.Name, ReviewedByRole: acc.Role, ReviewedAt: new Date(), ReviewNote: reason
  });
  appendHistory_(body.traineeId, body.itemId, updated.Phase, 'changes_requested', acc.Name, acc.Role, reason);

  maybeEmail_(traineeAccountEmails_(body.traineeId), '[CDP] Changes requested',
    itemLookup_(body.itemId) + '\n\nRequested by: ' + acc.Name + ' (' + acc.Role + ')\nReason: ' + reason);

  return json_({ ok: true, item: updated });
}

function handleUpdateTraineeMeta_(acc, body) {
  requireManagerOf_(acc, body.traineeId);
  var sheet = getTraineesSheet_();
  var row = findRowIndex_(sheet, TRAINEE_HEADERS, 'TraineeId', body.traineeId);
  if (row < 0) return json_({ ok: false, error: 'Unknown employee' });
  if (body.name !== undefined) sheet.getRange(row, TRAINEE_HEADERS.indexOf('Name') + 1).setValue(body.name);
  if (body.startDate !== undefined) sheet.getRange(row, TRAINEE_HEADERS.indexOf('StartDate') + 1).setValue(body.startDate);
  var updated = sheetToObjects_(sheet, TRAINEE_HEADERS).filter(function (t) { return String(t.TraineeId) === String(body.traineeId); })[0];
  return json_({ ok: true, trainee: updated });
}
