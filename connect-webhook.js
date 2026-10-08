#!/usr/bin/env node
// Tells Meta where to send incoming WhatsApp messages (the "webhook callback URL").
// start-bot.sh runs this every time, because the free tunnel gets a new address on each start.
//
// Usage: node connect-webhook.js https://something.trycloudflare.com

const fs = require('fs');
const path = require('path');

const GRAPH_API_URL = 'https://graph.facebook.com/v25.0';

const whatsappConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const APP_ID = whatsappConfig.app_id;
const APP_SECRET = whatsappConfig.app_secret;
const VERIFY_TOKEN = whatsappConfig.webhook_verify_token;
const WHATSAPP_TOKEN = whatsappConfig.access_token;
const WABA_ID = whatsappConfig.whatsapp_business_account_id;

async function main() {
  const callbackUrl = process.argv[2];
  if (!callbackUrl || !callbackUrl.startsWith('https://')) {
    throw new Error('Usage: node connect-webhook.js https://your-tunnel-address');
  }
  if (!APP_ID || !APP_SECRET || !VERIFY_TOKEN || !WHATSAPP_TOKEN || !WABA_ID) {
    throw new Error('config.json is missing a setting (compare it with config.example.json)');
  }

  // 1. Set the app's webhook URL for WhatsApp messages.
  //    Meta immediately calls the URL to check it (bot.js answers that check),
  //    so the bot and the tunnel must already be running.
  //    A brand-new tunnel address can take a few seconds to work, so try a few times.
  const body = new URLSearchParams();
  body.append('object', 'whatsapp_business_account');
  body.append('callback_url', callbackUrl);
  body.append('verify_token', VERIFY_TOKEN);
  body.append('fields', 'messages');
  body.append('access_token', APP_ID + '|' + APP_SECRET); // an "app access token"

  const ATTEMPTS = 6;
  let connected = false;
  for (let attempt = 1; attempt <= ATTEMPTS && !connected; attempt++) {
    const response = await fetch(GRAPH_API_URL + '/' + APP_ID + '/subscriptions', { method: 'POST', body: body });
    const data = await response.json();
    if (response.ok && data.success) {
      connected = true;
    } else {
      console.log('  attempt ' + attempt + ' failed: ' + (data.error ? data.error.message : JSON.stringify(data)));
      if (attempt < ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }
  if (!connected) {
    throw new Error('Meta could not reach ' + callbackUrl);
  }

  // 2. Make sure your WhatsApp Business Account sends its events to this app
  //    (only needed once, but repeating it is harmless)
  const subscribeResponse = await fetch(GRAPH_API_URL + '/' + WABA_ID + '/subscribed_apps', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN },
  });
  const subscribeData = await subscribeResponse.json();
  if (!subscribeResponse.ok) {
    throw new Error('Could not subscribe the WhatsApp account: ' + JSON.stringify(subscribeData.error || subscribeData));
  }

  console.log('Webhook connected: Meta will send WhatsApp messages to ' + callbackUrl);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
