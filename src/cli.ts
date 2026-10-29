#!/usr/bin/env node
import path from "node:path";
import { ClaudeAcpClient } from "./client.js";
import { ALLOWED_MODELS, DEFAULT_MODEL, parseModel } from "./models.js";

function usage(code = 1): never {
  const msg = `Usage: acp-run --cwd DIR [--session ID] [--model MODEL] [--log FILE] [--allow-execute] "prompt"

Options:
  --cwd DIR          Working directory for the ACP session (required)
  --session ID       Resume/load an existing session id
  --model MODEL      ${DEFAULT_MODEL} (default) or claude-haiku-5-5
  --log FILE         Append session updates to a log file
  --allow-execute    Allow execute tools scoped to cwd (default: deny)
  --no-resume        Prefer session/load over session/resume
  -h, --help         Show help

Allowed models: ${ALLOWED_MODELS.join(", ")}
`;
  process.stderr.write(msg);
  process.exit(code);
}

function parseArgs(argv: string[]) {
  const out: {
    cwd?: string;
    session?: string;
    model?: string;
    log?: string;
    allowExecute: boolean;
    preferResume: boolean;
    promptParts: string[];
  } = {
    allowExecute: false,
    preferResume: true,
    promptParts: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") usage(0);
    else if (a === "--cwd") out.cwd = argv[++i];
    else if (a === "--session") out.session = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--log") out.log = argv[++i];
    else if (a === "--allow-execute") out.allowExecute = true;
    else if (a === "--no-resume") out.preferResume = false;
    else if (a.startsWith("-")) {
      process.stderr.write(`Unknown flag: ${a}\n`);
      usage(1);
    } else {
      out.promptParts.push(a);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cwd) {
    process.stderr.write("--cwd is required\n");
    usage(1);
  }
  const prompt = args.promptParts.join(" ").trim();
  if (!prompt) {
    process.stderr.write("prompt is required\n");
    usage(1);
  }

  const model = parseModel(args.model);
  const cwd = path.resolve(args.cwd);

  const client = new ClaudeAcpClient({
    cwd,
    model,
    sessionId: args.session,
    preferResume: args.preferResume,
    logFile: args.log,
    permissionPolicy: { allowExecuteInCwd: args.allowExecute },
  });

  const result = await client.runPrompt(prompt);
  process.stdout.write("\n");
  process.stdout.write(`SESSION_ID=${result.sessionId}\n`);
  process.stdout.write(`STOP_REASON=${result.stopReason}\n`);
  process.stdout.write(`MODEL_REQUESTED=${result.modelRequested}\n`);
  process.stdout.write(`MODEL_SET=${result.modelSet ?? ""}\n`);
  process.stdout.write(`MODEL_VERIFIED=${result.modelVerified}\n`);
  if (result.stopReason !== "end_turn" && result.stopReason !== "max_tokens") {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stderr.write(`acp-run failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
