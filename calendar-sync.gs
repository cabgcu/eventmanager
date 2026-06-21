// ================================================================
// Arts Events Manager — Google Calendar Sync
// ================================================================
//
// SETUP (one time):
//   1. Go to script.google.com → New Project → paste this file
//   2. Set CALENDAR_ID below (use 'primary' or paste a calendar ID)
//   3. Set YEAR to match the year you want to sync
//   4. Click Run → setupTriggers  (approve permissions when prompted)
//   5. Done — syncs every 10 minutes automatically
//
// To sync a different year: change YEAR and run fullSync() manually.
// To stop syncing: run removeTriggers().
// ================================================================

const CONFIG = {
  SUPABASE_URL: 'https://knlmtrzxtqcmgaydwzqz.supabase.co',
  SUPABASE_KEY: 'sb_publishable_9ROUJP2trRbgsbnrCB5K9g_KXSwis3O',
  CALENDAR_ID:  '9cca84e39c265f0d5a3fbec3c4002957a71c9e7e883b8fe0748f4d64b7bb390c@group.calendar.google.com',
  YEAR:         '2025-2026', // ← change to sync a different school year
  SYNC_INTERVAL_MINUTES: 10,
};

const MILESTONE_KEYS   = ['checklist', 'marketing', 'amazon', 'setlist', 'chalkboards', 'posters'];
const MILESTONE_LABELS = {
  checklist:   'Event Checklist',
  marketing:   'Marketing Req',
  amazon:      'Amazon',
  setlist:     'Setlist',
  chalkboards: 'Chalkboards',
  posters:     'Posters Up',
};
// Color shown on deadline events (green = completed, yellow = pending)
const COLOR_PENDING   = CalendarApp.EventColor.YELLOW;
const COLOR_COMPLETED = CalendarApp.EventColor.GREEN;

// ================================================================
// ENTRY POINTS
// ================================================================

// Main sync — called by the time trigger every 10 min
function sync() {
  syncFromCalendar(); // 1. pull Calendar changes → Supabase
  syncToCalendar();   // 2. push Supabase state  → Calendar
}

// Run this manually to do a full rebuild from scratch
function fullSync() {
  PropertiesService.getScriptProperties().deleteProperty('SYNC_MAP');
  sync();
}

// ================================================================
// SUPABASE → CALENDAR
// ================================================================

function syncToCalendar() {
  const cal    = getCalendar();
  const events = loadEventsFromSupabase();
  const map    = getMap();
  const active = new Set();

  events.forEach(ev => {
    // --- Main event ---
    if (ev.date) {
      const key = ev.id;
      active.add(key);
      upsertCalEvent(cal, map, key, {
        title:       ev.name,
        date:        ev.date,
        description: buildMainDesc(ev),
        color:       null,
      });
    }

    // --- Milestone deadlines ---
    MILESTONE_KEYS.forEach(mk => {
      const m = ev.deadlines?.[mk];
      if (!m || !m.date) return;
      const key = `${ev.id}_${mk}`;
      active.add(key);
      upsertCalEvent(cal, map, key, {
        title:       `${ev.name} — ${MILESTONE_LABELS[mk]}`,
        date:        m.date,
        description: buildMilestoneDesc(ev, mk, m),
        color:       m.completed ? COLOR_COMPLETED : COLOR_PENDING,
      });
    });
  });

  // Delete Calendar events whose Supabase source no longer exists
  Object.keys(map).forEach(key => {
    if (active.has(key)) return;
    try {
      const calEv = cal.getEventById(map[key]);
      if (calEv) calEv.deleteEvent();
    } catch (_) {}
    delete map[key];
  });

  saveMap(map);
  Logger.log(`[→ Calendar] synced ${active.size} items`);
}

function upsertCalEvent(cal, map, key, { title, date, description, color }) {
  const dateObj = parseDate(date);

  if (map[key]) {
    try {
      const calEv = cal.getEventById(map[key]);
      if (calEv) {
        if (calEv.getTitle() !== title)             calEv.setTitle(title);
        if (calEv.getDescription() !== description) calEv.setDescription(description);
        if (color && calEv.getColor() !== color)    calEv.setColor(color);
        const calDate = fmtDate(calEv.getAllDayStartDate());
        if (calDate !== date) calEv.setAllDayDate(dateObj);
        return;
      }
    } catch (_) {}
    // Cal event gone — fall through to recreate
  }

  // Deduplicate: search existing calendar events for the same ARTS tag
  // so a fullSync() or script restart never creates a second copy
  const mk2  = MILESTONE_KEYS.find(k => key.endsWith('_' + k));
  const evId = mk2 ? key.slice(0, -(mk2.length + 1)) : key;
  const tag  = mk2 ? `[ARTS:${evId}:${mk2}]` : `[ARTS:${evId}]`;
  const existing = findExistingByTag(cal, tag);
  if (existing) {
    map[key] = existing.getId();
    if (existing.getTitle() !== title)             existing.setTitle(title);
    if (existing.getDescription() !== description) existing.setDescription(description);
    if (color && existing.getColor() !== color)    existing.setColor(color);
    const calDate = fmtDate(existing.getAllDayStartDate());
    if (calDate !== date) existing.setAllDayDate(dateObj);
    return;
  }

  // Create fresh
  const newEv = cal.createAllDayEvent(title, dateObj, { description });
  if (color) newEv.setColor(color);
  newEv.removeAllReminders();
  newEv.addPopupReminder(24 * 60); // 1-day reminder
  map[key] = newEv.getId();
}

// Search a ±90-day window around the event date for a calendar event
// whose description contains our hidden tag.
function findExistingByTag(cal, tag) {
  const now   = new Date();
  const start = new Date(now.getFullYear() - 1, now.getMonth(), 1);
  const end   = new Date(now.getFullYear() + 2, now.getMonth(), 1);
  const all   = cal.getEvents(start, end);
  return all.find(e => (e.getDescription() || '').includes(tag)) || null;
}

// ================================================================
// CALENDAR → SUPABASE
// ================================================================

function syncFromCalendar() {
  const cal    = getCalendar();
  const map    = getMap();
  const events = loadEventsFromSupabase();
  let   dirty  = false;

  Object.entries(map).forEach(([key, calId]) => {
    // Parse the map key back into evId + optional milestone key
    const mk   = MILESTONE_KEYS.find(k => key.endsWith('_' + k));
    const evId = mk ? key.slice(0, -(mk.length + 1)) : key;
    const ev   = events.find(e => e.id === evId);
    if (!ev) return;

    let calEv;
    try { calEv = cal.getEventById(calId); } catch (_) { calEv = null; }

    if (!calEv) {
      // ── Deleted in Calendar ──────────────────────────────────
      if (!mk) {
        // Remove the whole event from Supabase
        const idx = events.findIndex(e => e.id === evId);
        if (idx !== -1) { events.splice(idx, 1); dirty = true; }
        Logger.log(`[← Calendar] deleted event "${ev.name}"`);
      } else {
        // Clear just the milestone date
        if (ev.deadlines?.[mk]) {
          ev.deadlines[mk].date = '';
          dirty = true;
          Logger.log(`[← Calendar] cleared deadline ${mk} on "${ev.name}"`);
        }
      }
      delete map[key];
      return;
    }

    // ── Date edited in Calendar ──────────────────────────────
    const calDate = fmtDate(calEv.getAllDayStartDate());
    if (!mk) {
      if (ev.date && ev.date !== calDate) {
        Logger.log(`[← Calendar] date change "${ev.name}": ${ev.date} → ${calDate}`);
        ev.date = calDate;
        dirty = true;
      }
    } else {
      const mDate = ev.deadlines?.[mk]?.date;
      if (mDate && mDate !== calDate) {
        Logger.log(`[← Calendar] deadline change "${ev.name}" ${mk}: ${mDate} → ${calDate}`);
        ev.deadlines[mk].date = calDate;
        dirty = true;
      }
    }
  });

  if (dirty) {
    saveEventsToSupabase(events);
    saveMap(map);
    Logger.log('[← Calendar] wrote changes back to Supabase');
  }
}

// ================================================================
// SUPABASE HELPERS
// ================================================================

function loadEventsFromSupabase() {
  const url  = `${CONFIG.SUPABASE_URL}/rest/v1/app_state?id=eq.state_${encodeURIComponent(CONFIG.YEAR)}&select=events`;
  const resp = UrlFetchApp.fetch(url, supabaseHeaders('GET'));
  const data = JSON.parse(resp.getContentText());
  return (data && data[0] && data[0].events) ? data[0].events : [];
}

function saveEventsToSupabase(events) {
  const url = `${CONFIG.SUPABASE_URL}/rest/v1/app_state?id=eq.state_${encodeURIComponent(CONFIG.YEAR)}`;
  UrlFetchApp.fetch(url, {
    ...supabaseHeaders('PATCH'),
    payload: JSON.stringify({ events }),
  });
}

function supabaseHeaders(method) {
  return {
    method,
    headers: {
      'apikey':        CONFIG.SUPABASE_KEY,
      'Authorization': `Bearer ${CONFIG.SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    muteHttpExceptions: true,
  };
}

// ================================================================
// CALENDAR / DATE HELPERS
// ================================================================

function getCalendar() {
  return CONFIG.CALENDAR_ID === 'primary'
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
}

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtDate(dt) {
  return Utilities.formatDate(dt, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// ================================================================
// MAP STORAGE (ScriptProperties)
// ================================================================

function getMap() {
  const raw = PropertiesService.getScriptProperties().getProperty('SYNC_MAP');
  return raw ? JSON.parse(raw) : {};
}

function saveMap(map) {
  PropertiesService.getScriptProperties().setProperty('SYNC_MAP', JSON.stringify(map));
}

// ================================================================
// CALENDAR EVENT DESCRIPTIONS
// ================================================================

function buildMainDesc(ev) {
  const lines = [];
  if (ev.time)     lines.push(`🕐 ${ev.time}`);
  if (ev.location) lines.push(`📍 ${ev.location}`);
  if (ev.contact)  lines.push(`👤 ${ev.contact}`);
  if (ev.budget)   lines.push(`💰 Budget: $${Number(ev.budget).toLocaleString()}`);
  if (ev.status)   lines.push(`Status: ${ev.status}`);
  if (ev.notes)    lines.push(`\nNotes:\n${ev.notes}`);
  // hidden tag lets the app know this is a managed event
  lines.push(`\n[ARTS:${ev.id}]`);
  return lines.join('\n');
}

function buildMilestoneDesc(ev, mk, m) {
  const lines = [`Event: ${ev.name}`];
  if (m.assignee)  lines.push(`Assigned: ${m.assignee}`);
  if (m.completed) lines.push('✅ Completed');
  lines.push(`\n[ARTS:${ev.id}:${mk}]`);
  return lines.join('\n');
}

// ================================================================
// TRIGGER MANAGEMENT
// ================================================================

function setupTriggers() {
  // Clear any existing triggers first
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sync')
    .timeBased()
    .everyMinutes(CONFIG.SYNC_INTERVAL_MINUTES)
    .create();
  Logger.log(`✅ Auto-sync set up: every ${CONFIG.SYNC_INTERVAL_MINUTES} minutes`);
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('🛑 All sync triggers removed');
}
