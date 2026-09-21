---
name: jev-control
description: Install, inspect, test or explicitly toggle the optional shared Jev layer and its router/bulk features for Codex and Claude Code.
---
# Jev operator controls
Resolve the bundled `scripts/run.mjs` relative to THIS skill, not the project working directory:

```sh
node <this-skill-directory>/scripts/run.mjs status
node <this-skill-directory>/scripts/run.mjs off
node <this-skill-directory>/scripts/run.mjs shadow
node <this-skill-directory>/scripts/run.mjs on
node <this-skill-directory>/scripts/run.mjs policy init
node <this-skill-directory>/scripts/run.mjs policy check
node <this-skill-directory>/scripts/run.mjs router off
node <this-skill-directory>/scripts/run.mjs router shadow
node <this-skill-directory>/scripts/run.mjs router on
node <this-skill-directory>/scripts/run.mjs bulk off
node <this-skill-directory>/scripts/run.mjs bulk shadow
node <this-skill-directory>/scripts/run.mjs bulk on
node <this-skill-directory>/scripts/run.mjs doctor
node <this-skill-directory>/scripts/run.mjs smoke
node <this-skill-directory>/scripts/run.mjs metrics
```

Global mode and per-feature mode combine conservatively: either OFF disables; either SHADOW prevents application. Updating code does not enable new features. Do not toggle without the user's request. `policy init` creates safe defaults without overwriting an existing policy. Router profiles start empty; map only actually available models, reasoning levels and skills after inspecting the host's supported configuration and the user's desired policy. No invented model names or silently lowered thresholds. `policy check` validates configuration, NOT model quality or availability.

Reuse the existing TYPESAFE_API_KEY. If missing, ask the USER to run `key set` in a normal terminal. Never request a key in chat, pass it as an argument or display/read credentials.env, process environments, host auth files, shell history or backups. The managed key file is private plaintext, not an encrypted vault.

`smoke` and examples are offline. `smoke --live` incurs TypeSafe usage and requires explicit authorization. Feature SHADOW also incurs API usage. No classifier.dev account/key is used. In-flight requests cannot be unsent; responses observed after OFF/policy changes are not applied. Installation preserves normal host trust/permissions and does not switch the active host model.

For updates: OFF, review Git changes, fast-forward pull, full tests, reinstall the two existing skills/MCP entries, reconnect hosts. Read docs/CLASSIFIER_DESIGN.md for configuration, limitations and paired evaluation. Never claim savings or native/live success from a synthetic test.
