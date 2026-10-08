#!/usr/bin/env node
// Sends one WhatsApp message (official WhatsApp Cloud API) per Moodle assignment you still have to do.
//
//   node remind.js          daily (14:30): overdue work, plus everything due later today or tomorrow
//   node remind.js --week   Saturdays (10:00): overdue work, plus everything due in the next 7 days
//
// Add --dry-run to print the messages instead of sending them.
// Which deadlines count, and how they're worded, is decided in moodle.js.

const fs = require('fs');
const path = require('path');
const { TIMEZONE, getDeadlines } = require('./moodle');

const DRY_RUN = process.argv.includes('--dry-run');
const WEEK = process.argv.includes('--week');
const GRAPH_API_URL = 'https://graph.facebook.com/v25.0';

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
  if (!DRY_RUN && (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !SEND_TO || !TEMPLATE_NAME || !TEMPLATE_LANGUAGE)) {
    throw new Error('config.json is missing a WhatsApp setting (compare it with config.example.json)');
  }

  // 1. Get the deadlines to tell you about
  const deadlines = await getDeadlines(WEEK ? 'week' : 'soon');
  if (deadlines.length === 0) {
    console.log('Nothing to remind you about.');
    return;
  }

  // 2. Send one WhatsApp message per assignment.
  //    If one fails, keep going with the others and report the failure at the end.
  let failures = 0;
  for (const item of deadlines) {
    console.log(item.deadline + ' | ' + item.assignmentName + ' | ' + item.courseName + ' | ' + item.linkPath);
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
              { type: 'text', text: item.assignmentName },
              { type: 'text', text: item.courseName },
              { type: 'text', text: item.deadline },
            ],
          },
          {
            // the "Open in Moodle" button: we fill in the end of its address
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: item.linkPath }],
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
    throw new Error(failures + ' of ' + deadlines.length + ' message(s) failed to send');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
