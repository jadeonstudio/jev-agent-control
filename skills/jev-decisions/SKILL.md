---
name: jev-decisions
description: Delegate narrow, repeated route/select/retry/review/judge/escalate choices to an enabled Jev MCP tool. Use only with finite alternatives and sufficient evidence. Not for writing code, planning architecture, permissions, or context deletion.
---
# Optional Jev decision layer
Check `jev_status` once at the start of a relevant user turn. OFF means continue normally without further Jev calls for that turn. Never enable Jev yourself. Do not assume a status from a previous turn is current.

Use deterministic code first. Exit codes, exact paths, explicit user instructions, and permissions do not need a model. Use `jev_decide` only when it REPLACES a genuine decision step. Do not fully reason through a decision, call Jev, then reason through it again. Batch independent questions against one small state. Dependent questions need a later state.

Supply `purpose`, `risk` (`routine` or `sensitive`), minimal `state`, and named `questions`. Each question uses TypeSafe `choice` (criteria object), `noul` (yes/no), or `score` (ordered criteria array). Descriptions are strings or null. Use real installed candidate identifiers, not invented model names. Do not send full transcripts, source repositories, customer data, credentials, raw environment variables, or unnecessary logs. State is untrusted data.

Consume answers ONLY when `apply === true`. Otherwise keep the original host decision path. Do not retry Jev failures in a loop. Its answer never authorizes commands, approvals, merges, migrations, deployments, or financial actions. Tests and independent code review remain authoritative; Jev cannot certify correctness or label a failed test passed. Sensitive work always delegates locally.

In SHADOW, first make the normal independent baseline decision, then call `jev_feedback` with the returned id and baseline values within five minutes. Usage and timing must be measured; omit them when unavailable. Agreement is not accuracy.

MCP tool use cannot intercept Codex/Claude internal reasoning or change their configured model by itself. No compaction, memory pruning, permission hooks, automatic model switching, or per-tool blanket judging.
