# Security Policy

## Supported Versions

| Program ID | Status |
|------------|--------|
| `ZDLT3oh8VxZJcSTxi1LgG4GqMsiF4jFrQho6hnJj5Gy` | Active |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities to: **security@zirodelta.com**

Include in your report:
- Description of the vulnerability and its impact
- Steps to reproduce or a proof-of-concept (localnet or devnet only — never mainnet)
- Affected instruction(s) and account(s)
- Suggested remediation if known

We will acknowledge receipt within 2 business days and aim to resolve critical issues within 7 days.

## Embedded Security Contact

This program embeds a `solana-security-txt` section in the deployed binary, readable via:

```sh
solana-security-txt ZDLT3oh8VxZJcSTxi1LgG4GqMsiF4jFrQho6hnJj5Gy
```

## Scope

In scope:
- All instructions in `programs/smart-contract/src/lib.rs`
- PDA derivation and seed correctness
- Authority validation logic
- SPL token transfer safety (CPI correctness, signer seeds)
- Arithmetic overflow/underflow

Out of scope:
- Off-chain API layer (separate repository)
- Frontend
- Social engineering

## Disclosure Policy

We follow coordinated disclosure. We ask that you give us reasonable time to patch before public disclosure. Credit will be given in our release notes unless you prefer to remain anonymous.
