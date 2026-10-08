#!/usr/bin/env node
// Sends one WhatsApp message (official WhatsApp Cloud API) per Moodle assignment you still have to do.
//
//   node remind.js          daily (14:30): overdue work, plus everything due later today or tomorrow
//   node remind.js --week   Saturdays (10:00): overdue work, plus everything due in the next 7 days
//
// Add --dry-run to print the messages instead of sending them.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const WEEK = process.argv.includes('--week');
const TIMEZONE = 'Europe/Madrid';
const GRAPH_API_URL = 'https://graph.facebook.com/v25.0';
const OVERDUE_DAYS = 7;   // how far back to look for overdue, unsubmitted assignments
const WEEK_DAYS = 7;      // how far ahead the Saturday run looks

// Moodle login (written by ~/moodle-mcp/setup.js)
const moodleConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.moodle-mcp', 'config.json'), 'utf8'));
const MOODLE_URL = moodleConfig.url.replace(/\/+$/, '');
const MOODLE_TOKEN = moodleConfig.token;

// WhatsApp settings (see config.example.json)
const whatsappConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const WHATSAPP_TOKEN = whatsappConfig.access_token;
const PHONE_NUMBER_ID = whatsappConfig.phone_number_id;
const SEND_TO = whatsappConfig.send_to;                     // your number, digits only, e.g. 34612345678
const TEMPLATE_NAME = whatsappConfig.template_name;         // e.g. deadline
const TEMPLATE_LANGUAGE = whatsappConfig.template_language; // e.g. en

async function main() {
  console.log('--- ' + (WEEK ? 'weekly' : 'daily') + ', ' + new Date().toLocaleString('en-GB', { timeZone: TIMEZONE }) + ' ---');

  // 0. Stop early with a clear message if a setting is missing
  if (!MOODLE_URL || !MOODLE_TOKEN) {
    throw new Error('Moodle is not set up: run  node ~/moodle-mcp/setup.js https://ecampus.esade.edu');
  }
  if (!DRY_RUN && (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !SEND_TO || !TEMPLATE_NAME || !TEMPLATE_LANGUAGE)) {
    throw new Error('config.json is missing a WhatsApp setting (compare it with config.example.json)');
  }

  // 1. Ask Moodle for everything from a week ago up to 7 days ahead
  //    (these are "action events": things you still have to do, so work you've already submitted is left out)
  const now = Math.floor(Date.now() / 1000);
  const body = new URLSearchParams();
  body.append('wstoken', MOODLE_TOKEN);
  body.append('wsfunction', 'core_calendar_get_action_events_by_timesort');
  body.append('moodlewsrestformat', 'json');
  body.append('timesortfrom', String(now - OVERDUE_DAYS * 86400));
  body.append('timesortto', String(now + WEEK_DAYS * 86400));
  body.append('limitnum', '50');

  const moodleResponse = await fetch(MOODLE_URL + '/webservice/rest/server.php', { method: 'POST', body: body });
  if (!moodleResponse.ok) {
    throw new Error('Moodle returned HTTP ' + moodleResponse.status);
  }
  const moodleData = await moodleResponse.json();
  if (moodleData.exception) {
    throw new Error('Moodle error: ' + moodleData.message);
  }
  const events = moodleData.events || [];

  // 2. Work out today's and tomorrow's date in Madrid, e.g. "2026-10-08"
  const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
  const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, weekday: 'short', day: 'numeric', month: 'short' });
  const today = dateFormat.format(new Date());
  const tomorrow = dateFormat.format(new Date(Date.now() + 86400 * 1000));

  // 3. Keep the events this run should mention
  const toSend = [];
  for (const event of events) {
    const isOverdue = event.timesort < now;
    const dueDate = dateFormat.format(new Date(event.timesort * 1000));

    if (isOverdue) {
      // Only assignments: Moodle reliably knows whether you submitted those.
      // Quizzes and questionnaires can stay "open" after you've done them.
      if (event.modulename === 'assign') {
        toSend.push(event);
      }
    } else if (WEEK) {
      toSend.push(event); // everything in the next 7 days
    } else if (dueDate === today || dueDate === tomorrow) {
      toSend.push(event);
    }
  }

  if (toSend.length === 0) {
    console.log('Nothing to remind you about.');
    return;
  }

  // 4. Send one WhatsApp message per assignment.
  //    If one fails, keep going with the others and report the failure at the end.
  let failures = 0;
  for (const event of toSend) {
    let assignmentName = event.activityname || event.name;
    let courseName = event.course ? event.course.fullname : 'Moodle';

    // Moodle sends names HTML-encoded ("Finance &amp; Valuation"), so turn them back into plain text
    assignmentName = assignmentName.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
    courseName = courseName.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'");

    // WhatsApp rejects template values that contain line breaks, tabs or long runs of spaces
    assignmentName = assignmentName.replace(/\s+/g, ' ').trim();
    courseName = courseName.replace(/\s+/g, ' ').trim();

    // Shorten ESADE course names, e.g.
    //   "2026-27- BBA-DBAI-GBL Corporate Finance & Financial Valuation" -> "Corporate Finance & Financial Valuation"
    //   "Language I (Spanish) Sec: D GC: 1402"                         -> "Language I (Spanish)"
    const fullCourseName = courseName;
    courseName = courseName.replace(/^\d{4}(-\d{2,4})?-?\s*/, '');      // leading year: "2026-27- "
    courseName = courseName.replace(/^[A-Z&]+(-[A-Z]+)+\s+/, '');        // programme code: "BBA-DBAI-GBL "
    courseName = courseName.replace(/\s+(Sec|GC):.*$/, '');              // section codes: " Sec: ALL", " GC: 1402"
    courseName = courseName.replace(/\s+-\s+Bachelor\b.*$/, '');         // degree name: " - Bachelor of ..."
    courseName = courseName.replace(/\s+\d{4}$/, '');                    // trailing year: "Marketing Foundations 2026"
    if (courseName === '') {
      courseName = fullCourseName;
    }

    // The deadline line, e.g. "Today 23:59", "Tomorrow 14:00", "Mon 12 Oct 14:00", "Overdue since today 10:00"
    const dueAt = new Date(event.timesort * 1000);
    const dueDate = dateFormat.format(dueAt);
    let day = dayFormat.format(dueAt).replace(/,/g, '');
    if (dueDate === today) {
      day = 'today';
    } else if (dueDate === tomorrow) {
      day = 'tomorrow';
    }
    let deadline = day + ' ' + timeFormat.format(dueAt);
    if (event.timesort < now) {
      deadline = 'Overdue since ' + deadline;
    } else {
      deadline = deadline.charAt(0).toUpperCase() + deadline.slice(1);
    }

    // The "Open in Moodle" button only lets us fill in the end of the address:
    // "https://ecampus.esade.edu/" + "mod/assign/view.php?id=123"
    let linkPath = 'my/'; // your Moodle dashboard, if the event has no link
    if (event.url && event.url.startsWith(MOODLE_URL + '/')) {
      linkPath = event.url.slice(MOODLE_URL.length + 1);
    }

    console.log(deadline + ' | ' + assignmentName + ' | ' + courseName + ' | ' + linkPath);
    if (DRY_RUN) {
      continue;
    }

    const message = {
      messaging_product: 'whatsapp',
      to: SEND_TO,
      type: 'template',
      template: {
        name: TEMPLATE_NAME,
        language: { code: TEMPLATE_LANGUAGE },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: assignmentName },
              { type: 'text', text: courseName },
              { type: 'text', text: deadline },
            ],
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: linkPath }],
          },
        ],
      },
    };

    const whatsappResponse = await fetch(GRAPH_API_URL + '/' + PHONE_NUMBER_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    const whatsappData = await whatsappResponse.json();
    if (!whatsappResponse.ok) {
      console.error('  NOT sent, WhatsApp error: ' + JSON.stringify(whatsappData.error || whatsappData));
      failures = failures + 1;
      continue;
    }
    console.log('  sent, message id ' + whatsappData.messages[0].id);
  }

  if (failures > 0) {
    throw new Error(failures + ' of ' + toSend.length + ' message(s) failed to send');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
