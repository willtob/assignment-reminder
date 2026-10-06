#!/usr/bin/env node
// Sends a WhatsApp message (official WhatsApp Cloud API) for every Moodle assignment due tomorrow.
// Run with --dry-run to print the messages instead of sending them.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const TIMEZONE = 'Europe/Madrid';

// Moodle login (written by ~/moodle-mcp/setup.js)
const moodleConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.moodle-mcp', 'config.json'), 'utf8'));
const MOODLE_URL = moodleConfig.url.replace(/\/+$/, '');
const MOODLE_TOKEN = moodleConfig.token;

// WhatsApp settings (filled in once the Meta app is set up)
const whatsappConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const WHATSAPP_TOKEN = whatsappConfig.access_token;
const PHONE_NUMBER_ID = whatsappConfig.phone_number_id;
const SEND_TO = whatsappConfig.send_to;               // your number, digits only, e.g. 34612345678
const TEMPLATE_NAME = whatsappConfig.template_name;   // e.g. assignment_reminder
const TEMPLATE_LANGUAGE = whatsappConfig.template_language; // e.g. en

async function main() {
  console.log('--- ' + new Date().toLocaleString('en-GB', { timeZone: TIMEZONE }) + ' ---');

  // 1. Ask Moodle for everything due in the next 3 days
  const now = Math.floor(Date.now() / 1000);
  const body = new URLSearchParams();
  body.append('wstoken', MOODLE_TOKEN);
  body.append('wsfunction', 'core_calendar_get_action_events_by_timesort');
  body.append('moodlewsrestformat', 'json');
  body.append('timesortfrom', String(now));
  body.append('timesortto', String(now + 3 * 86400));
  body.append('limitnum', '50');

  const moodleResponse = await fetch(MOODLE_URL + '/webservice/rest/server.php', { method: 'POST', body: body });
  const moodleData = await moodleResponse.json();
  if (moodleData.exception) {
    throw new Error('Moodle error: ' + moodleData.message);
  }

  // 2. Work out tomorrow's date in Madrid, e.g. "2026-10-07"
  const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
  const tomorrow = dateFormat.format(new Date(Date.now() + 86400 * 1000));

  // 3. Keep only the events whose due date is tomorrow
  const dueTomorrow = [];
  for (const event of moodleData.events) {
    const dueDate = dateFormat.format(new Date(event.timesort * 1000));
    if (dueDate === tomorrow) {
      dueTomorrow.push(event);
    }
  }

  if (dueTomorrow.length === 0) {
    console.log('Nothing due tomorrow (' + tomorrow + ').');
    return;
  }

  // 4. Send one WhatsApp message per assignment
  for (const event of dueTomorrow) {
    let assignmentName = event.activityname || event.name;
    let courseName = event.course ? event.course.fullname : 'Moodle';
    // Moodle sends names HTML-encoded ("Finance &amp; Valuation"), so turn them back into plain text
    assignmentName = assignmentName.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
    courseName = courseName.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
    const dueTime = timeFormat.format(new Date(event.timesort * 1000));

    console.log('Due tomorrow: ' + assignmentName + ' | ' + courseName + ' | ' + dueTime);
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
              { type: 'text', text: dueTime },
            ],
          },
        ],
      },
    };

    const whatsappResponse = await fetch('https://graph.facebook.com/v25.0/' + PHONE_NUMBER_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    const whatsappData = await whatsappResponse.json();
    if (!whatsappResponse.ok) {
      throw new Error('WhatsApp error: ' + JSON.stringify(whatsappData));
    }
    console.log('  sent, message id ' + whatsappData.messages[0].id);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
