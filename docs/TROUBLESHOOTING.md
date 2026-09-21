# Troubleshooting

| Symptom/code | Action |
|---|---|
| `jev-control: command not found` | Use `"$HOME/.local/bin/jev-control"` or `node /absolute/repo/bin/jev-control.mjs`. The installer does not edit shell startup files. |
| `NO_API_KEY` | Configure the host launch environment or run `key set` yourself in a normal terminal. Installation/offline tests do not require a key. |
| Status says environment when a file was updated | TYPESAFE_API_KEY takes precedence. Remove/rotate the inherited environment value and restart the host. Do not print it. |
| `PRIVATE_DIRECTORY_REQUIRED` / `PRIVATE_FILE_REQUIRED` | Verify ownership and location, then restrict your own JEV_HOME to 0700 and credentials/config to 0600. Do not run sudo or weaken checks. |
| `UNSAFE_SYMLINK` | Use a real absolute directory, not a symlinked home/config/key path. macOS /tmp and /var can be aliases; normal $HOME paths are preferred. |
| `KEY_IN_REPOSITORY_REFUSED` | Put JEV_HOME outside the active Git worktree. The clone may be a child of JEV_HOME; the credential directory itself must not be inside Git. |
| `KEY_REQUIRES_YOUR_INTERACTIVE_TERMINAL` | The user, not the coding agent, must run key set in a regular interactive terminal. No stdin pipe or command argument fallback. |
| `AUTH_ERROR` | Verify account/key entitlement privately in TypeSafe, rotate as appropriate and retry manually. The tool does not echo the provider error body. |
| `TIMEOUT` / `RATE_LIMITED` / `CIRCUIT_OPEN` | The host path remains available. Do not add retry loops. Check account status/rate and narrow inputs; a circuit retries only after its cooldown and a new call. |
| `LOW_CONFIDENCE` | Delegate normally. Inspect your nonsecret question design/evidence. Do not lower thresholds merely to make more outputs apply. |
| `SENSITIVE_INPUT` | Remove secrets/unneeded source/logs before sending. The screen is intentionally conservative and is not complete DLP. |
| `MODE_CHANGED` / `POLICY_CHANGED` | An in-flight result was deliberately discarded after settings changed. Continue through the host. |
| `FEEDBACK_EXPIRED_OR_UNKNOWN` | Feedback must use the same long-lived MCP process within five minutes. Separate CLI invocations cannot share ephemeral candidates. |
| `MANAGED_CONFIG_CHANGED` / `SKILL_CHANGED_OR_COLLISION` | Stop and inspect only the relevant nonsecret managed block/file. Reconcile intentional edits or use the private backup manually; do not force overwrite. |
| `INSTALL_LOCKED` | Verify no other installation is active. A crashed installer can leave JEV_HOME/install.lock; remove only after that verification. |
| `CUSTOM_CLAUDE_PROFILE_USE_PROJECT_SCOPE` | Custom CLAUDE_CONFIG_DIR profile layouts are not guessed in v1. Use `--scope project --project /absolute/path` for that profile, or install the standard profile deliberately. |
| MCP is missing | Verify the selected scope, CODEX_HOME, host version and trusted project. Reconnect/restart the host. Cloud/remote execution needs a separately accessible checkout/environment. |
| MCP exists but is never used | Loading tools does not force model calls. Use a relevant narrow decision task and the jev-decisions skill; do not add blanket hooks. |
| OFF but MCP tools remain listed | Expected: logical OFF prevents API use, not tool discovery. Disable the server in the host or uninstall to remove that overhead. |
| Two hosts exceed a shared expected rate | Rate/in-flight/circuit state is per process, not a shared account budget. Keep persistent MCP servers and set account-level controls independently. |

`doctor` performs local config, credential-readiness and executable-path checks only. It never calls TypeSafe and does not certify native-client E2E operation. Do not post private config/backup/credentials content in issues. The CLI returns bounded error codes rather than raw exception text.

For reinstall/update, turn OFF, review the Git diff and local modifications, pull fast-forward changes, run tests, reinstall and restart both hosts. Installation records permit updating previously owned runtime paths, but unknown edits are intentionally not overwritten. No runtime process updates its own source automatically.
