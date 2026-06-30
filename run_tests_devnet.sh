#!/bin/bash
set -e

DEVNET_URL="https://devnet.helius-rpc.com/?api-key=f647e068-f623-4812-ab0a-30b319952c1f"

echo "Compiling TypeScript..."
node_modules/.bin/tsc \
  --module commonjs \
  --esModuleInterop \
  --resolveJsonModule \
  --target es2020 \
  --skipLibCheck \
  --outDir dist \
  tests/zdlt_vault.ts

echo "Running tests against devnet..."
ANCHOR_PROVIDER_URL="$DEVNET_URL" \
ANCHOR_WALLET="$(dirname "$0")/test-payer.json" \
  node_modules/.bin/mocha \
    --timeout 120000 \
    "dist/zdlt_vault.js"
