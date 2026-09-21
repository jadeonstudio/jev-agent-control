# Security model

## Trust boundaries

Jev Agent Control is an advisory local tool, NOT a sandbox, authorization system, secret vault, or security classifier. A Jev result never grants permission to execute code, bypass approvals, merge, deploy, migrate data, or trade. Low confidence, malformed responses and service failure delegate to the original host workflow WITH its existing checks. A caller-supplied `risk` flag is a hint, not trustworthy proof that an action is safe.

The supported threat model covers accidental disclosure, untrusted state, malformed upstream output, unsafe filesystem links, config collisions and ordinary network failures. It does not defend against a compromised OS, root, malicious software running as the same account, a compromised Node runtime, arbitrary hostile modifications of trusted local code/config, or all concurrent filesystem races. Host policies must still limit agent filesystem access and outbound data.

## Credentials

The server reads inherited TYPESAFE_API_KEY first. Environment values are never serialized into generated host configs; Codex receives the variable NAME through env_vars. Claude's stdio child normally inherits its parent's environment. Already-running applications need restart after changing inherited variables.

The optional `key set` command accepts hidden interactive TTY input, never command arguments or stdin pipes. It writes only `JEV_HOME/credentials.env` (0700 home, 0600 file). The file is plaintext, not encrypted. The managed parser accepts one TYPESAFE_API_KEY assignment; it never evaluates shell syntax. It rejects unsafe links, hard-linked files, weak permissions, wrong file owners and placement beneath a Git worktree. Worktree .env files are never automatically loaded. Do not commit, upload, share or feed this file to an LLM.

A same-user coding agent can potentially read a file that its OS account can read, and inherited environment secrets can reach other child processes. File permissions and skill instructions do not create isolation from that agent. Use a dedicated OS account, host sandbox/file-deny policy, or an approved secrets broker for stronger separation. This project intentionally makes no keychain/encrypted-vault claim.

## Data sent outside the machine

Only the caller-supplied minimal `state`, question instructions/criteria, and model name are sent to TypeSafe. Authorization contains the API key. There is no automatic repository scan, conversation upload, environment dump, file attachment, or analytics service. TypeSafe receives whatever permitted state is sent; provider retention, training and residency terms must be checked independently before sending proprietary or regulated data. No zero-retention guarantee is made.

Before sending, the implementation checks all request fields for the exact active key, common token/private-key formats, password assignments, URL credentials and sensitive object keys. This is best-effort secret screening, NOT comprehensive DLP. Unknown formats, encoded secrets, private business data and personal data may evade it. Minimize data BEFORE constructing the request. Prompt-injection instructions tell Jev to treat state as data but are not a security guarantee.

## Transport and output validation

The endpoint is fixed to HTTPS `api.typesafe.ai/v1/systemone`. Redirects and endpoint overrides are disabled; insecure TLS disabling is refused by the engine. Node/OS TLS trust remains authoritative. No automatic retries. The default deadline covers the complete response, not only headers. Request/frame/response sizes, question counts, in-flight concurrency and per-process call rates are bounded. Bounded reason codes replace raw errors and upstream error bodies.

Choice answers must belong to the original candidates and have a valid distribution; Score must match a valid bounded expected value; Noul remains a true probability and has no invented confidence. `confidence` is not proof of truth, and formatting correctness is not semantic correctness. Confidence thresholds must be evaluated for each use case. No answer changes the `authorizesExecution: false` contract.

## Local storage and installation

Generated configs contain executable paths and nonsecret variable names/paths only. The installer changes only its named MCP entry, owned skill files, shim and installation records. It refuses collisions and edits it cannot attribute to its previous installation. Writes are atomic and check expected contents; a private lock prevents concurrent installations for the same JEV_HOME. Failure rolls back its own unchanged writes without clobbering another writer. This is not a globally atomic transaction across independent host processes.

Backups are private files under JEV_HOME/backups with a path manifest. **They are copies of existing host configuration and may contain other credentials already present there.** Never print their contents or put them in Git. Partial directories may remain after a failed installation. A crash can leave install.lock; only remove it manually after verifying no installer is active. Do not overwrite a host's trust/approval settings or instruct it to bypass sandbox restrictions.

OFF is checked before network use and again before applying an in-flight answer. It cannot recall already transmitted data or cancel provider billing. Native host/server disable is stronger than logical OFF for removing tool-discovery overhead. JEV_DISABLE=1 is process-inherited, not a live environment broadcast. User and project installs share state when JEV_HOME is the same; separate processes do not share request counters.

## Logs, retention and rotation

Only time, random decision ID, mode, purpose, bounded reason code, numeric latency/usage/counts and application eligibility are logged. No state, prompts, candidate names, chosen values, source, keys, raw exception messages or hashes of user content are persisted. Short-lived feedback keeps normalized decisions in process memory for at most five minutes between accesses, with a 128-entry cap; process exit clears it. Logs use private JSONL files with a roughly 10MiB/day cap and best-effort writes. They are not automatically deleted. Metrics read at most 30 days but do not enforce retention.

Revoke a suspected key in the TypeSafe account, set OFF, update the environment or use key set, remove obsolete credentials and restart inherited host processes. `key remove` removes only the managed file, not provider access, shell history, backups or inherited environments. Never paste incident secrets into GitHub issues or chat. Report security issues privately to the repository owner; do not include real keys or proprietary payloads.

## Supply chain

Node >=22 and built-in modules only. No runtime npm packages, install hooks, shell-evaluated credentials, remote bootstrap execution, background updater or public HTTP listener. Dependencies can be added only after a separate review. CI uses commit-pinned actions, read-only repository permission, no persisted checkout credential and no TypeSafe key. The manual MCP stdio subset is covered by protocol tests but is not certified full-protocol compliance; actual target clients remain a separate acceptance check.
