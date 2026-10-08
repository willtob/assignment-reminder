# 📚 Assignment Reminder

Get WhatsApp messages about upcoming Moodle assignments.

A small script on my Mac checks ESADE's Moodle (eCampus) and sends me **one WhatsApp message per assignment** I still have to do:

> 📌 Assignment: **Block2_Compulsory Homework 202(Springs)**
> 📘 Course: _Corporate Finance & Financial Valuation_
> ⏰ Deadline: Tomorrow 14:00
> Still not submitted.
> [ Open in Moodle ]

| When | What it sends |
|---|---|
| **Every day at 14:30** | Anything due later today or tomorrow, plus overdue work |
| **Saturdays at 10:00** | Everything due in the next 7 days, plus overdue work |

"Overdue work" means **assignments** from the last 7 days that are past their deadline and not submitted. If there's nothing to report, no message is sent.

**Two-way bot (optional):** while `start-bot.sh` is running, you can text the bot a command and it replies:

| You send | It replies with |
|---|---|
| `tomorrow` | Everything due tomorrow |
| `week` (or `due`) | Everything due in the next 7 days |
| `grades` | Your overall grade in each course |
| anything else | The list of commands |

---

## How it works

```
 ┌────────────┐   14:30 every day   ┌──────────────┐   "what's due?"   ┌──────────┐
 │  macOS     │ ──────────────────▶ │  remind.js   │ ────────────────▶ │  Moodle  │
 │  launchd   │                     │              │ ◀──────────────── │ eCampus  │
 └────────────┘                     │              │   list of events  └──────────┘
                                    │              │
                                    │              │   template msg    ┌──────────┐
                                    │              │ ────────────────▶ │ WhatsApp │ ──▶ 📱
                                    └──────────────┘                   │ Cloud API│
                                                                       └──────────┘
```

1. **launchd**, the scheduler built into macOS, starts `remind.js` at 14:30. If the Mac is asleep at that time, the job runs as soon as it wakes up.
2. **`remind.js`** asks Moodle for every deadline from 7 days ago to 7 days ahead. It keeps the ones due later today or tomorrow (Madrid time), plus overdue assignments.
3. For each one, it sends a message through Meta's official **WhatsApp Cloud API**, using the pre-approved `deadline` message template.

On Saturdays, launchd runs `remind.js --week`, which keeps everything due in the next 7 days instead of just today and tomorrow.

Why one message per assignment? WhatsApp doesn't allow line breaks inside a template value, so a single message with a readable list isn't possible.

The bot works the other way round. Meta calls *you*: every message you send to the bot's number is forwarded as an HTTP POST (a **webhook**) to a URL you choose.

```
 📱 "week" ──▶ WhatsApp ──POST──▶ Cloudflare tunnel ──▶ bot.js on your Mac ──▶ Moodle
 📱 reply  ◀── WhatsApp ◀──────── POST /messages ◀──────────┘
```

1. **`bot.js`** runs a small web server on `localhost:3000`.
2. **`cloudflared`** opens a free public HTTPS address (`https://random-words.trycloudflare.com`) that forwards to that server, so Meta can reach your Mac without any router setup.
3. **`connect-webhook.js`** tells Meta that address. Meta checks it once by sending a GET with the `webhook_verify_token`, which `bot.js` answers.
4. When a message arrives, `bot.js` checks the `X-Hub-Signature-256` header (signed with your app secret) so nobody else can fake messages. It also ignores any number except yours, works out the reply, and sends it back.

Replies are normal text messages, not templates. After you message a WhatsApp business number, it may answer freely for 24 hours.

The scripts have **no dependencies**. It's plain Node.js (v18 or newer), using the built-in `fetch`.

---

## Files

| File | What it is |
|---|---|
| `remind.js` | Reads Moodle and sends one message per assignment. `--week` looks 7 days ahead instead of 1. |
| `moodle.js` | Shared Moodle code: fetches deadlines, decides which ones count (overdue, today, tomorrow, week) and words them. |
| `config.example.json` | Template for your settings. Copy it to `config.json` and fill it in. |
| `config.json` | Your real settings and secrets. **Not in git** (see `.gitignore`). |
| `com.williamtobin.assignment-reminder.plist` | launchd schedule for `remind.js` (daily at 14:30). |
| `com.williamtobin.assignment-reminder.weekly.plist` | launchd schedule for `remind.js --week` (Saturdays at 10:00). |
| `reminder.log` | Output from every run. Created automatically and not in git. |
| `bot.js` | Two-way bot. A web server that answers the commands you text it. |
| `connect-webhook.js` | Tells Meta the bot's current public address. |
| `start-bot.sh` | Starts the bot and the tunnel, then connects the webhook. Use this one. |
| `tunnel.log` | Output from `cloudflared`. Created automatically and not in git. |

---

## Everyday use

**See what it would send, without sending anything:**
```bash
node ~/assignment-reminder/remind.js --dry-run          # daily
node ~/assignment-reminder/remind.js --week --dry-run   # weekly
```

**Send for real, right now:**
```bash
node ~/assignment-reminder/remind.js
node ~/assignment-reminder/remind.js --week
```

**Check what happened on past runs:**
```bash
cat ~/assignment-reminder/reminder.log
```

**Change when it runs:** edit `Hour` / `Minute` (and `Weekday` for the weekly one: 0 or 7 = Sunday, 6 = Saturday) in the `.plist`, then reload it. For example, for the daily reminder:
```bash
cp com.williamtobin.assignment-reminder.plist ~/Library/LaunchAgents/
launchctl bootout   gui/$(id -u) ~/Library/LaunchAgents/com.williamtobin.assignment-reminder.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.williamtobin.assignment-reminder.plist
```
For the weekly summary, run the same commands with `com.williamtobin.assignment-reminder.weekly.plist`.

**Run the two-way bot** (stop it with Ctrl+C):
```bash
~/assignment-reminder/start-bot.sh
```

**Try a bot command without WhatsApp:**
```bash
node ~/assignment-reminder/bot.js --test week
```

**Turn one off:**
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.williamtobin.assignment-reminder.plist          # daily
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.williamtobin.assignment-reminder.weekly.plist   # weekly
```

---

## Setting it up from scratch

### 1. Moodle access

The script reuses the login from [moodle-mcp](https://github.com/IsaacAnwar/moodle-mcp). It reads the site URL and token from `~/.moodle-mcp/config.json`. If you don't have that file yet:

```bash
node ~/moodle-mcp/setup.js https://ecampus.esade.edu
```

### 2. WhatsApp (Meta Cloud API)

This is the long part, but you only do it once.

1. **Create an app.** Go to [developers.facebook.com/apps](https://developers.facebook.com/apps), click *Create App*, pick the *"Connect with customers through WhatsApp"* use case, and connect a business portfolio.
2. **Get a test number.** In the app, open *Use cases → Connect on WhatsApp → Step 1. Try it out*. This gives you a free sender number, plus its **Phone Number ID** and **WhatsApp Business Account ID**. Add your own phone number as a recipient.
3. **Create the message template.** In WhatsApp Manager → *Message templates* → *Create template*, choose Category **Utility**, Language **English**, and name it `deadline`:
   - **Body:**
     ```
     📌 Assignment: *{{1}}*
     📘 Course: _{{2}}_
     ⏰ Deadline: {{3}}
     Still not submitted.
     ```
   - **Button:** *Visit website*, text `Open in Moodle`, dynamic URL `https://ecampus.esade.edu/{{1}}`.

   Submit it for review. Approval usually takes from a few minutes to a few hours, but can take up to 48 hours.

   Meta checks two rules straight away. First, a variable can't be the very first or last thing in the body. Second, a body that's mostly variables is rejected ("too many variables for its length"). That's why the template has labels and the closing line.
4. **Get a permanent access token.** In Business Settings → *Users → System users*:
   - Create a system user (Employee role is fine).
   - Use *Assign assets* to give it **full control of both the app and the WhatsApp account**. If you only assign the WhatsApp account, the token screen will say "No permissions available".
   - Click *Generate token*: pick the app, set expiration **Never**, and tick `whatsapp_business_messaging` and `whatsapp_business_management`.
5. **Register the sender number.** This is a one-time API call that also sets a 6-digit PIN:
   ```bash
   curl -X POST "https://graph.facebook.com/v25.0/<PHONE_NUMBER_ID>/register" \
     -H "Authorization: Bearer <ACCESS_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"messaging_product":"whatsapp","pin":"<6 DIGITS>"}'
   ```
   If you skip this step, sending fails with `(#133010) Account not registered`.

### 3. Config

```bash
cp config.example.json config.json
chmod 600 config.json   # only your user can read it
```

Then fill in `config.json`:

| Key | Where to find it |
|---|---|
| `access_token` | The system-user token from step 4 |
| `phone_number_id` | *Try it out* page (the sender's ID, not the phone number itself) |
| `whatsapp_business_account_id` | *Try it out* page |
| `send_to` | Your WhatsApp number, digits only with country code, e.g. `34612345678` |
| `template_name` | `deadline` |
| `template_language` | `en` |
| `pin` | The PIN you chose in step 5 (kept here just so you don't lose it) |
| `app_id` | Bot only. Your app's ID, shown at the top of the app dashboard |
| `app_secret` | Bot only. *App settings → Basic → App secret → Show* |
| `webhook_verify_token` | Bot only. Any long random string, e.g. the output of `openssl rand -hex 24` |

For the bot you also need `cloudflared`: `brew install cloudflared`.

### 4. Schedule it

```bash
cp com.williamtobin.assignment-reminder.plist com.williamtobin.assignment-reminder.weekly.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.williamtobin.assignment-reminder.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.williamtobin.assignment-reminder.weekly.plist
```

Each `.plist` has absolute paths (`/usr/local/bin/node` and `/Users/william.tobin/...`). Change them if your setup is different. Run `which node` to find the right Node path.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Moodle error: Invalid token` | Your Moodle password probably changed. Re-run `node ~/moodle-mcp/setup.js https://ecampus.esade.edu`. |
| `(#133010) Account not registered` | Do step 5 (register the sender number). |
| `(#132001) Template name does not exist` | The template isn't approved yet, or the name or language in `config.json` doesn't match. |
| `(#190) Invalid OAuth access token` | The token was revoked or copied wrong. Generate a new one (step 4). |
| No message, and the log says "Nothing to remind you about." | Working as intended 🎉 |
| No message, and nothing in the log | The Mac was switched off at the scheduled time. launchd only catches up on runs missed while the Mac was asleep, not while it was off. |
| Bot doesn't answer | It only works while `start-bot.sh` is running and the Mac is awake. Check its output for "Rejected a request with a bad signature" (wrong `app_secret`) or "Ignored a message from another number" (`send_to` doesn't match). |
| `connect-webhook.js`: "Meta could not reach …" | The new tunnel address wasn't ready yet. Stop and run `start-bot.sh` again. |

---

## Notes

- **Cost:** sending Utility template messages to yourself costs nothing or close to nothing at this volume, but Meta's pricing can change.
- **Privacy:** your Moodle token and WhatsApp token never leave your Mac, except to talk to Moodle and Meta directly.
- **Time zone:** "tomorrow" and the times in the message use `Europe/Madrid`. Change `TIMEZONE` at the top of `remind.js` if you need another one.
- **Already submitted?** No reminder. Moodle only reports work you still have to do, so anything you hand in early is skipped automatically.
