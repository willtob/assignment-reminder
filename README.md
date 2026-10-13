# 📚 Assignment Reminder

WhatsApp reminders for my ESADE Moodle (eCampus) assignments, plus a WhatsApp bot I can ask questions about my courses.

There are two parts:

1. **Reminders.** Every afternoon, I get a WhatsApp message for each assignment that's due soon or overdue. They run on GitHub, so my Mac can be off.
2. **The bot (optional).** I text a question like *"what are my grades in finance?"* and it looks up the answer in Moodle. It runs on my Mac, so it only works while the Mac is on and the bot is started.

---

## The reminders

A reminder looks like this:

> 📌 Assignment: **Block2_Compulsory Homework 202(Springs)**
> 📘 Course: _Corporate Finance & Financial Valuation_
> ⏰ Deadline: Tomorrow 14:00
> Still not submitted.
> [ Open in Moodle ]

| When | What I get |
|---|---|
| **Every day at 14:30** | Anything due later today or tomorrow |
| **Saturdays at 10:00** | Everything due in the next 7 days |

Both also include **overdue work**: assignments from the last 7 days that are past their deadline and still not submitted.

- **Nothing due?** No message.
- **Already handed it in?** No reminder for it. Moodle only reports work I still have to do.
- **Times** are always Madrid time, even when I'm travelling.

---

## The bot

### Starting it

On the Mac, in Terminal:

```bash
~/assignment-reminder/start-bot.sh
```

Wait until it says **"Ready."** (about 10 to 20 seconds). Then text the bot's WhatsApp number. To stop it, press **Ctrl+C**.

The bot stops when the Terminal window closes or the Mac goes to sleep.

### What to send it

| I send | It replies with |
|---|---|
| `due` | Overdue work, plus anything due today or tomorrow (the same as the daily reminder) |
| `week` | Overdue work, plus the next 7 days (the same as the Saturday reminder) |
| `help` | The list of commands |
| `reset` | Starts a fresh conversation. The bot forgets what we talked about. |
| **Anything else** | Treated as a question, and the AI looks up the answer in Moodle |

Example questions:

- *"What are my grades in Programming with Data?"*
- *"What feedback did I get on the Springs homework?"*
- *"What's due in statistics this month?"*
- *"Any new announcements in Software Development?"*

Tips:

- **Grades:** name the course. The bot lists each graded item (homework, exams…) with its mark. It never shows Moodle's overall course total, because that number isn't accurate.
- **Older courses work too,** e.g. *"my grade in the Computing Foundations final exam"*.
- **Follow-up questions work.** The bot remembers the last 10 messages, so *"and the exam?"* is fine. Restarting the bot or sending `reset` clears its memory.
- **It can only read Moodle.** It can't submit, change or download anything.
- **Only my number gets answers.** Messages from anyone else are ignored.

---

## How it works

### Reminders

```
 GitHub Actions ──(14:30)──▶ remind.js ──"what's due?"──▶ Moodle
                                 │
                                 └──one message per assignment──▶ WhatsApp ──▶ 📱
```

1. At 14:30, **GitHub Actions** runs `remind.js` on one of GitHub's computers.
2. `remind.js` asks **Moodle** for all deadlines from 7 days ago to 7 days ahead. It keeps the ones that matter today.
3. For each one, it sends a WhatsApp message through **Meta's official WhatsApp Cloud API**.

On Saturdays, it runs `remind.js --week`, which looks 7 days ahead instead.

**Why one message per assignment?** Businesses can only start a WhatsApp chat using a pre-approved message *template*. Templates don't allow line breaks inside the filled-in parts, so a neat list in one message isn't possible.

**Why does the schedule have two times per reminder?** GitHub schedules use UTC, but Madrid changes between UTC+1 and UTC+2 in summer and winter. So there's a summer trigger and a winter trigger. The first step of the workflow skips whichever one doesn't match the current season. The result is exactly one reminder a day, all year, with nothing to change when the clocks change.

### The bot

The bot works the other way round. Instead of my script contacting WhatsApp, **WhatsApp contacts my Mac** whenever I send the bot a message.

```
 📱 "my grades in finance?"
   │
   ▼
 WhatsApp ──▶ Cloudflare tunnel ──▶ bot.js (on my Mac) ──▶ OpenAI: "which Moodle tool do I need?"
                                       │
                                       ├──▶ moodle-mcp ──▶ Moodle   (look up the grades)
                                       │
 📱 ◀── WhatsApp ◀── the answer ◀───────┘
```

`start-bot.sh` starts three things:

1. **`bot.js`**: a small web server on the Mac that receives messages and replies.
2. **A Cloudflare tunnel**: a free, temporary public web address that leads to that server. WhatsApp needs a public address, and this means no router setup. The address changes every time the bot starts.
3. **`connect-webhook.js`**: tells Meta the new address, so it knows where to send messages.

Commands like `due` and `week` are answered directly. Everything else goes to **OpenAI** (`ai.js`), which can use the tools from [moodle-mcp](https://github.com/IsaacAnwar/moodle-mcp). These are the same Moodle tools Claude uses. OpenAI picks a tool (for example, "get the grades for Corporate Finance"), `ai.js` runs it, and OpenAI writes the answer from the result. It can repeat this up to 6 times per question. While it works, WhatsApp shows *typing…*.

**Safety:**

- Meta signs every message it sends with the app secret, and the bot rejects anything with a wrong signature, so nobody else can send it fake messages.
- The bot only answers my own number.
- The AI can only read Moodle. The two moodle-mcp tools that save files to the computer are switched off.

**Cost:** each question costs a fraction of a cent on OpenAI. Replies are free on WhatsApp, because I texted first.

---

## Files

| File | What it does |
|---|---|
| `remind.js` | Sends the reminders. `--week` looks 7 days ahead, and `--dry-run` prints them instead of sending. |
| `moodle.js` | Shared Moodle code: gets deadlines and works out which ones are overdue, today, tomorrow or this week. |
| `bot.js` | The bot: receives WhatsApp messages and replies. |
| `ai.js` | Answers questions using OpenAI and moodle-mcp. |
| `start-bot.sh` | Starts the bot, the tunnel and the Meta connection. **Use this to run the bot.** |
| `connect-webhook.js` | Tells Meta the bot's current address (run by `start-bot.sh`). |
| `.github/workflows/reminders.yml` | The reminder schedule on GitHub. |
| `config.example.json` | Template for the settings file. |
| `config.json` | My real settings and passwords. **Never in git.** |
| `*.plist` | Only for running the reminders on the Mac instead of GitHub (see the end of the setup). |
| `tunnel.log` | Output from the tunnel, created automatically. Not in git. |

Everything is plain Node.js (version 18 or newer), with nothing to install with `npm`.

---

## Everyday commands

**Check which reminders would be sent right now, without sending them:**
```bash
node ~/assignment-reminder/remind.js --dry-run          # daily
node ~/assignment-reminder/remind.js --week --dry-run   # weekly
```

**Ask the bot something without using WhatsApp** (prints the answer in Terminal):
```bash
node ~/assignment-reminder/bot.js --test week
node ~/assignment-reminder/bot.js --test "what is due in statistics this month?"
```
Keep the quotes: without them, zsh treats `?` as a special character and gives an error.

**Run the reminders on GitHub by hand.** This is a dry run unless you add `-f dry_run=false`:
```bash
gh workflow run reminders.yml -f mode=daily     # or mode=weekly
```
Or on the website: *Actions → Reminders → Run workflow*.

**See past runs:** `gh run list --workflow reminders.yml`, then `gh run view --log`. GitHub also emails you if a run fails.

**Turn the reminders off:** `gh workflow disable reminders.yml` (or *Actions → Reminders → ⋯ → Disable workflow*).

**Changed `config.json`?** Upload it to GitHub again (setup step 4). Otherwise GitHub keeps using the old settings.

**Change the reminder times:** edit the `cron` lines in `.github/workflows/reminders.yml`. They're in **UTC**, with a summer line and a winter line for each reminder. Change both, plus the matching lines in the "Decide" step. For example, 15:00 Madrid time is `0 13 * * *` in summer and `0 14 * * *` in winter.

---

## Setting it up from scratch

You only do this once. Step 2 (Meta) is the long part.

### 1. Moodle access

The scripts reuse the Moodle login from [moodle-mcp](https://github.com/IsaacAnwar/moodle-mcp), stored in `~/.moodle-mcp/config.json`. If you don't have that file yet:

```bash
node ~/moodle-mcp/setup.js https://ecampus.esade.edu
```

### 2. WhatsApp (Meta Cloud API)

1. **Create an app** at [developers.facebook.com/apps](https://developers.facebook.com/apps). Choose *Create App*, then the *"Connect with customers through WhatsApp"* use case, and connect a business portfolio.
2. **Get a free test number.** In the app, go to *Use cases → Connect on WhatsApp → Step 1. Try it out*. Note the **Phone Number ID** and **WhatsApp Business Account ID**, and add your own phone number as a recipient.
3. **Create the message template.** In WhatsApp Manager, go to *Message templates → Create template*. Choose **Utility**, **English**, and name it `deadline`.
   - **Body:**
     ```
     📌 Assignment: *{{1}}*
     📘 Course: _{{2}}_
     ⏰ Deadline: {{3}}
     Still not submitted.
     ```
   - **Button:** *Visit website*, with the text `Open in Moodle` and the dynamic URL `https://ecampus.esade.edu/{{1}}`.

   Approval takes from a few minutes up to 48 hours. Meta rejects a body that starts or ends with a `{{…}}` or that's mostly `{{…}}`s. That's why the template has labels and a last line.
4. **Get a permanent access token.** In Business Settings → *Users → System users*:
   - Create a system user (the Employee role is fine).
   - Under *Assign assets*, give it full control of **both the app and the WhatsApp account**. With only the WhatsApp account, the token screen says "No permissions available".
   - Click *Generate token*. Pick the app, set expiry to **Never**, and tick `whatsapp_business_messaging` and `whatsapp_business_management`.
5. **Register the sender number.** This is a one-time step that also sets a 6-digit PIN of your choice:
   ```bash
   curl -X POST "https://graph.facebook.com/v25.0/<PHONE_NUMBER_ID>/register" \
     -H "Authorization: Bearer <ACCESS_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"messaging_product":"whatsapp","pin":"<6 DIGITS>"}'
   ```
   Without this, sending fails with `(#133010) Account not registered`.

### 3. The settings file

```bash
cp config.example.json config.json
chmod 600 config.json   # only your user can read it
```

Then fill in `config.json`:

| Setting | Where to find it |
|---|---|
| `access_token` | The token from step 2, part 4 |
| `phone_number_id` | The *Try it out* page. This is the sender's ID, not the phone number. |
| `whatsapp_business_account_id` | The *Try it out* page |
| `send_to` | Your WhatsApp number, digits only with country code, e.g. `34612345678` |
| `template_name` | `deadline` |
| `template_language` | `en` |
| `pin` | The PIN from step 2, part 5 (stored here only so you don't lose it) |
| `app_id` | *Bot only.* The app's ID, shown at the top of the app dashboard |
| `app_secret` | *Bot only.* *App settings → Basic → App secret → Show* |
| `webhook_verify_token` | *Bot only.* Any long random text, e.g. from `openssl rand -hex 24` |
| `openai_api_key` | *Bot only.* Create one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `openai_model` | *Bot only.* Which OpenAI model to use (default `gpt-5-mini`) |
| `moodle_mcp_path` | *Bot only.* Leave empty to use `~/moodle-mcp/server.js` |

The bot also needs the Cloudflare tunnel program: `brew install cloudflared`.

### 4. Put the settings on GitHub

The reminder schedule is already in the repo. GitHub only needs your settings, stored as two encrypted **secrets**. These commands copy just the settings the reminders need, without printing them:

```bash
node -e 'const c = require("./config.json"); process.stdout.write(JSON.stringify({ access_token: c.access_token, phone_number_id: c.phone_number_id, send_to: c.send_to, template_name: c.template_name, template_language: c.template_language }))' | gh secret set WHATSAPP_CONFIG
node -e 'const m = require(require("os").homedir() + "/.moodle-mcp/config.json"); process.stdout.write(JSON.stringify({ url: m.url, token: m.token }))' | gh secret set MOODLE_CONFIG
```

Test it with a dry run: `gh workflow run reminders.yml -f mode=weekly`.

This is free: each run takes under a minute, and private repositories get 2,000 free minutes a month.

### Alternative: run the reminders on the Mac instead

macOS's built-in scheduler (**launchd**) can run the reminders instead of GitHub. They only arrive if the Mac is on at 14:30, and the output goes to `reminder.log`. **Don't use both**, or every message arrives twice.

```bash
cp com.williamtobin.assignment-reminder.plist com.williamtobin.assignment-reminder.weekly.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.williamtobin.assignment-reminder.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.williamtobin.assignment-reminder.weekly.plist
```

To stop: run `launchctl bootout` with the same paths, then delete the two files from `~/Library/LaunchAgents`. The `.plist` files contain full paths (`/usr/local/bin/node` and `/Users/william.tobin/...`). Change them if yours differ; `which node` shows the right Node path.

---

## Troubleshooting

**Reminders**

| What you see | What to do |
|---|---|
| `Moodle error: Invalid token` | Your Moodle password probably changed. Run `node ~/moodle-mcp/setup.js https://ecampus.esade.edu` again, then upload the secrets again (setup step 4). |
| `(#133010) Account not registered` | Do setup step 2, part 5. |
| `(#132001) Template name does not exist` | The template isn't approved yet, or its name or language doesn't match `config.json`. |
| `(#190) Invalid OAuth access token` | The token was revoked or copied wrong. Make a new one (setup step 2, part 4), then upload the settings again (setup step 4). |
| "Nothing to remind you about." | Nothing is due. All good 🎉 |
| The message arrived late | GitHub sometimes starts scheduled runs 5 to 30 minutes late. That's normal. |
| "Skipping: this trigger is for Madrid UTC…" | Normal. That's the other season's trigger. |
| Errors after changing `config.json` | GitHub still has the old settings. Upload them again (setup step 4). |

**Bot**

| What you see | What to do |
|---|---|
| No reply at all | Is `start-bot.sh` running and did it say "Ready."? Is the Mac awake? |
| "Rejected a request with a bad signature" in Terminal | `app_secret` in `config.json` is wrong. Copy it again. |
| "Ignored a message from another number" in Terminal | You texted from a number that isn't `send_to`. |
| "attempt 1 failed … Failed to resolve host" when starting | Normal. The new tunnel address takes a few seconds to go live, and the next attempt works. |
| "Meta could not reach …" and the script stops | The tunnel never came up. Press Ctrl+C and run `start-bot.sh` again. |
| The bot replies "Something went wrong: OpenAI error: …" | Usually a wrong `openai_api_key`, no OpenAI credit left, or a model name that doesn't exist. The message says which. |
| It can't find a course | Use part of the course's real name as Moodle shows it, e.g. "Statistics and Probability" rather than a topic inside it. |

---

## Notes

- **Privacy:** the Moodle and WhatsApp passwords for the reminders are stored as encrypted GitHub secrets. GitHub hides them in the logs. The repo is private, but anyone given write access could read them through a workflow. Questions sent to the bot, and the Moodle data needed to answer them, go to OpenAI.
- **Cost:** reminder messages to yourself cost nothing or close to nothing at this volume, but Meta's prices can change. Bot questions cost a fraction of a cent each on OpenAI.
- **Time zone:** everything uses `Europe/Madrid`. To change it, edit `TIMEZONE` at the top of `moodle.js` and the cron times.
