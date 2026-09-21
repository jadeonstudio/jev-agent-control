# Research and implementation decisions

Reviewed 2026-09-21. Primary official documentation defines compatibility; community repositories inform design patterns, not claimed production guarantees. No third-party implementation was copied. Benchmark numbers from earlier discussions or unverified social posts are not acceptance evidence for this project.

## Official API contract

1. [TypeSafe quick start](https://docs.typesafe.ai/introduction/quickstart): POST https://api.typesafe.ai/v1/systemone, Bearer authorization, model=jev-latest, mixed questions in one body. The implemented transport uses that documented REST contract directly, not a Chat Completions compatibility guess. Key values remain local until the Authorization header is constructed.
2. [TypeSafe JS SDK](https://github.com/typesafe-ai/typesafe-sdk-js), [client.ts](https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/src/client.ts), [types.ts](https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/src/types.ts): cross-check request shape, JSON instructions and endpoint/auth handling. A small dependency-free transport was chosen to make review, deadline control and installation simpler; this project does not claim to be the official SDK.
3. [Confidence](https://docs.typesafe.ai/confidence): Choice/Score confidence is derived from the probability distribution; Noul has no such field. The implementation keeps confidence distinct from selected probability and never interprets it as an observed accuracy percentage.
4. [Response types](https://docs.typesafe.ai/sdk/python/api/types/responses): Choice, Noul, Score and token usage are separate typed structures. Score is an expected value, so preserving fractions matters. Missing token accounting stays unknown rather than being reported as zero.
5. [Confidence routing](https://docs.typesafe.ai/patterns/confidence-routing): uncertainty should cause escalation/fallback. This project makes fallback explicit, applies all-or-nothing batch eligibility and defaults to OFF pending evaluation. Our thresholds are configurable initial policy, not thresholds endorsed for this use case by TypeSafe.

## Host integration

6. [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): local stdio command/args, config.toml entries, env_vars forwarding and tool timeouts are supported extension points. The installer forwards TYPESAFE_API_KEY by name, never embeds its value. A tool connection is not an internal reasoning interceptor.
7. [Codex skills](https://learn.chatgpt.com/docs/build-skills): small SKILL.md instructions are discovered from user/project skill locations. The two skills separate operator control from decision use; no broad AGENTS.md changes are made to user projects.
8. [Claude Code MCP](https://code.claude.com/docs/en/mcp): stdio local processes, top-level user registrations in ~/.claude.json and project .mcp.json are supported. Host-specific approval and scope precedence remain authoritative; the installer does not weaken them.
9. [Claude Code skills](https://code.claude.com/docs/en/skills): ~/.claude/skills and project skills permit the same behavior guidance without a second decision core. The project intentionally uses one installation route rather than combining marketplace and manual MCP registrations.
10. [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) and [stdio transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports): initialization/version negotiation and newline-delimited JSON-RPC are implemented and tested. Supported negotiated versions are 2024-11-05, 2025-03-26 and 2025-06-18. This is a conservative tools-only subset, not a claim of full/latest MCP conformance. No sampling, resources or prompts capability is advertised.

## Community patterns evaluated

| Reference | Useful pattern | Deliberately not adopted |
|---|---|---|
| [jev-use](https://github.com/shitianfang/jev-use) | Explicit small decisions and escalation to a generating model | Assuming a shared interface proves speed/cost improvements |
| [hermes-jev-skills](https://github.com/kerpopule/hermes-jev-skills) | Shadow observations, bounded routing and host fallback | Broad memory/context/browser/skill-policy surface |
| [pi-jev](https://github.com/y0usaf/pi-jev) | Batch independent questions; keep integration optional | Generic pre/post-tool judging or AI permission authorization |

These projects are references rather than dependencies. Repository README statements are author claims, not independent safety certificates. Changes to upstream projects will not silently modify this installation. Avoiding their entire bundles keeps one policy owner and prevents double routing or multiple layers each performing the same judgment.

## Decisions resolved by the research

**MCP + two skills + one engine.** Both hosts expose supported integration surfaces, while no primary source establishes that an arbitrary external plugin can transparently replace every internal model decision. The boundary is therefore explicit and measurable. An owned harness gets a direct library fast path for actual baseline-call removal.

**OFF first, blind SHADOW second.** A shadow experiment costs extra and should not be described as a token optimization. Not revealing suggestions until after an independent baseline prevents one obvious source of agreement bias. Even agreement without that bias is not accuracy; downstream tests/outcomes are still required.

**Env first; optional private local file.** Environment inheritance is a supported mechanism, but GUI launch behavior can make it awkward. A single parsed key file solves that operational case without putting keys in host configs or repositories. It is explicitly plaintext and does not defend against same-user filesystem access. No undocumented secret-manager integration is claimed.

**Strict response semantics, not schema-only confidence.** Typed output can still make a wrong decision. Invalid distributions, unexpected options, missing answers or inappropriate confidence fail back locally. Test/process truth and host permissions are never delegated to the model.

**Narrow installation and reversibility.** OFF/on commands, dry-run, ownership records, private backups and rollback address adoption risk directly. Uninstall removes only owned configuration and intentionally retains user secrets/logs for explicit user-managed removal.

**Measured evidence instead of marketing multipliers.** The repository does not reproduce unverified 100x/400x claims, infer subscription quota savings, or label mocked milliseconds as real API speed. The A/B protocol measures decision latency, host usage, Jev usage, fallbacks and final task quality separately.

## Evidence still required in the target environment

A real TypeSafe key is needed to confirm the active account/model/API response. Actual Codex and Claude Code sessions are needed to confirm discovery, MCP negotiation and skill behavior in their installed versions. These are documented acceptance steps, not completed facts. API availability, model aliases, privacy terms and pricing can change after this review; recheck official sources before expanding use or sending sensitive data.
