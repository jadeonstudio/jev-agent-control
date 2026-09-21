# Test and evaluation plan

## Executed in the implementation environment

2026-09-21: Linux, Node.js 22.16.0. `node --test tests/*.test.mjs`: **62 tests passed, 0 failed** (including nested HTTP/response cases). `node scripts/check.mjs`, `node bin/jev-control.mjs smoke`, and `node examples/fast-path.mjs` also passed. The smoke/example use synthetic responses, not Jev inference. No real TypeSafe key was available or used.

Test coverage includes:

| Area | Executed evidence |
|---|---|
| Contracts | All three primitives, fractional Score, independent Choice thresholds, no Noul confidence, malformed distributions and unknown usage |
| Modes | OFF zero network/logs, blind SHADOW, ON eligibility, environment override, in-flight OFF/policy changes |
| Failures | Missing key, sensitive input/scope, disabled TLS, timeout, cancellation, 429, bounded errors, circuit/rate/concurrency limits |
| Security | Environment precedence, 0600 key file, unsafe directory, Git placement, no shell evaluation, symlink/hardlink rejection, request/log secret screening |
| Transport | Fixed endpoint/header contract, JSON validation, response cap, complete deadline, no retries, real loopback HTTP redirect rejection |
| MCP | Initialization, version negotiation, tool discovery/call/feedback, framing/UTF-8, errors, cancellation, oversize rejection, actual stdio subprocess |
| Installer | User/project scope, both hosts, config preservation, repeat install, shared custom home, partial/full uninstall, collisions, owned runtime relocation, lock and rollback |
| CLI | No key arguments, noninteractive key entry refusal, status without key disclosure, offline smoke, shared toggles |

Tests use temporary HOME/JEV_HOME directories and fake credentials. Network-like tests either inject an in-memory provider or use a loopback HTTP server. They do not contact TypeSafe, Codex, Claude, or a hosted model.

## Not yet verified by that run

- [ ] A real TypeSafe account/key successfully calls the current live endpoint.
- [ ] A real Codex CLI/app/IDE session loads the MCP server and both skills.
- [ ] A real Claude Code session loads the MCP server and both skills.
- [ ] Hidden interactive key entry is exercised in a user's real terminal (noninteractive refusal is tested).
- [ ] Native macOS/Node 24 test runs are observed. The CI matrix config is not itself a passed result.
- [ ] Decision quality and whole-task latency/token improvements are measured on representative work.

A fake protocol client is not the same as running either target product. An offline fixture is not a live response. Do not check these boxes without the corresponding evidence.

## Local reproduction

```sh
node scripts/check.mjs
node --test tests/*.test.mjs
node bin/jev-control.mjs smoke
node examples/fast-path.mjs
```

No npm install or key is required. The example demonstrates one branch invoking the host delegate and another skipping it; its latency is not an API benchmark. CI repeats these commands without secrets on configured OS/Node versions. Check the actual workflow run before claiming CI passed.

## Native acceptance checklist

1. Install OFF after reviewing the dry run. Confirm only the named MCP entry and two skills were added; previous model/settings/permissions remain.
2. Restart/reconnect each host. Confirm `jev_agent_control` in its MCP panel/list. Call `jev_status`: mode=off, no secret printed. Ask the host to do normal work and verify there is no TypeSafe traffic.
3. Configure TYPESAFE_API_KEY in the host's launch environment, or personally run key set in a terminal. Never paste the key in a transcript.
4. Explicitly enable shadow and run `smoke --live`. It sends one synthetic batch; save only the sanitized result. API success tests the wire contract, not model accuracy. A Score differing from the fixture is not automatically a transport failure.
5. In a small real routing task, call jev_decide. SHADOW must return apply=false and no suggested values. Send an independent baseline through jev_feedback in the same MCP process within five minutes.
6. Enable ON for one routine decision family. Confirm `apply=true` is consumed without repeating a full baseline decision. Trigger OFF during/after a task; subsequent calls must delegate with no new TypeSafe request.
7. Confirm existing risky-action permission prompts still apply. Never test this by authorizing destructive actions.
8. Uninstall the selected scope, reconnect and verify that only this integration is gone; the key/logs stay until explicitly removed.

## A/B experiment: establish benefit rather than assume it

Choose a bounded task set with ground truth or objectively checked final outcomes, including ambiguous, out-of-scope and failure cases. Record repo commit, host/client versions, model configuration, input selection policy, request schema and thresholds. Do not compare runs with different cache warmth, task mix or model settings without accounting for those differences.

Run the original workflow with Jev OFF for the baseline. Capture host-reported input/output/reasoning/cached usage when actually available and task wall-clock time. Do not invent unavailable token categories. Separately, SHADOW can estimate eligibility and disagreement, but its extra API call makes it unsuitable for claiming speed improvement.

Next run ON for the same decision family with matched inputs and comparable cache conditions. Measure end-to-end Jev latency including network and MCP overhead, actual host calls removed, fallback frequency, retries/corrections, Jev-reported usage, and final test/outcome quality. Randomize or alternate run order. Report sample size, distribution/p50/p95 and uncertainty, not a single best result.

A useful fast path must reduce total task time and/or measured cost at acceptable quality, not merely report fewer host calls. A route that triggers more rework can erase savings. Agreement with a previous host answer is not accuracy. Correctness must come from independent labels or downstream outcomes. OFF logs nothing, so baseline host metrics must come from the host itself.

`metrics` reports local observations but intentionally leaves tokenSavings and costSavings null. TypeSafe and host tokenizers/prices differ; subscription quota is not an API bill. Price conversion requires current account-specific billing data outside this tool. No usage dashboard is scraped and no cost assumptions are hardcoded.

Roll back to OFF if final outcomes degrade, fallback/rework consumes savings, p95 latency worsens, or useful replacement opportunities are rare. Keep the narrowly successful paths rather than enabling Jev before every tool invocation.
## v0.3 verification

Run `node scripts/check.mjs`, `node --test tests/*.test.mjs`, `node bin/jev-control.mjs smoke`, `node examples/fast-path.mjs`, and `node examples/training-pipeline.mjs`. Optional Python boundary tests: `python3 -m unittest discover -s tests -p "test_laya_worker.py"`. They use no real model or network. Added tests cover capture OFF/consent epochs, provenance, delayed outcomes, weak-source boundaries, per-purpose evidence, orphan/corrupt events, dedup split leakage, immutable/reproducible datasets, official JSON-string export, provider metrics, worker UTF-8/termination and MCP/CLI integration. Passing these does not verify actual Laya weights/MPS, native Codex/Claude, paid API or downstream model quality. Earlier counts below describe v0.2 only; use the current test/CI summary for current counts.
