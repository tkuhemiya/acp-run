#!/usr/bin/env node
import path from "node:path";
import { ClaudeAcpClient } from "./client.js";

function usage(code = 1): never {
  const msg = `Usage: acp-run --cwd DIR [--session ID] [--model MODEL] [--log FILE] [--safe] [--allow-execute] "prompt"

Options:
  --cwd DIR          Working directory for the ACP session (required)
  --session ID       Resume/load an existing session id
  --model MODEL      Any model id/alias the adapter lists (default: adapter default)
  --log FILE         Append session updates to a log file
  --safe             Restrict permissions to cwd (read/edit inside cwd; deny execute/fetch)
  --allow-execute    With --safe only: also allow execute tools scoped to cwd
  --no-resume        Prefer session/load over session/resume
  -h, --help         Show help

Permission default is allow-all (auto-approve every tool). Use --safe on machines
you care about. Intended for disposable servers/sandboxes by default.
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
    safe: boolean;
    allowExecute: boolean;
    preferResume: boolean;
    promptParts: string[];
  } = {
    safe: false,
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
    else if (a === "--safe" || a === "--permission-mode=cwd-only") out.safe = true;
    else if (a === "--permission-mode") {
      const v = argv[++i];
      if (v === "cwd-only" || v === "safe") out.safe = true;
      else if (v === "allow-all" || v === "dangerous") out.safe = false;
      else {
        process.stderr.write(`Unknown --permission-mode: ${v}\n`);
        usage(1);
      }
    } else if (a === "--allow-execute") out.allowExecute = true;
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

  if (args.allowExecute && !args.safe) {
    process.stderr.write(
      "note: --allow-execute only applies with --safe (default is already allow-all)\n",
    );
  }

  const cwd = path.resolve(args.cwd);
  const model = args.model?.trim() || undefined;

  const client = new ClaudeAcpClient({
    cwd,
    model,
    sessionId: args.session,
    preferResume: args.preferResume,
    logFile: args.log,
    permissionPolicy: {
      mode: args.safe ? "safe" : "allow-all",
      allowExecuteInCwd: args.safe ? args.allowExecute : true,
    },
  });

  const result = await client.runPrompt(prompt);
  process.stdout.write("\n");
  process.stdout.write(`SESSION_ID=${result.sessionId}\n`);
  process.stdout.write(`STOP_REASON=${result.stopReason}\n`);
  process.stdout.write(`MODEL_REQUESTED=${result.modelRequested ?? ""}\n`);
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
