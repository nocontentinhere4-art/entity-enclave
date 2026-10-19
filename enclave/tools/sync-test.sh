#!/usr/bin/env bash
# Phase 1 check: can the testnet wallet go online and sync? (mixnet only if NYM_PROXY points to a nym-proxy binary)
# Usage: tools/sync-test.sh [server]   (defaults to testnet.zec.rocks)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
Z="${ZINGO_BIN:-$ROOT/vendor/zingolib/target/release/zingo-cli}"
P="${NYM_PROXY:-}"
S="${1:-https://testnet.zec.rocks:443}"
D="${STATE_DIR:-$ROOT/enclave/state}/zcash"
test -x "$Z" || { echo "missing zingo-cli at $Z"; exit 1; }
echo "wallet dir: $D"
echo "== info (online, mixnet, wait for startup sync)"
time "$Z" --data-dir "$D" --chain testnet --online --server "$S" ${P:+--nym-proxy "$P"} --waitsync info 2>&1 | tail -20
echo "== balance (offline)"
"$Z" --data-dir "$D" --chain testnet --offline --nosync balance 2>&1 | grep -E "total_|confirmed_orchard" | head -6
