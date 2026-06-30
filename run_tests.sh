#!/bin/bash
set -e

PROGRAM_ID="ZDLT77pfYg72vFyvg5PJcXCwWU7xBFv7ypoSEcCddp9"
SO="$(dirname "$0")/target/deploy/zdlt_vault.so"
LEDGER_DIR="/tmp/zdlt-test-ledger"

# Kill any leftover validator from a previous run
pkill -f "solana-test-validator.*zdlt" 2>/dev/null || true
sleep 1

echo "Starting local validator with zdlt_vault.so..."
solana-test-validator \
  --reset \
  --ledger "$LEDGER_DIR" \
  --upgradeable-program "$PROGRAM_ID" "$SO" "${HOME}/.config/solana/id.json" \
  --quiet &
VALIDATOR_PID=$!

cleanup() {
  echo "Stopping validator (pid $VALIDATOR_PID)..."
  kill "$VALIDATOR_PID" 2>/dev/null || true
  wait "$VALIDATOR_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for validator to be ready
echo "Waiting for validator..."
for i in $(seq 1 30); do
  if solana cluster-version --url http://127.0.0.1:8899 &>/dev/null; then
    echo "Validator ready."
    break
  fi
  sleep 1
done

echo "Compiling TypeScript..."
node_modules/.bin/tsc \
  --module commonjs \
  --esModuleInterop \
  --resolveJsonModule \
  --target es2020 \
  --skipLibCheck \
  --outDir dist \
  tests/zdlt_vault.ts

echo "Running tests..."
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
ANCHOR_WALLET="${HOME}/.config/solana/id.json" \
  node_modules/.bin/mocha \
    --timeout 60000 \
    "dist/zdlt_vault.js"
