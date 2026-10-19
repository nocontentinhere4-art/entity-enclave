#!/usr/bin/env bash
# Local smoke run: fake brain + fake wallet, no zingo-cli and no chain. Waits for six ticks, then dumps the
# public view and the ledger summary and stops the service. Everything lives in a throwaway state dir.
# Usage: tools/run-fake.sh   (override PORT / FAKE_BALANCE_ZATS / STATE_DIR through the environment)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STATE="${STATE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/sov-fake.XXXXXX")}"
PORT="${PORT:-8799}"
LEDGER="$STATE/ledger.jsonl"
mkdir -p "$STATE"

# The fake run is alive: an explicit pause file with paused=false (unset would fail closed).
printf '%s' '{"paused":false}' > "$STATE/pause.json"

export STATE_DIR="$STATE"
export PORT
export PAUSE_FILE="$STATE/pause.json"
export CHARTER_PATH="$ROOT/charter.md"
export ALLOW_DEV=1 FAKE_LLM=1 FAKE_WALLET=1
export TICK_MS=2000 HUNGER_TICK_MS=2000
export FAKE_BALANCE_ZATS="${FAKE_BALANCE_ZATS:-5000000}"
# Any 32-byte x25519 public key works here: it only encrypts private entries at rest.
export ARCHIVE_PUBKEY="${ARCHIVE_PUBKEY:-c1e8f8b399500f35273dfc0ce126b64c630b52947023811fab929004ed975837}"

echo "state: $STATE   port: $PORT"
node "$ROOT/src/index.mjs" &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true' EXIT

ticks=0
for _ in $(seq 1 450); do
  if [ -f "$LEDGER" ]; then ticks=$(grep -c '"type":"tick"' "$LEDGER" || true); fi
  [ "${ticks:-0}" -ge 6 ] && break
  sleep 0.2
done
echo "ticks seen: ${ticks:-0}"

# The HTTP view is up once /verify answers.
for _ in $(seq 1 50); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/verify" || true)
  [ "$code" = "200" ] && break
  sleep 0.2
done

echo
echo "== GET /vitals";         curl -s "http://127.0.0.1:$PORT/vitals"; echo
echo "== GET /public-channel"; curl -s "http://127.0.0.1:$PORT/public-channel"; echo
echo "== GET /verify";         curl -s "http://127.0.0.1:$PORT/verify"; echo
echo "== ledger entry types"
LEDGER_PATH="$LEDGER" node --input-type=module -e '
import { readFileSync } from "node:fs";
const lines = readFileSync(process.env.LEDGER_PATH, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const counts = {};
for (const e of lines) counts[e.type] = (counts[e.type] ?? 0) + 1;
console.log(JSON.stringify(counts, null, 1));
const charges = new Set(lines.filter((e) => e.type === "charge").map((e) => e.data.action));
const tools = lines.filter((e) => e.type === "tool").map((e) => e.data.name);
const unmatched = [...new Set(tools)].filter((n) => !charges.has(n));
console.log("tool calls:", tools.length, "| not matched by a charge:", JSON.stringify(unmatched));
const ticks = counts.tick ?? 0;
const ok = ticks >= 6 && unmatched.length === 0;
console.log(ok ? "RESULT: OK" : "RESULT: FAIL");
process.exit(ok ? 0 : 1);
'
