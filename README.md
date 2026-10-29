# Claude Code over ACP

Small reusable client that speaks the [Agent Client Protocol](https://agentclientprotocol.com) to the official Claude Agent ACP adapter (`@agentclientprotocol/claude-agent-acp`, successor to `@zed-industries/claude-code-acp`).

## Requirements

- **Node.js >= 22** (adapter engine requirement)
- Claude Code CLI authenticated via `CLAUDE_CODE_OAUTH_TOKEN` in the environment (never commit or print it)
- Packages installed in this directory (`npm install`)

## Install

```bash
cd /workspace/acp
# Node 22+ on PATH (nvm use 22)
npm install
# Adapter also available globally:
npm install -g @agentclientprotocol/claude-agent-acp
```

`bin/acp-run` is linked at `~/.local/bin/acp-run`.

## Usage

```bash
acp-run --cwd /path/to/project "Explain src/main.ts"

# Choose model (default: claude-sonnet-5-5)
acp-run --cwd . --model claude-haiku-5-5 "Quick review"

# Continue a session
acp-run --cwd . --session SESSION_ID "Follow-up: also add tests"

# Log tool calls / diffs
acp-run --cwd . --log /tmp/acp.log "…"
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

Only these are accepted:

| Flag | Notes |
|------|--------|
| `claude-sonnet-5-5` | **default** |
| `claude-haiku-5-5` | optional |

The client maps these to the adapter's listed aliases (`sonnet` → Sonnet 5.5, `haiku` → Haiku 5.5), sets the `model` config option, and **refuses to continue** if the agent's reported `currentValue` does not match that family. Other listed models (opus, fable, …) are never selected.

### Permission policy

Default auto-policy for `session/request_permission`:

- **Allow** `read` / `search` / `edit` / `move` / `delete` when every path is under `--cwd`
- **Deny** `execute`, `fetch`, and anything outside cwd
- Pass `--allow-execute` to allow execute tools scoped to cwd

### Library API

```ts
import { ClaudeAcpClient } from "./src/client.ts";

const client = new ClaudeAcpClient({
  cwd: "/path/to/project",
  model: "claude-sonnet-5-5",
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
cd /workspace/acp
npm run test:e2e
```

Creates a temp dir, asks the agent to write `hello.txt`, then in the **same session** edit it to `hello ACP`, and verifies the file.

## Layout

| Path | Role |
|------|------|
| `src/client.ts` | Spawns adapter over stdio, initialize, session, prompt, streaming |
| `src/cli.ts` | `acp-run` CLI |
| `src/permissions.ts` | Configurable allow/deny policy |
| `src/models.ts` | Allowed model ids |
| `src/log.ts` | stdout + optional log file for updates/diffs |
| `bin/acp-run` | Wrapper (ensures Node 22+) |

## Caveats

- Adapter package was renamed: use `@agentclientprotocol/claude-agent-acp` (not the deprecated `@zed-industries/claude-code-acp`).
- Node **20 is not supported** by the adapter; this box uses nvm Node 22.23.4.
- Cross-process `--session` uses `session/resume` when advertised, else `session/load`. Persistence depends on Claude Code's on-disk session store.
- Auth is via `CLAUDE_CODE_OAUTH_TOKEN` (or whatever Claude Code already uses on the machine). The client never prints it.
- Auto-approve is cwd-scoped only; treat `--allow-execute` as elevating privilege inside that tree.
