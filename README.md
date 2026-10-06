# 📚 Assignment Reminder

Get a WhatsApp message the day before a Moodle assignment is due.

Every day at **14:30**, a small script on my Mac checks ESADE's Moodle (eCampus) for anything due **tomorrow**. For each assignment it finds, it sends me a WhatsApp message like this:

> 📚 Reminder: Homework 202 (Springs) for Corporate Finance is due tomorrow at 14:00. Good luck!

If nothing is due, it doesn't send anything.

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
2. **`remind.js`** asks Moodle for every deadline in the next 3 days and keeps only the ones due tomorrow (Madrid time).
3. For each one, it sends a message through Meta's official **WhatsApp Cloud API**, using a pre-approved message template.

The script has **no dependencies**. It's plain Node.js (v18 or newer), using the built-in `fetch`.

---

## Files

| File | What it is |
|---|---|
| `remind.js` | The main script. Reads Moodle and sends the WhatsApp messages. |
| `config.example.json` | Template for your settings. Copy it to `config.json` and fill it in. |
| `config.json` | Your real settings and secrets. **Not in git** (see `.gitignore`). |
| `com.williamtobin.assignment-reminder.plist` | The launchd schedule (runs the script daily at 14:30). |
| `wait-for-approval.sh` | One-off helper: waits until Meta approves the template, then sends a test message. |
| `reminder.log` | Output from each daily run. Created automatically and not in git. |

---

## Everyday use

**See what it would send, without sending anything:**
```bash
node ~/assignment-reminder/remind.js --dry-run
```

**Send for real, right now:**
```bash
node ~/assignment-reminder/remind.js
```

**Check what happened on past runs:**
```bash
cat ~/assignment-reminder/reminder.log
```

**Change the time it runs:** edit `Hour` / `Minute` in the `.plist`, then reload it:
```bash
cp com.williamtobin.assignment-reminder.plist ~/Library/LaunchAgents/
launchctl bootout   gui/$(id -u) ~/Library/LaunchAgents/com.williamtobin.assignment-reminder.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.williamtobin.assignment-reminder.plist
```

**Turn it off:**
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.williamtobin.assignment-reminder.plist
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
3. **Create the message template.** In WhatsApp Manager → *Message templates* → *Create template*:
   - Category: **Utility**
   - Name: `assignment_reminder`
   - Language: **English**
   - Body: `📚 Reminder: {{1}} for {{2}} is due tomorrow at {{3}}. Good luck!`

   Submit it for review. Approval usually takes from a few minutes to a few hours.
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
| `template_name` | `assignment_reminder` |
| `template_language` | `en` |
| `pin` | The PIN you chose in step 5 (kept here just so you don't lose it) |

### 4. Schedule it

```bash
cp com.williamtobin.assignment-reminder.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.williamtobin.assignment-reminder.plist
```

The `.plist` has absolute paths (`/usr/local/bin/node` and `/Users/william.tobin/...`). Change them if your setup is different. Run `which node` to find the right Node path.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Moodle error: Invalid token` | Your Moodle password probably changed. Re-run `node ~/moodle-mcp/setup.js https://ecampus.esade.edu`. |
| `(#133010) Account not registered` | Do step 5 (register the sender number). |
| `(#132001) Template name does not exist` | The template isn't approved yet, or the name or language in `config.json` doesn't match. |
| `(#190) Invalid OAuth access token` | The token was revoked or copied wrong. Generate a new one (step 4). |
| No message, and the log says "Nothing due tomorrow" | Working as intended 🎉 |
| No message, and nothing in the log | The Mac was switched off at 14:30. launchd only catches up on runs missed while the Mac was asleep, not while it was off. |

---

## Notes

- **Cost:** sending Utility template messages to yourself costs nothing or close to nothing at this volume, but Meta's pricing can change.
- **Privacy:** your Moodle token and WhatsApp token never leave your Mac, except to talk to Moodle and Meta directly.
- **Time zone:** "tomorrow" and the times in the message use `Europe/Madrid`. Change `TIMEZONE` at the top of `remind.js` if you need another one.
