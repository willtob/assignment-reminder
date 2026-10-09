# 📚 Assignment Reminder

Get WhatsApp messages about upcoming Moodle assignments.

A small script running on **GitHub Actions** (so my Mac can be off) checks ESADE's Moodle (eCampus) and sends me **one WhatsApp message per assignment** I still have to do:

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

---

## How it works

```
 ┌────────────┐   14:30 every day   ┌──────────────┐   "what's due?"   ┌──────────┐
 │  GitHub    │ ──────────────────▶ │  remind.js   │ ────────────────▶ │  Moodle  │
 │  Actions   │                     │              │ ◀──────────────── │ eCampus  │
 └────────────┘                     │              │   list of events  └──────────┘
                                    │              │
                                    │              │   template msg    ┌──────────┐
                                    │              │ ────────────────▶ │ WhatsApp │ ──▶ 📱
                                    └──────────────┘                   │ Cloud API│
                                                                       └──────────┘
```

1. **GitHub Actions** starts `remind.js` at 14:30 on one of GitHub's servers (see `.github/workflows/reminders.yml`). It first rebuilds the two settings files from the repository's encrypted secrets.
2. **`remind.js`** asks Moodle for every deadline from 7 days ago to 7 days ahead. It keeps the ones due later today or tomorrow (Madrid time), plus overdue assignments.
3. For each one, it sends a message through Meta's official **WhatsApp Cloud API**, using the pre-approved `deadline` message template.

On Saturdays at 10:00 it runs `remind.js --week`, which keeps everything due in the next 7 days instead of just today and tomorrow.

**Summer and winter time:** GitHub schedules only use UTC, but Madrid is UTC+2 in summer and UTC+1 in winter. So the workflow has two triggers per reminder, one for each season, and its first step skips whichever one doesn't match Madrid's current offset. You get exactly one run per day all year, with no edits when the clocks change.

Why one message per assignment? WhatsApp doesn't allow line breaks inside a template value, so a single message with a readable list isn't possible.

The script has **no dependencies**. It's plain Node.js (v18 or newer), using the built-in `fetch`.

---

## Files

| File | What it is |
|---|---|
| `remind.js` | Reads Moodle and sends one message per assignment. `--week` looks 7 days ahead instead of 1. |
| `moodle.js` | Shared Moodle code: fetches deadlines, decides which ones count (overdue, today, tomorrow, week) and words them. |
| `config.example.json` | Template for your settings. Copy it to `config.json` and fill it in. |
| `config.json` | Your real settings and secrets. **Not in git** (see `.gitignore`). |
| `.github/workflows/reminders.yml` | The schedule: runs `remind.js` daily at 14:30 and `remind.js --week` on Saturdays at 10:00 (Madrid time). |
| `com.williamtobin.assignment-reminder*.plist` | Only for running on your Mac instead of GitHub (see the end of the setup section). |

---

## Everyday use

**Run it on GitHub by hand** (dry run by default; add `-f dry_run=false` to really send):
```bash
gh workflow run reminders.yml -f mode=daily     # or mode=weekly
```
You can also do this from the website: *Actions → Reminders → Run workflow*.

**Check what happened on past runs:**
```bash
gh run list --workflow reminders.yml    # list of runs
gh run view --log                       # pick one and see its output
```
GitHub emails you when a run fails.

**See what it would send, from your Mac, without sending anything:**
```bash
node ~/assignment-reminder/remind.js --dry-run          # daily
node ~/assignment-reminder/remind.js --week --dry-run   # weekly
```

**Send for real from your Mac, right now:**
```bash
node ~/assignment-reminder/remind.js
node ~/assignment-reminder/remind.js --week
```

**Change when it runs:** edit the `cron` lines in `.github/workflows/reminders.yml`. The times are in **UTC**, and each reminder has a summer line and a winter line. Change both, and update the matching lines in the `case` block of the "Decide" step so they stay identical. For example, 15:00 Madrid is `0 13 * * *` (summer) and `0 14 * * *` (winter).

**Turn it off:** *Actions → Reminders → ⋯ → Disable workflow*, or `gh workflow disable reminders.yml`.

**Changed a setting in `config.json`?** Upload it to GitHub again (see step 4 of the setup).

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

### 4. Schedule it on GitHub

The workflow is already in the repo. It only needs your settings, stored as two encrypted **repository secrets**. These commands copy just the keys the reminder needs, without printing them:

```bash
node -e 'const c = require("./config.json"); process.stdout.write(JSON.stringify({ access_token: c.access_token, phone_number_id: c.phone_number_id, send_to: c.send_to, template_name: c.template_name, template_language: c.template_language }))' | gh secret set WHATSAPP_CONFIG
node -e 'const m = require(require("os").homedir() + "/.moodle-mcp/config.json"); process.stdout.write(JSON.stringify({ url: m.url, token: m.token }))' | gh secret set MOODLE_CONFIG
```

Then test it with a dry run: `gh workflow run reminders.yml -f mode=weekly`.

GitHub Actions is free for this. Each run takes well under a minute, and private repositories get 2,000 free minutes a month.

### Alternative: run it on your Mac instead

If you'd rather not use GitHub, macOS's built-in scheduler, **launchd**, can run it. It only works while the Mac is on, and output goes to `reminder.log`. **Don't run both**, or you'll get every message twice.

```bash
cp com.williamtobin.assignment-reminder.plist com.williamtobin.assignment-reminder.weekly.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.williamtobin.assignment-reminder.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.williamtobin.assignment-reminder.weekly.plist
```

To stop it, run `launchctl bootout` with the same paths and delete the two files from `~/Library/LaunchAgents`.

Each `.plist` has absolute paths (`/usr/local/bin/node` and `/Users/william.tobin/...`). Change them if your setup is different. Run `which node` to find the right Node path.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Moodle error: Invalid token` | Your Moodle password probably changed. Re-run `node ~/moodle-mcp/setup.js https://ecampus.esade.edu`. |
| `(#133010) Account not registered` | Do step 5 (register the sender number). |
| `(#132001) Template name does not exist` | The template isn't approved yet, or the name or language in `config.json` doesn't match. |
| `(#190) Invalid OAuth access token` | The token was revoked or copied wrong. Generate a new one (step 4). |
| No message, and the run's output says "Nothing to remind you about." | Working as intended 🎉 |
| The message arrived a bit late | GitHub sometimes starts scheduled runs 5 to 30 minutes late, especially at busy times. That's normal. |
| A run says "Skipping: this trigger is for Madrid UTC…" | Normal. That's the other season's trigger. |
| Errors after changing `config.json` or your Moodle password | GitHub still has the old values. Upload the secrets again (setup step 4). |

---

## Notes

- **Cost:** sending Utility template messages to yourself costs nothing or close to nothing at this volume, but Meta's pricing can change.
- **Privacy:** your Moodle token and WhatsApp token are stored as encrypted GitHub secrets. GitHub hides them in run logs, and they're only used to talk to Moodle and Meta. The repository is private, but anyone you give write access could read them through a workflow.
- **Time zone:** "tomorrow" and the times in the message use `Europe/Madrid`. Change `TIMEZONE` at the top of `moodle.js` (and the cron times) if you need another one.
- **Already submitted?** No reminder. Moodle only reports work you still have to do, so anything you hand in early is skipped automatically.
