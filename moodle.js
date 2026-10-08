// Everything that talks to Moodle or decides how a deadline is shown.
// Shared by remind.js (scheduled messages) and bot.js (replies), so both always agree.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEZONE = 'Europe/Madrid';
const OVERDUE_DAYS = 7;   // how far back to look for overdue, unsubmitted assignments
const WEEK_DAYS = 7;      // how far ahead "week" looks

// Moodle login (written by ~/moodle-mcp/setup.js)
const moodleConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.moodle-mcp', 'config.json'), 'utf8'));
const MOODLE_URL = (moodleConfig.url || '').replace(/\/+$/, '');
const MOODLE_TOKEN = moodleConfig.token;


// Calls one Moodle web-service function and returns its JSON answer
async function callMoodle(functionName, params) {
  if (!MOODLE_URL || !MOODLE_TOKEN) {
    throw new Error('Moodle is not set up: run  node ~/moodle-mcp/setup.js https://ecampus.esade.edu');
  }

  const body = new URLSearchParams();
  body.append('wstoken', MOODLE_TOKEN);
  body.append('wsfunction', functionName);
  body.append('moodlewsrestformat', 'json');
  for (const key in params) {
    body.append(key, String(params[key]));
  }

  const response = await fetch(MOODLE_URL + '/webservice/rest/server.php', { method: 'POST', body: body });
  if (!response.ok) {
    throw new Error('Moodle returned HTTP ' + response.status);
  }
  const data = await response.json();
  if (data && data.exception) {
    throw new Error('Moodle error: ' + data.message);
  }
  return data;
}


// Moodle sends names HTML-encoded ("Finance &amp; Valuation"), so turn them back into plain text.
// Also squash line breaks and long runs of spaces, which WhatsApp templates reject.
function toPlainText(text) {
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
  return text.replace(/\s+/g, ' ').trim();
}


// Shortens ESADE course names, e.g.
//   "2026-27- BBA-DBAI-GBL Corporate Finance &amp; Financial Valuation" -> "Corporate Finance & Financial Valuation"
//   "Language I (Spanish) Sec: D GC: 1402"                             -> "Language I (Spanish)"
//   "Marketing Foundations 2026"                                       -> "Marketing Foundations"
function cleanCourseName(name) {
  name = toPlainText(name);
  const fullName = name;
  name = name.replace(/^\d{4}(-\d{2,4})?-?\s*/, '');      // leading year: "2026-27- "
  name = name.replace(/^[A-Z&]+(-[A-Z]+)+\s+/, '');        // programme code: "BBA-DBAI-GBL "
  name = name.replace(/\s+(Sec|GC):.*$/, '');              // section codes: " Sec: ALL", " GC: 1402"
  name = name.replace(/\s+-\s+Bachelor\b.*$/, '');         // degree name: " - Bachelor of ..."
  name = name.replace(/\s+\d{4}$/, '');                    // trailing year: " 2026"
  if (name === '') {
    name = fullName;
  }
  return name;
}


// Returns the deadlines to tell you about, ready to show:
//   [{ assignmentName, courseName, deadline: "Tomorrow 14:00", link: "https://...", linkPath: "mod/assign/view.php?id=1" }]
//
// scope "soon": overdue work, plus anything due later today or tomorrow
// scope "week": overdue work, plus anything due in the next 7 days
//
// "Overdue work" = assignments from the last 7 days that are past their deadline and not submitted.
async function getDeadlines(scope) {
  // 1. Ask Moodle for everything from a week ago up to a week ahead.
  //    These are "action events": things you still have to do, so submitted work is left out.
  const now = Math.floor(Date.now() / 1000);
  const data = await callMoodle('core_calendar_get_action_events_by_timesort', {
    timesortfrom: now - OVERDUE_DAYS * 86400,
    timesortto: now + WEEK_DAYS * 86400,
    limitnum: 50,
  });
  const events = data.events || [];

  // 2. Today's and tomorrow's date in Madrid, e.g. "2026-10-08"
  const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
  const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, weekday: 'short', day: 'numeric', month: 'short' });
  const today = dateFormat.format(new Date());
  const tomorrow = dateFormat.format(new Date(Date.now() + 86400 * 1000));

  const deadlines = [];
  for (const event of events) {
    const dueAt = new Date(event.timesort * 1000);
    const dueDate = dateFormat.format(dueAt);
    const isOverdue = event.timesort < now;

    // 3. Skip what this scope shouldn't mention
    if (isOverdue) {
      // Only assignments: Moodle reliably knows whether you submitted those.
      // Quizzes and questionnaires can stay "open" after you've done them.
      if (event.modulename !== 'assign') {
        continue;
      }
    } else if (scope === 'soon' && dueDate !== today && dueDate !== tomorrow) {
      continue;
    }

    // 4. The deadline text, e.g. "Today 23:59", "Tomorrow 14:00", "Mon 12 Oct 14:00", "Overdue since today 10:00"
    let day = dayFormat.format(dueAt).replace(/,/g, '');
    if (dueDate === today) {
      day = 'today';
    } else if (dueDate === tomorrow) {
      day = 'tomorrow';
    }
    let deadline = day + ' ' + timeFormat.format(dueAt);
    if (isOverdue) {
      deadline = 'Overdue since ' + deadline;
    } else {
      deadline = deadline.charAt(0).toUpperCase() + deadline.slice(1);
    }

    // 5. The link. Templates only let us fill in the end of a button's address
    //    ("https://ecampus.esade.edu/" + linkPath), so keep that part separately.
    let linkPath = 'my/'; // your Moodle dashboard, if the event has no link
    if (event.url && event.url.startsWith(MOODLE_URL + '/')) {
      linkPath = event.url.slice(MOODLE_URL.length + 1);
    }

    deadlines.push({
      assignmentName: toPlainText(event.activityname || event.name),
      courseName: event.course ? cleanCourseName(event.course.fullname) : 'Moodle',
      deadline: deadline,
      link: MOODLE_URL + '/' + linkPath,
      linkPath: linkPath,
    });
  }
  return deadlines;
}


module.exports = { TIMEZONE, callMoodle, cleanCourseName, getDeadlines };
