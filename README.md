# ZDLT Vault — Solana Staking Program

On-chain staking vault for the ZDLT token on Solana. Built with [Anchor](https://www.anchor-lang.com/) (v0.30.1).

## Program

| Network | Program ID |
|---------|-----------|
| Mainnet | not yet deployed |
| Devnet  | `ZDLT3oh8VxZJcSTxi1LgG4GqMsiF4jFrQho6hnJj5Gy` |

## Architecture

```
VaultConfig (PDA: "vault_config")
  ├── authority     — API backend keypair; gates force_unstake
  ├── zdlt_mint     — SPL mint address
  ├── bump
  └── vault_auth_bump

vault_authority (PDA: "vault_authority")
  └── owns vault_ata (the pooled ZDLT token account)

StakeAccount (PDA: "stake" ++ stake_id.to_le_bytes())
  ├── owner         — user wallet; receives principal on unstake
  ├── amount        — raw SPL units locked in vault
  ├── unlock_ts     — Unix timestamp after which permissionless unstake is allowed
  ├── stake_id      — mirrors zdlt_stakes.id in the API database
  └── bump
```

### Instructions

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `initialize` | Program upgrade authority | One-time setup: creates VaultConfig and vault ATA. Gated to upgrade authority to prevent front-running. |
| `stake` | User wallet | Transfers ZDLT from user ATA → vault ATA and creates a StakeAccount PDA. |
| `unstake` | User wallet | Permissionless after `unlock_ts`. Returns principal, closes StakeAccount. |
| `force_unstake` | API authority | Bypasses time-lock. Used for early exit; forfeit logic handled in the API layer. |

### PDA Derivation

```
vault_config    = find_pda(["vault_config"],              program_id)
vault_authority = find_pda(["vault_authority"],            program_id)
stake_account   = find_pda(["stake", stake_id.to_le_bytes()], program_id)
```

`stake_id` mirrors the primary key of the `zdlt_stakes` table in the off-chain database, allowing the API to derive the PDA address deterministically without an on-chain lookup.

## Prerequisites

| Tool | Version |
|------|---------|
| Rust | see `rust-toolchain.toml` |
| Solana CLI | 1.18+ |
| Anchor CLI | 0.30.1 |
| Node.js | 18+ |
| Yarn | 1.x |

Install Anchor CLI:
```sh
cargo install anchor-cli --version 0.30.1
```

## Build

```sh
yarn install
anchor build
```

The compiled `.so` is written to `target/deploy/zdlt_seeker_staking.so`.  
The IDL is written to `target/idl/zdlt_seeker_staking.json`.

## Test

### Localnet (recommended for development)

```sh
./run_tests.sh
```

This script starts a local validator with the SPL Token program pre-loaded, deploys the program, and runs the full test suite.

### Devnet

```sh
./run_tests_devnet.sh
```

Requires a funded devnet keypair at `~/.config/solana/id.json` and a valid ZDLT devnet mint. Set `ZDLT_MINT` in the script or as an environment variable before running.

### Manual

```sh
anchor test
```

## Deployment

### First-time deploy

```sh
# 1. Build a verifiable binary (via Docker, reproducible)
solana-verify build --library-name zdlt_seeker_staking

# 2. Deploy (upgrade authority = your wallet)
solana program deploy target/deploy/zdlt_seeker_staking.so \
  --program-id target/deploy/zdlt_seeker_staking-keypair.json

# 3. Initialize vault (one-time, must be called by upgrade authority)
#    See scripts/initialize-mainnet.ts — pass the API backend keypair
#    pubkey as `authority` (edit the script or the KEYPAIR/RPC_URL env vars)
npx ts-node scripts/initialize-mainnet.ts
```

### Upgrade

```sh
solana-verify build --library-name zdlt_seeker_staking
solana program deploy target/deploy/zdlt_seeker_staking.so \
  --program-id ZDLT3oh8VxZJcSTxi1LgG4GqMsiF4jFrQho6hnJj5Gy
```

Only the upgrade authority can call `initialize` after a fresh deploy. This prevents any third party from front-running the one-time setup.

## Security

This program embeds [`solana-security-txt`](https://github.com/neodyme-labs/solana-security-txt) in the binary:

- **Contact:** security@zirodelta.com
- **Policy:** https://zirodelta.com/security-policy

See [SECURITY.md](./SECURITY.md) for the full disclosure process.

### Key security properties

- `initialize` is gated to the program upgrade authority (verified against `bpf_loader_upgradeable` PDA on-chain, not just a passed-in signer).
- `force_unstake` is gated to `config.authority` (the API backend keypair) — not the user.
- `unstake` enforces `unlock_ts` at the block clock level; no client-supplied bypass.
- All arithmetic uses `checked_add` with explicit overflow error.
- `StakeAccount` is closed (rent returned) on both `unstake` and `force_unstake`.

## Repository Layout

```
programs/
  smart-contract/
    src/lib.rs       — program source
    Cargo.toml
tests/
  zdlt_seeker_staking.ts — TypeScript integration tests (Anchor/Mocha)
scripts/
  initialize-mainnet.ts  — one-time mainnet `initialize` deploy script
migrations/
  deploy.ts          — Anchor migration script
dist/
  zdlt_vault.js      — pre-built TypeScript client (IDL + types; stale name, predates the zdlt_seeker_staking rename)
Anchor.toml          — cluster, program IDs, test script
Cargo.toml           — workspace manifest
rust-toolchain.toml  — pinned Rust toolchain
tsconfig.json
run_tests.sh         — localnet test runner
run_tests_devnet.sh  — devnet test runner
```

## License

Copyright (c) 2024–2026 Zirodelta. All rights reserved.

This source code is proprietary and confidential. Unauthorized copying, modification, distribution, or use of this software, in whole or in part, is strictly prohibited.
