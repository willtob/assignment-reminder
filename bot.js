#!/usr/bin/env node
// Two-way WhatsApp bot (stage 1: fixed commands, no AI).
// Text the bot "tomorrow", "week" or "grades" and it replies with your Moodle info.
//
// Meta sends every incoming WhatsApp message to this server as a "webhook" (an HTTP POST).
// start-bot.sh runs this server, opens a public tunnel to it and tells Meta the tunnel's address.
//
// Test a command without WhatsApp:  node bot.js --test week

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3000;
const TIMEZONE = 'Europe/Madrid';
const GRAPH_API_URL = 'https://graph.facebook.com/v25.0';

// Moodle login (written by ~/moodle-mcp/setup.js)
const moodleConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.moodle-mcp', 'config.json'), 'utf8'));
const MOODLE_URL = moodleConfig.url.replace(/\/+$/, '');
const MOODLE_TOKEN = moodleConfig.token;

// WhatsApp settings (see config.example.json)
const whatsappConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const WHATSAPP_TOKEN = whatsappConfig.access_token;
const PHONE_NUMBER_ID = whatsappConfig.phone_number_id;
const MY_NUMBER = whatsappConfig.send_to;                       // the bot only ever answers this number
const VERIFY_TOKEN = whatsappConfig.webhook_verify_token;       // shared password for Meta's one-time URL check
const APP_SECRET = whatsappConfig.app_secret;                   // used to check that a POST really came from Meta

const HELP_TEXT = 'Commands:\n' +
  '• tomorrow: what is due tomorrow\n' +
  '• week: what is due in the next 7 days\n' +
  '• grades: your course grades\n' +
  '• help: this list';

// Message IDs we have already answered. Meta sometimes delivers the same message twice.
const answeredMessageIds = new Set();


// ---------- Moodle ----------

// Calls one Moodle web-service function and returns its JSON answer
async function callMoodle(functionName, params) {
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

// "2026-27- BBA-DBAI-GBL Corporate Finance &amp; Valuation Sec: A" -> "Corporate Finance & Valuation"
// (same clean-up as remind.js)
function cleanCourseName(name) {
  name = name.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
  name = name.replace(/\s+/g, ' ').trim();
  const fullName = name;
  name = name.replace(/^\d{4}(-\d{2,4})?-?\s*/, '');
  name = name.replace(/^[A-Z&]+(-[A-Z]+)+\s+/, '');
  name = name.replace(/\s+(Sec|GC):.*$/, '');
  name = name.replace(/\s+-\s+Bachelor\b.*$/, '');
  if (name === '') {
    name = fullName;
  }
  return name;
}


// ---------- Commands ----------

// "tomorrow" and "week": list assignments due in the next few days
async function deadlinesReply(days, onlyTomorrow) {
  const now = Math.floor(Date.now() / 1000);
  const data = await callMoodle('core_calendar_get_action_events_by_timesort', {
    timesortfrom: now,
    timesortto: now + days * 86400,
    limitnum: 50,
  });
  let events = data.events || [];

  const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const whenFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  if (onlyTomorrow) {
    const tomorrow = dateFormat.format(new Date(Date.now() + 86400 * 1000));
    const dueTomorrow = [];
    for (const event of events) {
      if (dateFormat.format(new Date(event.timesort * 1000)) === tomorrow) {
        dueTomorrow.push(event);
      }
    }
    events = dueTomorrow;
  }

  if (events.length === 0) {
    return onlyTomorrow ? 'Nothing due tomorrow 🎉' : 'Nothing due in the next ' + days + ' days 🎉';
  }

  let reply = onlyTomorrow ? '📚 Due tomorrow:' : '📅 Due in the next ' + days + ' days:';
  for (const event of events) {
    const assignmentName = (event.activityname || event.name).replace(/&amp;/g, '&');
    const courseName = event.course ? cleanCourseName(event.course.fullname) : 'Moodle';
    const when = whenFormat.format(new Date(event.timesort * 1000)).replace(/,/g, '');
    reply = reply + '\n• ' + when + ': ' + assignmentName + ' (' + courseName + ')';
  }
  return reply;
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
  if (command === 'tomorrow') {
    return deadlinesReply(2, true);
  }
  if (command === 'week' || command === 'due') {
    return deadlinesReply(7, false);
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

      // Meta signs every POST with your app secret. If the signature doesn't match,
      // someone else sent it, so ignore it.
      const expectedSignature = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
      if (request.headers['x-hub-signature-256'] !== expectedSignature) {
        console.log('Rejected a request with a bad signature');
        response.statusCode = 401;
        response.end();
        return;
      }

      // Say "got it" straight away. If Meta waits too long it sends the message again.
      response.end();

      handleWebhook(JSON.parse(rawBody)).catch((error) => console.error(error.message));
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
