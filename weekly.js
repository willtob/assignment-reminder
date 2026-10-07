#!/usr/bin/env node
// Sends one WhatsApp message (official WhatsApp Cloud API) listing every Moodle assignment due in the next 7 days.
// Scheduled for Saturdays at 10:00, so each summary covers Saturday 10:00 up to the next Saturday 10:00.
// Run with --dry-run to print the message instead of sending it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const TIMEZONE = 'Europe/Madrid';
const GRAPH_API_URL = 'https://graph.facebook.com/v25.0';
const DAYS_AHEAD = 7;
const MAX_LIST_LENGTH = 900; // WhatsApp allows 1024 characters for the whole message, so leave room for the template text

// Moodle login (written by ~/moodle-mcp/setup.js)
const moodleConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.moodle-mcp', 'config.json'), 'utf8'));
const MOODLE_URL = moodleConfig.url.replace(/\/+$/, '');
const MOODLE_TOKEN = moodleConfig.token;

// WhatsApp settings (see config.example.json)
const whatsappConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const WHATSAPP_TOKEN = whatsappConfig.access_token;
const PHONE_NUMBER_ID = whatsappConfig.phone_number_id;
const SEND_TO = whatsappConfig.send_to;                            // your number, digits only, e.g. 34612345678
const TEMPLATE_NAME = whatsappConfig.weekly_template_name;         // e.g. weekly_summary
const TEMPLATE_LANGUAGE = whatsappConfig.template_language;        // e.g. en

async function main() {
  console.log('--- weekly summary, ' + new Date().toLocaleString('en-GB', { timeZone: TIMEZONE }) + ' ---');

  // 0. Stop early with a clear message if a setting is missing
  if (!MOODLE_URL || !MOODLE_TOKEN) {
    throw new Error('Moodle is not set up: run  node ~/moodle-mcp/setup.js https://ecampus.esade.edu');
  }
  if (!DRY_RUN && (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !SEND_TO || !TEMPLATE_NAME || !TEMPLATE_LANGUAGE)) {
    throw new Error('config.json is missing a WhatsApp setting (compare it with config.example.json)');
  }

  // 1. Ask Moodle for everything due in the next 7 days
  //    (these are "action events": things you still have to do, so work you've already submitted is left out)
  const now = Math.floor(Date.now() / 1000);
  const body = new URLSearchParams();
  body.append('wstoken', MOODLE_TOKEN);
  body.append('wsfunction', 'core_calendar_get_action_events_by_timesort');
  body.append('moodlewsrestformat', 'json');
  body.append('timesortfrom', String(now));
  body.append('timesortto', String(now + DAYS_AHEAD * 86400));
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

  if (events.length === 0) {
    console.log('Nothing due in the next ' + DAYS_AHEAD + ' days.');
    return;
  }

  // 2. Turn each assignment into one line, e.g. "Mon 12 Oct 14:00 Homework 202 (Corporate Finance)"
  //    Moodle already returns them sorted by due date, soonest first.
  const whenFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const lines = [];
  for (const event of events) {
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
    if (courseName === '') {
      courseName = fullCourseName;
    }

    // "Tue, 13 Oct, 14:00" -> "Tue 13 Oct 14:00"
    const when = whenFormat.format(new Date(event.timesort * 1000)).replace(/,/g, '');

    lines.push(when + ' ' + assignmentName + ' (' + courseName + ')');
    console.log('Due this week: ' + lines[lines.length - 1]);
  }

  // 3. Join the lines into one value. WhatsApp doesn't allow line breaks inside a template value,
  //    so the assignments are separated with " • ". If the list is too long, cut it and say how many are left out.
  let list = '';
  let included = 0;
  for (const line of lines) {
    const next = included === 0 ? line : list + ' • ' + line;
    if (next.length > MAX_LIST_LENGTH) {
      break;
    }
    list = next;
    included = included + 1;
  }
  if (included < lines.length) {
    list = list + ' • …and ' + (lines.length - included) + ' more, check Moodle';
  }

  if (DRY_RUN) {
    console.log('Would send: 📅 Week ahead: you have ' + lines.length + ' assignment(s) due in the next 7 days: ' + list + '. Good luck!');
    return;
  }

  // 4. Send the summary as one WhatsApp message
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
            { type: 'text', text: String(lines.length) },
            { type: 'text', text: list },
          ],
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
    throw new Error('WhatsApp error: ' + JSON.stringify(whatsappData.error || whatsappData));
  }
  console.log('  sent, message id ' + whatsappData.messages[0].id);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
