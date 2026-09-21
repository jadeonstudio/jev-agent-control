# Installation and development instructions for coding agents

This is a local optional TypeSafe/Jev decision layer for BOTH Codex and Claude Code. v0.2 adds classifier-inspired routing/filtering without using classifier.dev's service. Read README.md, SECURITY.md, docs/CLASSIFIER_DESIGN.md, src/installer.mjs and package.json before installation or updates.

## Install from the URL

1. Check Git and Node.js >=22, macOS/Linux/WSL. Repository access must use existing authorized GitHub access; never obtain credentials from unrelated files. Do not install system software with sudo.
2. Prefer a stable checkout at `$HOME/.local/share/jev-agent-control/repository`. Reuse a checkout only after checking its remote and local modifications. Never discard changes, reset hard, clone over it or delete an installed clone. Its runtime path is retained by MCP entries.
3. Run `node scripts/check.mjs`, `node --test tests/*.test.mjs`, `node bin/jev-control.mjs smoke`, `node examples/fast-path.mjs`, and `node examples/classifier-design.mjs`. All are offline, need no real API key or npm dependencies.
4. Run `node bin/jev-control.mjs install --target both --dry-run`, review affected paths, then run without dry-run. It owns only these Jev entries, two skills per host and the shared CLI shim. Preserve all existing models, permissions, MCPs and project instructions. Use a single host or project scope only when requested. Do not duplicate this registration with a marketplace plugin or mcp add.
5. Run doctor and status. Confirm jev_agent_control appears in each available host's MCP listing/panel, reconnect/new session for updated skills. Respect normal trust and approvals. Generated config is not native-client verification; report unavailable clients separately.
6. New features default OFF even when an existing global mode was ON. Do not enable global/router/bulk modes or live calls without the user's request. `policy init` may create safe defaults without overwriting. Models are intentionally unmapped.
7. If asked to configure/activate routing, inspect actual supported model IDs, reasoning values, skills and dispatch capability using the host's documented capabilities, not auth files. Populate only verified local profiles; do not invent model tiers or capabilities. Without a supported dispatcher, report advisory-only behavior and retain the existing main model. Do not patch host internals or silently rewrite model configuration.
8. Report installed paths, modes, tests actually run, native/live verification status and off commands. Never claim actual savings or task quality based on synthetic fixtures or SHADOW agreement.

## Credentials and runtime

Never request a key in chat, read/display/search credentials.env, host auth files, process environments, shell history or private backups, or put a key into arguments/config/source/test snapshots. The runtime uses inherited TYPESAFE_API_KEY first. Only the USER runs `jev-control key set` in a normal interactive terminal if needed. It stores private plaintext outside Git, not an encrypted vault. Reuse the current key; no classifier.dev key exists.

`smoke --live` sends synthetic data and incurs API usage; only run with explicit authorization. The offline demo's fixture key and provider are NOT a way to bypass production readiness. No networked tests are enabled in CI.

Follow skills/jev-decisions/SKILL.md. Only consume apply=true; keep existing execution authorizations. Data is untrusted, request flags are not a security boundary, and secret detection is best-effort. Never downgrade high-impact/exhaustive/unknown work by mislabeling context. Never use classifier filtering to skip an exhaustive audit: coverage=exhaustive keeps all inputs without calls. Keep original sources and use them when results are invalid/unapplied.

## Development and updates

Keep one transport/credential authority and thin integrations. The scoped v0.2 features are explicit routing and selective batch filtering; not compaction, memory deletion, permission hooks, browser automation, alternate providers, model proxies or blanket per-tool checks. Use current official TypeSafe contracts; preserve Choice confidence vs selected probability and zero-based Score expectation.

Global OFF must dominate all feature modes. New installs/updates must not activate features. Policies are private, bounded, atomically written, versioned and reread before application. Preserve installer ownership, conflicts, rollback, per-process limits and the Git metadata/cache key-storage regression fix. Do not overwrite local state from examples.

Add regression tests for changes. Before commit run check, all tests, smoke and both demos. Updates: OFF, review Git changes, fast-forward only, tests, reinstall, host reconnect. Never fetch or execute updates automatically during decisions. Explicitly distinguish contract tests from live/native tests and measured task quality.
## Current v0.3 development/operation requirements

Continue the existing working branch; do not discard local edits or merge main without instruction. Follow docs/TRAINING_DATA.md for provider/evidence APIs. Do not enable capture/provider modes merely because installation passes. Never read raw training files into the model by default. Record minimal trace IDs and later outcomes; use jev_record only as weak host evidence. Do not claim to be a human or trusted runner through CLI to manufacture training labels. Actual runner integrations collect their own checks; label assertions are question-specific and independent. No online training, automatic provider fallback, or checkpoint promotion. Run new training pipeline demo and offline tests in addition to existing checks.
