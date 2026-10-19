#!/usr/bin/env bash
# Local smoke run: fake brain + fake wallet, no zingo-cli and no chain.
# Phase 1: an unfunded first boot must stay UNBORN — waiting_birth on the ledger, /vitals state=unborn,
#          no inference and no charge, no death.
# Phase 2: a funded boot must be born (birth_gift) and then live six normal ticks.
# Everything lives in throwaway state dirs.
# Usage: tools/run-fake.sh   (override PORT / FAKE_BALANCE_ZATS / STATE_DIR through the environment)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-8799}"
export PORT
# Capture the caller's settings before phase 1 overrides them.
BALANCE="${FAKE_BALANCE_ZATS:-5000000}"
BASE_STATE="${STATE_DIR:-}"
export CHARTER_PATH="$ROOT/charter.md"
export ALLOW_DEV=1 FAKE_LLM=1 FAKE_WALLET=1
export TICK_MS=2000 HUNGER_TICK_MS=2000
# Any 32-byte x25519 public key works here: it only encrypts private entries at rest.
export ARCHIVE_PUBKEY="${ARCHIVE_PUBKEY:-c1e8f8b399500f35273dfc0ce126b64c630b52947023811fab929004ed975837}"

PID=""
cleanup() { if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi; }
trap cleanup EXIT

# start_service STATE — fresh pause file, service in the background, waits until /verify answers.
start_service() {
  local state="$1"
  mkdir -p "$state"
  # The fake run is alive: an explicit pause file with paused=false (unset would fail closed).
  printf '%s' '{"paused":false}' > "$state/pause.json"
  export STATE_DIR="$state"
  export PAUSE_FILE="$state/pause.json"
  node "$ROOT/src/index.mjs" &
  PID=$!
  for _ in $(seq 1 50); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/verify" || true)
    [ "$code" = "200" ] && return 0
    sleep 0.2
  done
  echo "service did not come up on :$PORT"
  return 1
}

stop_service() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=""; fi
}

count_ticks() { [ -f "$1" ] && grep -c '"type":"tick"' "$1" || true; }

echo "== PHASE 1: unborn (FAKE_BALANCE_ZATS=0)"
STATE1="$(mktemp -d "${TMPDIR:-/tmp}/sov-unborn.XXXXXX")"
LEDGER1="$STATE1/ledger.jsonl"
echo "state: $STATE1   port: $PORT"
export FAKE_BALANCE_ZATS=0
start_service "$STATE1"

# Let a few ticks happen while the treasury is empty.
for _ in $(seq 1 40); do
  [ -f "$LEDGER1" ] && grep -q '"type":"waiting_birth"' "$LEDGER1" && break
  sleep 0.2
done
sleep 2 # one more TICK_MS, so the loop had every chance to think or die

echo "== GET /vitals (unborn)"; curl -s "http://127.0.0.1:$PORT/vitals"; echo
echo "== ledger entry types (unborn)"
LEDGER_PATH="$LEDGER1" node --input-type=module -e '
import { readFileSync } from "node:fs";
const lines = readFileSync(process.env.LEDGER_PATH, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const counts = {};
for (const e of lines) counts[e.type] = (counts[e.type] ?? 0) + 1;
console.log(JSON.stringify(counts, null, 1));
'
PHASE1_OK=0
if LEDGER_PATH="$LEDGER1" node --input-type=module -e '
import { readFileSync } from "node:fs";
const lines = readFileSync(process.env.LEDGER_PATH, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const of = (t) => lines.filter((e) => e.type === t);
const wait = of("waiting_birth");
const bad = ["tick_llm", "charge", "tool", "tick", "rent_paid", "death"].filter((t) => of(t).length > 0);
const ok = wait.length >= 1 && wait.length <= 1 && wait[0].data.zatoshis === 0 && wait[0].data.needed > 0 && bad.length === 0;
if (!ok) console.log("phase 1 failed:", JSON.stringify({ waiting_birth: wait.length, bad }));
console.log(ok ? "PHASE1: OK" : "PHASE1: FAIL");
process.exit(ok ? 0 : 1);
'; then PHASE1_OK=1; fi
VITALS_STATE=$(curl -s "http://127.0.0.1:$PORT/vitals" | node --input-type=module -e 'let s="";for await (const c of process.stdin) s+=c;try{console.log(JSON.parse(s).state ?? "")}catch{console.log("")}')
echo "vitals state: ${VITALS_STATE:-<none>}"
stop_service

echo
echo "== PHASE 2: born and alive (FAKE_BALANCE_ZATS=5000000)"
STATE2="${BASE_STATE:-$(mktemp -d "${TMPDIR:-/tmp}/sov-fake.XXXXXX")}"
LEDGER2="$STATE2/ledger.jsonl"
echo "state: $STATE2   port: $PORT"
export FAKE_BALANCE_ZATS="$BALANCE"
start_service "$STATE2"

ticks=0
for _ in $(seq 1 450); do
  if [ -f "$LEDGER2" ]; then ticks=$(count_ticks "$LEDGER2"); fi
  [ "${ticks:-0}" -ge 6 ] && break
  sleep 0.2
done
echo "ticks seen: ${ticks:-0}"

echo
echo "== GET /vitals";         curl -s "http://127.0.0.1:$PORT/vitals"; echo
echo "== GET /public-channel"; curl -s "http://127.0.0.1:$PORT/public-channel"; echo
echo "== GET /verify";         curl -s "http://127.0.0.1:$PORT/verify"; echo
echo "== ledger entry types"
if LEDGER_PATH="$LEDGER2" node --input-type=module -e '
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
const births = counts.birth_gift ?? 0;
const ok = ticks >= 6 && births === 1 && unmatched.length === 0;
if (!ok) console.log("phase 2 failed:", JSON.stringify({ ticks, birth_gift: births, unmatched }));
console.log(ok ? "PHASE2: OK" : "PHASE2: FAIL");
process.exit(ok ? 0 : 1);
'; then PHASE2_OK=1; else PHASE2_OK=0; fi
stop_service

echo
if [ "$PHASE1_OK" -eq 1 ] && [ "${VITALS_STATE:-}" = "unborn" ] && [ "$PHASE2_OK" -eq 1 ]; then
  echo "RESULT: OK"
else
  echo "RESULT: FAIL"
  exit 1
fi
