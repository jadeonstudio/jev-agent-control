# Installation and development instructions for coding agents

This repository is a local, optional Jev decision layer for BOTH Codex and Claude Code. When the user gives this repository URL for installation, follow this document. Do not replace host models, edit user project instructions, or install unrelated plugins.

## Install from the URL

1. Read README.md, SECURITY.md, src/installer.mjs, and package.json. This private repository requires the user's existing GitHub authorization. Do not obtain credentials from unrelated files or expose authentication material.
2. Check Git and Node.js >=22. Support macOS/Linux/WSL. Do not install system software with sudo. If Node is missing, report the exact prerequisite; do not claim installation succeeded.
3. Prefer a stable checkout at `$HOME/.local/share/jev-agent-control/repository`. Create its parent with mode 0700, outside any Git worktree. Reuse an existing checkout only after checking its remote and local modifications. Never discard changes or clone over it.
4. Run `node scripts/check.mjs`, `node --test tests/*.test.mjs`, and `node bin/jev-control.mjs smoke`. They are offline and need no real key or npm dependencies.
5. Run `node bin/jev-control.mjs install --target both --dry-run`. Review affected paths. The user's request authorizes these specific Jev entries, not changes to other settings. Use `--target codex|claude` only when the user requested a single host. Use project scope only when requested.
6. Run the same install without `--dry-run`. It starts OFF and preserves unrelated configuration. It creates a CLI shim, two small skills per host, and one stdio MCP registration per host. Do not also install a marketplace version or use `mcp add` for the same server.
7. Run `node bin/jev-control.mjs doctor`. The command reports local readiness only, not live validation. Confirm `jev_agent_control` appears in each available host's MCP listing/panel. Restart/reconnect the host to load skills. Respect normal host trust and tool approvals; do not alter permission modes or blanket allow rules.
8. Report the installed path, mode, tests actually run, host verification status, and commands for off/shadow/on. Report unavailable hosts separately; a generated config does not prove native-client compatibility.

## Credentials and live tests

Never ask for a key in chat. Never read, print, search or summarize credentials.env, shell history, process environments, host auth files, or private backups for the LLM. Never put a key in a command argument, a committed file, MCP JSON/TOML, a tool payload, or a test snapshot.

The runtime reads TYPESAFE_API_KEY from its inherited environment first. Alternatively the USER runs `~/.local/bin/jev-control key set` themselves in a regular terminal; hidden input writes a private plaintext file outside Git. Do not run the interactive key prompt on their behalf. A key is not needed to install or test offline.

Only enable shadow/on or run `smoke --live` when the user has authorized API use. Do not automatically activate Jev because installation passed. Do not create a fake production key to bypass readiness. After configuring credentials, a synthetic live smoke is a contract test, not a benchmark.

## Runtime behavior

Follow skills/jev-decisions/SKILL.md. Jev may replace a narrow decision, not coding, architecture, complete code review, test execution, or permissions. Deterministic checks come first. Only consume a decision when apply=true. Always retain normal host approvals. OFF uses no TypeSafe API; SHADOW calls the API but returns no suggested values. A baseline must be independent, and feedback is local metadata only.

MCP cannot transparently intercept the host model's internal reasoning. Do not claim automatic model selection, subscription quota savings, or removal of all orchestration turns. For a harness owned by this repository's user, use decideOrDelegate to actually skip the baseline call when eligible.

## Changes and updates

Keep one shared engine and thin host installation adapters. No browser agent, compaction, memory deletion, model proxy, generic pre/post-tool hook, daemon, or permission bypass without a separately scoped request.

Changes to API contracts require checking current official TypeSafe docs. Preserve the distinction between Choice/Score confidence and Noul probability. Keep all secret/error logs bounded and non-content-bearing. Preserve atomic installs, ownership records, conflict refusal, rollback, and off-first operation. Add a regression test for every bug fix.

Run check, all tests, offline smoke, and the fast-path example before a commit. Never state native/live tests passed unless they were actually executed. Do not silently enable networked tests in CI. Updates use reviewed fast-forward Git changes, reinstallation, and host restart. Do not fetch/execute updates automatically during a decision.
