# Architecture and decision contract

Design date: 2026-09-21. Scope: a shared, optional decision engine usable from Codex and Claude Code without modifying their internals.

## Boundaries and module ownership

| Module | Owns | Does not own |
|---|---|---|
| constants.mjs | Defaults, enums, error contract | Project-specific worker names |
| storage.mjs | Mode/config, private key lookup, atomic files, local telemetry | Worktree dotenv, secret vault |
| contracts.mjs | Request validation, secret screening, wire shaping, response normalization | Permission grants or proof of correctness |
| provider.mjs | One bounded official REST request | Retries, alternate origins, model fallback API |
| engine.mjs | off/shadow/on, limits, confidence decisions, host fallback, feedback | Executing selected tools/workers |
| mcp.mjs | Stdio JSON-RPC lifecycle and three tools | HTTP serving, sampling, host interception |
| installer.mjs | Owned MCP/skill registration, backups, rollback | Models, host permissions, user AGENTS.md |
| cli.mjs | Explicit operator commands | Automatic mode activation |
| metrics.mjs | Measured local metadata summaries | Estimated whole-task token/cost savings |

Two host processes execute the same source. They share private persistent state, not one global daemon. Per-process rate limits deliberately avoid a shared broker/port/auth subsystem. This also means two active hosts can each make up to their configured rate; it is not an account-level spending cap. Repeated one-shot CLI invocations reset those process counters. Prefer persistent MCP for interactive agent work and configure provider/account-level controls separately where available.

## Runtime decision DAG

```text
load config → OFF? return host
     ↓
validate bounded request → sensitive scope? return host
     ↓
read key → best-effort secret screen → fixed wire payload
     ↓
rate / concurrency / circuit checks
     ↓
one HTTPS request → strict normalization
     ↓
reread mode/policy; reject cancellation or change
     ↓
SHADOW → retain small ephemeral candidate for comparison; return host with no answers
ON + all thresholds pass → apply=true, typed answers
ON + any threshold fails → apply=false, no answers
```

Failures always retain the host path. No second LLM is automatically called by the server. The embedding host or `decideOrDelegate` callback owns that path and its existing authorizations.

## Input

```json
{
  "purpose": "route",
  "risk": "routine",
  "state": {"task": "A documentation update request; no code edit requested"},
  "questions": {
    "worker": {
      "type": "choice",
      "instructions": "Which existing worker should handle this request?",
      "criteria": {
        "documentation": "Documentation-only work",
        "implementation": "Executable code changes",
        "host": "Not enough evidence or outside either worker scope"
      }
    }
  }
}
```

Supported purpose labels are route/select/retry/review/judge/escalate. They share one generic decision contract; there are no hidden per-purpose prompts or hardcoded model tiers. Names must be bounded identifiers. Unsupported fields, prototype keys, invalid JSON structure and over-budget data are rejected. `risk=sensitive` always delegates before a network call; it is not a trusted security classification from the host.

A batch contains at most eight independent questions over the same state. Dependent choices require a later request after the relevant state changes. For example, choosing a worker and independently flagging insufficient evidence can be batched. Choosing a tool argument that depends on an unobserved tool result cannot.

## Output and primitives

Every decision returns version, random id, mode, apply, source, bounded reason, answers, usage, networkCalls, elapsedMs, and `authorizesExecution:false`. OFF and rejected requests do not expose values to apply. SHADOW intentionally returns no suggested values to avoid contaminating the independent baseline.

Choice returns `value`, distribution, `confidence`, and a separately validated `selectedProbability`. Noul returns a boolean `value`, `probabilityTrue`, and `confidence:null`. Score returns the fractional expected value, distribution and confidence, not the most likely integer bin. Probability sums and score expectations allow small numerical tolerances; invalid or incomplete payloads delegate. Unknown upstream usage is null.

Default acceptance: Choice confidence >=0.85 AND selected probability >=0.80; Noul certainty max(p,1-p)>=0.95; Score confidence>=0.85. These are starting policies, not empirically calibrated guarantees. All questions in a batch must qualify before any result is applied. A high-risk action must not rely on these thresholds alone.

## Configuration and lifecycle

Private home: `$JEV_HOME` or `$HOME/.local/share/jev-agent-control`. Files: config.json, optional credentials.env, installations/*.json, backups/*, logs/*.jsonl. Config is strict JSON, version 1; config.example.json lists all supported keys. Changes are read at decision boundaries. No secret belongs in this JSON. Invalid config leads to host fallback; the OFF command can repair malformed config to safe defaults.

Defaults: timeout 2,000ms; max wire input 24,000 bytes; max questions 8; per-process 60 calls/minute and 4 in flight; after 3 failures, open circuit 30,000ms. Provider response bound 131,072 bytes; MCP frame bound 65,536 bytes. No retries, no cross-request cache of decisions, no remote telemetry. JEV_DISABLE=1 forces OFF in the process where it is inherited. An answer arriving after observed OFF/policy change is not applied.

## Host installation

User Codex registration: `$CODEX_HOME/config.toml` or `~/.codex/config.toml`; skills: `~/.agents/skills`. User Claude registration: `~/.claude.json` top-level mcpServers; skills: `~/.claude/skills`. Project mode writes `.codex/config.toml`, `.mcp.json`, `.agents/skills` and `.claude/skills` under the chosen project. These absolute-path configurations are local to the machine. Existing model/permission/MCP entries remain unchanged.

The installer records exactly what it owns. Code/Node path changes can be reinstalled when the old entry still matches its record. Unknown collisions and manually modified skill/config content are refused. A failed multi-file write rolls back changes it still owns; a concurrent external edit is not overwritten. A lock serializes installations sharing JEV_HOME. The separate control skill offers simple operator toggles without exposing mutating MCP tools to arbitrary tool callers.

No Claude-specific marketplace package is added in v1: using one installer for both hosts avoids duplicate registrations, plugin-root path expansion differences and competing control authorities. This is a portable MCP/skill integration, not an official TypeSafe/OpenAI/Anthropic plugin.

## Where real savings can happen

In a host-owned loop, `decideOrDelegate(engine, request, {use,delegate})` invokes only use when eligible, otherwise only delegate. An expensive model decision can therefore be removed, not supplemented. In stock Codex/Claude, the model must still decide to call an MCP tool; skills encourage useful delegation but cannot rewrite internal model turns. Actual token savings must include host context, tool round trips, fallback rates and corrections.

Let baseline decision time be L, Jev end-to-end decision time J, extra integration overhead H and fallback probability f. Expected new decision time is approximately J+H+fL. A speed improvement needs J+H < (1-f)L. Whole-task improvement is limited by the fraction of work represented by these decisions. This is reasoning about the design, not a measured Jev benchmark.
