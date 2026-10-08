#!/bin/bash
# Starts the two-way WhatsApp bot:
#   1. runs bot.js on this Mac (port 3000)
#   2. opens a free Cloudflare tunnel so Meta can reach it from the internet
#   3. tells Meta the tunnel's address (it changes on every start)
# Press Ctrl+C to stop everything.

cd "$(dirname "$0")"

node bot.js &
BOT_PID=$!

cloudflared tunnel --url http://localhost:3000 2> tunnel.log &
TUNNEL_PID=$!

# When this script stops (Ctrl+C or an error), stop the bot and the tunnel too
trap 'kill $BOT_PID $TUNNEL_PID 2>/dev/null' EXIT

# Wait for cloudflared to print its public address, e.g. https://random-words.trycloudflare.com
URL=""
for i in $(seq 1 30); do
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' tunnel.log | head -1)
  if [ -n "$URL" ]; then
    break
  fi
  sleep 1
done

if [ -z "$URL" ]; then
  echo "The tunnel didn't start. See tunnel.log"
  exit 1
fi
echo "Tunnel: $URL"

node connect-webhook.js "$URL" || exit 1

echo "Ready. Text the bot \"help\" on WhatsApp. Press Ctrl+C to stop."

# Keep running while both are alive. If either one dies, say which and stop the other.
# (kill -0 sends no signal; it only checks that the process still exists.)
while kill -0 $BOT_PID 2>/dev/null && kill -0 $TUNNEL_PID 2>/dev/null; do
  sleep 5
done
if ! kill -0 $TUNNEL_PID 2>/dev/null; then
  echo "The tunnel stopped (see tunnel.log). Run start-bot.sh again."
else
  echo "The bot stopped (see the error above). Run start-bot.sh again."
fi
exit 1
