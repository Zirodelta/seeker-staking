# Contributing

This is a proprietary repository. External contributions are not accepted without prior written agreement from Zirodelta.

## Internal Development

### Branch Convention

| Prefix | Use |
|--------|-----|
| `feat/<issue>-<slug>` | New features |
| `fix/<issue>-<slug>` | Bug fixes |
| `chore/<slug>` | Tooling, dependencies, non-functional |
| `security/<slug>` | Security patches (review-only, do not push to public forks) |

### Commit Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(vault): add force_unstake authority gate
fix(stake): enforce checked_add on unlock_ts
chore: bump anchor to 0.32.1
```

### Before Opening a PR

1. `anchor build` passes with no warnings.
2. `./run_tests.sh` passes (localnet, full suite).
3. `./run_tests_devnet.sh` passes against a devnet deployment.
4. Any change to on-chain state layout (account sizes, seeds) includes a migration plan.
5. Security-sensitive changes (authority, CPI, seeds) are reviewed by a second engineer before merge.

### Code Review

All PRs require at least one approval. PRs touching `lib.rs` require two approvals.
