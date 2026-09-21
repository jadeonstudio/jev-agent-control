---
name: jev-control
description: Manage the optional Jev decision layer when the user asks to enable, disable, test, inspect, or install it. Not a coding or reasoning agent.
---
# Jev controls
Use the bundled `scripts/run.mjs`, resolved relative to this skill directory, NOT the project working directory:

```sh
node <this-skill-directory>/scripts/run.mjs status
node <this-skill-directory>/scripts/run.mjs off
node <this-skill-directory>/scripts/run.mjs shadow
node <this-skill-directory>/scripts/run.mjs on
node <this-skill-directory>/scripts/run.mjs doctor
node <this-skill-directory>/scripts/run.mjs smoke
node <this-skill-directory>/scripts/run.mjs metrics
```
Ask the user to run `key set` themselves in a normal terminal when a key is missing. Never ask them to paste a key in chat. Never read, display, search, or send `credentials.env`, process environments, shell history, or host authentication files to an LLM. Never put a key in a command argument.

OFF makes no API calls. SHADOW pays for TypeSafe decisions but never applies or reveals their answers to the host before an independent baseline is recorded. ON permits high-confidence advisory decisions only. Mode is shared across Codex and Claude for the same JEV_HOME; do not toggle without the user's request. An existing request cannot be unsent.

`smoke` is offline. `smoke --live` sends one synthetic batch and incurs TypeSafe usage; run only when the user has authorized API testing. Installation does not grant tool permissions or bypass host trust prompts. Do not claim speedups from synthetic smoke results.
