# Architecture and ownership — v0.2

Updated 2026-09-21. Shared optional features for Codex and Claude Code; no host internal patches. The base engine remains the only credential and TypeSafe transport authority.

| Module | Ownership |
|---|---|
| constants/storage/contracts/provider | Existing enums, private config/key files, bounded input/response validation, fixed-origin HTTPS |
| engine | Shared per-process concurrency/rate/circuit limits, global mode, pinned override, response normalization, generic feedback |
| feature-policy | Independent off/shadow/on caps, strict private features.json, verified local target mappings |
| routing | Three independent classification dimensions and deterministic mean/tail/risk routing rules |
| filtering | Conservative relevance labels, actual-byte/question-aware packing; never deletes source |
| control-layer | Shared route/filter orchestration, global/feature revision checks, bounded blind observations |
| evaluation | Offline paired execution aggregates; no inferred counterfactual success or automatic activation |
| mcp | Six stdio tools, cancellation and protocol lifecycle; no HTTP port, sampling or mutating mode tool |
| cli/features-cli | Explicit operator commands, offline diagnostics/evaluation; original key and install workflow retained |
| installer | Owned MCP registrations and the same two skills per host; conflict refusal, backup and rollback |
| metrics | Numeric local metadata; wrapper activity does not double-count underlying TypeSafe calls |

## Global decision path

Read config → OFF returns host → bounded request validation → sensitive scope remains local → credential lookup/secret screen → rate/concurrency/circuit checks → one fixed-origin HTTPS request → strict normalization → reread mode/policy/cancellation → apply only if all question thresholds pass. SHADOW hides suggestions; invalid/low-confidence replies return no usable answers. No model fallback API is called by the server.

Engine options `modeLimit`, `modelOverride`, `onEvaluated` are trusted in-process options, NOT fields accepted from MCP input. A limit can only lower the global mode. A version override must be an explicit Jev version. The private observer enables local policy to inspect SHADOW candidates without returning them to an agent. The response serving version must match the pin; otherwise it is rejected.

## Extension path

Router: cheap local guards first → three Choice/Score questions in one shared state → uncertainty/risk/operations guards → expectation AND difficult-tail policy → configured available model/skills. `changesHostModel:false` and `authorizesExecution:false` always. See [CLASSIFIER_DESIGN.md](CLASSIFIER_DESIGN.md) for exact defaults and host capability boundary.

Filter: validate and keep source IDs → OFF/exhaustive/sensitive/required guards → secret screen → pack remaining items by byte and question limits → bounded sequential calls through SAME engine → confident excludes only → keep unknown/unprocessed. No background queue or persistent text cache. Global/feature policy drift, user cancellation or serving-version drift rolls back earlier exclusions. Malformed input requires caller fallback to its original input, not the potentially empty IDs in an invalid response.

Per-feature SHADOW is blind even when global is ON. Private observations expire after five minutes and are capped at 128. Routing comparison measures agreement, NOT cheaper-model task quality. Filter recall depends on supplied relevance labels, NOT Jev self-evaluation.

## Lifecycle, security, compatibility

Private home is `$JEV_HOME` or `$HOME/.local/share/jev-agent-control`. Existing config.json version1 remains valid. Optional features.json version1 is independently validated; missing means both features OFF and no model mappings. No endpoint/key fields are accepted in feature policy. Generic Jev settings and credentials are not silently migrated. The user's Git-cache ancestor fix remains unchanged.

Two hosts execute separate processes of the same source. State files are shared but limits are per process; one-shot CLI calls reset counters. Persistent MCP also shares generic/route/filter provider limits within that process. Defaults remain 2s/request, 24k wire bytes, 8 questions, 60 calls/minute, 4 in flight, circuit opens after 3 failures for 30s. Extensions add at most 128 candidates, 16 requests and 10s per filtering operation, plus existing 64KiB MCP/CLI frame bounds. Requests cannot be unsent.

Keys use inherited TYPESAFE_API_KEY or the existing optional 0600 plaintext managed file outside Git. Policies use the same safe file primitives. This is not a vault against processes running as the same OS user. Secret screening is best-effort; authorization for data egress belongs to the caller. No classifier.dev, OpenRouter, Gemini or alternative-origin transport is installed.

Installation retains original user/project layouts and both jev-control/jev-decisions skills. Settings, approvals, unrelated MCP entries and user project instructions stay untouched. For a reviewed update: OFF, fast-forward, tests, reinstall, host reconnect. Modifying a managed skill manually still raises a conflict rather than overwriting it.

## What is and is not verified

Offline tests prove contracts, branch selection, boundaries and synthetic provider behavior, including actual Node stdio subprocess communication. `decideOrDelegate` and `routeOrDelegate` skip their baseline callback on accepted synthetic decisions. They do not prove native-client integration, real provider accuracy, cheaper-model competence, lower subscription quota or wall-clock speedups. Native MCP is advisory; genuine pre-turn model invocation requires a supported, owned dispatcher. Offline evaluation only accepts supplied paired execution records; source authenticity and equivalent test environments remain external responsibilities.
