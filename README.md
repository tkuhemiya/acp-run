# acp-run

Small reusable client that speaks the [Agent Client Protocol](https://agentclientprotocol.com) to the official Claude Agent ACP adapter (`@agentclientprotocol/claude-agent-acp`).

Run Claude Code headlessly: one prompt (or a resumed session), streamed tool calls and diffs, auto-handled permissions.

## Requirements

- **Node.js >= 22** (adapter engine requirement)
- Claude Code CLI authenticated via `CLAUDE_CODE_OAUTH_TOKEN` in the environment (never commit or print it)

## Install

```bash
git clone https://github.com/tkuhemiya/acp-run.git
cd acp-run
npm install

# Optional: install the CLI on your PATH
npm link
# or run via npx/tsx:
npx tsx src/cli.ts --cwd . "hello"
```

You can also install the adapter globally:

```bash
npm install -g @agentclientprotocol/claude-agent-acp
```

## Usage

```bash
acp-run --cwd /path/to/project "Explain src/main.ts"

# Choose any model the adapter lists (default: Claude Code / adapter default)
acp-run --cwd . --model claude-sonnet-5-5 "Quick review"
acp-run --cwd . --model haiku "Quick review"

# Continue a session
acp-run --cwd . --session SESSION_ID "Follow-up: also add tests"

# Log tool calls / diffs
acp-run --cwd . --log /tmp/acp.log "…"

# Restrict permissions (see below)
acp-run --cwd . --safe "Only touch files in this project"
acp-run --cwd . --safe --allow-execute "…and allow shell inside cwd"
```

After each run the CLI prints:

```
SESSION_ID=…
STOP_REASON=…
MODEL_REQUESTED=…
MODEL_SET=…
MODEL_VERIFIED=true|false
```

### Models

`--model` accepts **any** model id or alias the adapter exposes. The client resolves it against the agent's listed `model` config options (exact value, case-insensitive, then name/description match), sets that option, and **refuses to continue** if the id is unknown — listing the available models in the error.

If you omit `--model`, the adapter / Claude Code default is left unchanged. `MODEL_REQUESTED` is empty in that case; `MODEL_SET` reflects whatever the agent reports.

### Permission policy

**Default is allow-all**: every `session/request_permission` is auto-approved, preferring `allow_always` then `allow_once`. This is intentional for disposable servers and sandboxes. Do **not** use the default on a machine with personal data or secrets you care about.

| Flag | Behavior |
|------|----------|
| *(default)* | Allow every permission request |
| `--safe` | Allow `read` / `search` / `edit` / `move` / `delete` when every path is under `--cwd`; deny `execute`, `fetch`, and anything outside cwd |
| `--safe --allow-execute` | Same as `--safe`, but also allow execute tools scoped to cwd |

`--allow-execute` alone is a no-op (default is already permissive); it only modifies `--safe`.

### Library API

```ts
import { ClaudeAcpClient } from "./src/client.ts";

const client = new ClaudeAcpClient({
  cwd: "/path/to/project",
  // model: "claude-sonnet-5-5",  // optional
  // permissionPolicy: { mode: "safe" },
});
const result = await client.runPrompt("…");
// result.sessionId → pass as --session / sessionId for follow-ups
```

Same-process multi-turn (no reload):

```ts
await client.runPromptsInSameSession(["first", "second"]);
```

## E2E test

```bash
npm run test:e2e
```

Creates a temp dir, asks the agent to write `hello.txt`, then in the **same session** edit it to `hello ACP`, and verifies the file. Requires `CLAUDE_CODE_OAUTH_TOKEN`.

## Layout

| Path | Role |
|------|------|
| `src/client.ts` | Spawns adapter over stdio, initialize, session, prompt, streaming |
| `src/cli.ts` | `acp-run` CLI |
| `src/permissions.ts` | Allow-all / safe permission policies |
| `src/models.ts` | Model id resolution against adapter listings |
| `src/log.ts` | stdout + optional log file for updates/diffs |
| `bin/acp-run` | Wrapper (ensures Node 22+) |

## Caveats

- Adapter package: `@agentclientprotocol/claude-agent-acp` (not the deprecated `@zed-industries/claude-code-acp`).
- Node **20 is not supported** by the adapter; use Node 22+.
- Cross-process `--session` uses `session/resume` when advertised, else `session/load`. Persistence depends on Claude Code's on-disk session store.
- Auth is via `CLAUDE_CODE_OAUTH_TOKEN` (or whatever Claude Code already uses on the machine). The client never prints it.
- Default permissions are fully permissive. Use `--safe` outside a disposable environment.

## License

MIT © Themiya
