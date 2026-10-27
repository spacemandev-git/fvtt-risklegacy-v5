#!/bin/bash
# Starts the bots relay for Risk Legacy on the GM's machine. Double-click it in Finder, or run it in a terminal.
# It uses the Node runtime bundled inside the Foundry desktop app, so nothing else needs installing (falls back to `node`).
# - Jev bots: the TypeSafe API key comes from $TYPESAFE_API_KEY or ~/.config/risklegacy/typesafe-key; the first run asks
#   for it and saves it there (readable only by you), unless you only use chat-model bots (a Nous key is present).
# - Chat-model bots (optional; they can also call Nous Portal directly): when ~/.config/risklegacy/nous-key exists (or
#   $RL_NOUS_KEY_FILE), it is passed on and the relay serves /nous/v1. It is never asked for here.
# Extra arguments go to jev-proxy.mjs (e.g. --port 30777, --allow-origin URL).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY_FILE="${RL_JEV_KEY_FILE:-$HOME/.config/risklegacy/typesafe-key}"
NOUS_KEY_FILE="${RL_NOUS_KEY_FILE:-$HOME/.config/risklegacy/nous-key}"
FOUNDRY_BIN="/Applications/Foundry Virtual Tabletop.app/Contents/MacOS/Foundry Virtual Tabletop"

HAVE_NOUS=0
[[ -s "$NOUS_KEY_FILE" ]] && HAVE_NOUS=1

if [[ -z "${TYPESAFE_API_KEY:-}" && ! -s "$KEY_FILE" && "$HAVE_NOUS" == 0 ]]; then
  echo "No TypeSafe API key found. Paste it here (it is saved to $KEY_FILE):"
  read -rs KEY
  [[ -z "$KEY" ]] && { echo "No key entered."; exit 1; }
  mkdir -p "$(dirname "$KEY_FILE")"
  ( umask 077; printf '%s\n' "$KEY" > "$KEY_FILE" )
  unset KEY
fi
ARGS=()
[[ -z "${TYPESAFE_API_KEY:-}" && -s "$KEY_FILE" ]] && ARGS+=(--key-file "$KEY_FILE")
[[ "$HAVE_NOUS" == 1 ]] && ARGS+=(--nous-key-file "$NOUS_KEY_FILE")

if [[ -x "$FOUNDRY_BIN" ]]; then
  exec env ELECTRON_RUN_AS_NODE=1 "$FOUNDRY_BIN" "$HERE/jev-proxy.mjs" ${ARGS[@]+"${ARGS[@]}"} "$@"
elif command -v node >/dev/null; then
  exec node "$HERE/jev-proxy.mjs" ${ARGS[@]+"${ARGS[@]}"} "$@"
else
  echo "Couldn't find the Foundry desktop app or Node.js to run the relay."; exit 1
fi
