#!/usr/bin/env node
// Two-way WhatsApp bot (stage 1: fixed commands, no AI).
// Text the bot "due", "week" or "grades" and it replies with your Moodle info.
//
// Meta sends every incoming WhatsApp message to this server as a "webhook" (an HTTP POST).
// start-bot.sh runs this server, opens a public tunnel to it and tells Meta the tunnel's address.
//
// Test a command without WhatsApp:  node bot.js --test week

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TIMEZONE, callMoodle, cleanCourseName, getDeadlines } = require('./moodle');

const PORT = 3000;
const GRAPH_API_URL = 'https://graph.facebook.com/v25.0';
const REMEMBERED_MESSAGES = 100; // how many message IDs to remember for spotting duplicates

// WhatsApp settings (see config.example.json)
const whatsappConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const WHATSAPP_TOKEN = whatsappConfig.access_token;
const PHONE_NUMBER_ID = whatsappConfig.phone_number_id;
const MY_NUMBER = whatsappConfig.send_to;                       // the bot only ever answers this number
const VERIFY_TOKEN = whatsappConfig.webhook_verify_token;       // shared password for Meta's one-time URL check
const APP_SECRET = whatsappConfig.app_secret;                   // used to check that a POST really came from Meta

const HELP_TEXT = 'Commands:\n' +
  '• due: overdue work, plus what is due today or tomorrow\n' +
  '• week: overdue work, plus the next 7 days\n' +
  '• grades: your course grades\n' +
  '• help: this list';

// Message IDs we have already answered. Meta sometimes delivers the same message twice.
const answeredMessageIds = new Set();


// ---------- Commands ----------

// "due" and "week": the same deadlines the scheduled messages use, one block per assignment.
// Normal replies (unlike templates) may contain line breaks.
async function deadlinesReply(scope) {
  const deadlines = await getDeadlines(scope);
  if (deadlines.length === 0) {
    return 'Nothing due 🎉';
  }

  const blocks = [];
  for (const item of deadlines) {
    blocks.push(
      '📌 *' + item.assignmentName + '*\n' +
      '📘 _' + item.courseName + '_\n' +
      '⏰ ' + item.deadline + '\n' +
      item.link
    );
  }
  return blocks.join('\n\n');
}

// "grades": the overall grade in each course that has one
async function gradesReply() {
  const siteInfo = await callMoodle('core_webservice_get_site_info', {});
  const courses = await callMoodle('core_enrol_get_users_courses', { userid: siteInfo.userid });
  const gradeData = await callMoodle('gradereport_overview_get_course_grades', { userid: siteInfo.userid });

  let reply = '🎓 Course grades:';
  let found = 0;
  for (const grade of gradeData.grades || []) {
    if (!grade.grade || grade.grade === '-') {
      continue; // no grade in this course yet
    }
    let courseName = 'Course ' + grade.courseid;
    for (const course of courses) {
      if (course.id === grade.courseid) {
        courseName = cleanCourseName(course.fullname);
      }
    }
    reply = reply + '\n• ' + courseName + ': ' + grade.grade;
    found = found + 1;
  }

  if (found === 0) {
    return 'No course grades yet.';
  }
  return reply;
}

// Turns whatever you texted into a reply
async function replyTo(text) {
  const command = text.trim().toLowerCase();
  if (command === 'due' || command === 'tomorrow') {
    return deadlinesReply('soon');
  }
  if (command === 'week') {
    return deadlinesReply('week');
  }
  if (command === 'grades') {
    return gradesReply();
  }
  return HELP_TEXT;
}


// ---------- WhatsApp ----------

// Sends a normal text message. No template is needed because you messaged the bot
// in the last 24 hours (Meta's "customer service window").
async function sendWhatsApp(text) {
  const response = await fetch(GRAPH_API_URL + '/' + PHONE_NUMBER_ID + '/messages', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: MY_NUMBER, type: 'text', text: { body: text } }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error('WhatsApp error: ' + JSON.stringify(data.error || data));
  }
}

// Checks Meta's signature: an HMAC of the exact bytes received, made with your app secret.
// timingSafeEqual compares in constant time, so an attacker can't guess the signature
// byte by byte by measuring how long the comparison takes.
function hasValidSignature(rawBody, signatureHeader) {
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex'));
  const received = Buffer.from(signatureHeader || '');
  if (received.length !== expected.length) {
    return false; // timingSafeEqual only compares equal lengths
  }
  return crypto.timingSafeEqual(received, expected);
}

// Handles one POST from Meta, after the signature has been checked
async function handleWebhook(body) {
  // A webhook can be a new message, or just a "delivered"/"read" receipt. We only want messages.
  const value = body.entry && body.entry[0] && body.entry[0].changes && body.entry[0].changes[0] && body.entry[0].changes[0].value;
  if (!value || !value.messages) {
    return;
  }
  const message = value.messages[0];

  if (message.from !== MY_NUMBER) {
    console.log('Ignored a message from another number');
    return;
  }
  if (answeredMessageIds.has(message.id)) {
    return; // Meta delivered this one twice
  }
  answeredMessageIds.add(message.id);
  if (answeredMessageIds.size > REMEMBERED_MESSAGES) {
    // A Set keeps insertion order, so the first value is the oldest one
    answeredMessageIds.delete(answeredMessageIds.values().next().value);
  }

  if (message.type !== 'text') {
    await sendWhatsApp('I only understand text for now.\n\n' + HELP_TEXT);
    return;
  }

  console.log(new Date().toLocaleString('en-GB', { timeZone: TIMEZONE }) + '  received: ' + message.text.body);
  let reply;
  try {
    reply = await replyTo(message.text.body);
  } catch (error) {
    console.error(error.message);
    reply = 'Something went wrong: ' + error.message;
  }
  await sendWhatsApp(reply);
  console.log('  replied');
}


// ---------- Web server ----------

function startServer() {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !MY_NUMBER || !VERIFY_TOKEN || !APP_SECRET) {
    throw new Error('config.json is missing a setting (compare it with config.example.json)');
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');

    // 1. Meta's one-time check: "is this really your server?"
    //    It sends the verify token we gave it and expects the "challenge" number back.
    if (request.method === 'GET') {
      if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === VERIFY_TOKEN) {
        console.log('Meta verified the webhook URL');
        response.end(url.searchParams.get('hub.challenge'));
      } else {
        response.statusCode = 403;
        response.end();
      }
      return;
    }

    if (request.method !== 'POST') {
      response.statusCode = 405;
      response.end();
      return;
    }

    // 2. An incoming WhatsApp event. Read the whole body first.
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks);

      // If the signature doesn't match, someone other than Meta sent it, so ignore it
      if (!hasValidSignature(rawBody, request.headers['x-hub-signature-256'])) {
        console.log('Rejected a request with a bad signature');
        response.statusCode = 401;
        response.end();
        return;
      }

      // Say "got it" straight away. If Meta waits too long it sends the message again.
      response.end();

      let body;
      try {
        body = JSON.parse(rawBody);
      } catch (error) {
        console.error('Ignored a request that was not valid JSON');
        return;
      }
      handleWebhook(body).catch((error) => console.error(error.message));
    });
  });

  server.listen(PORT, () => {
    console.log('Bot listening on http://localhost:' + PORT);
  });
}


// ---------- Start ----------

const testIndex = process.argv.indexOf('--test');
if (testIndex !== -1) {
  // node bot.js --test week   -> print the reply instead of running the server
  replyTo(process.argv.slice(testIndex + 1).join(' '))
    .then((reply) => console.log(reply))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
} else {
  startServer();
}
