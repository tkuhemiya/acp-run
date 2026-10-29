import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import {
  type ModelOption,
  formatAvailableModels,
  modelMatches,
  resolveListedModelValue,
} from "./models.js";
import {
  decidePermission,
  type PermissionMode,
  type PermissionPolicy,
} from "./permissions.js";
import { createUpdateLogger, type UpdateLogger } from "./log.js";

const MODEL_CONFIG_ID = "model";

export type AcpClientOptions = {
  cwd: string;
  /** Any model id/alias the adapter lists. Omit to leave the adapter default. */
  model?: string;
  /** Existing session to load/resume. */
  sessionId?: string;
  /** Prefer resume (no history replay) when agent supports it. Default true. */
  preferResume?: boolean;
  logFile?: string;
  quietStdout?: boolean;
  /** Adapter command. Default: claude-agent-acp on PATH. */
  adapterCommand?: string;
  adapterArgs?: string[];
  permissionPolicy?: Partial<PermissionPolicy>;
  /** Extra env for the adapter (never logs secrets). */
  env?: NodeJS.ProcessEnv;
};

export type PromptResult = {
  sessionId: string;
  stopReason: string;
  /** Requested model, or null when no override was asked for. */
  modelRequested: string | null;
  modelSet: string | null;
  modelVerified: boolean;
  availableModels: string[];
};

function findAdapterBin(): string {
  const fromEnv = process.env.CLAUDE_AGENT_ACP_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const local = path.resolve(here, "../node_modules/.bin/claude-agent-acp");
  if (fs.existsSync(local)) return local;

  return "claude-agent-acp";
}

function collectModelOptions(
  configOptions: acp.SessionConfigOption[] | null | undefined,
): { currentValue: string | boolean | undefined; options: ModelOption[] } {
  const empty = {
    currentValue: undefined as string | boolean | undefined,
    options: [] as ModelOption[],
  };
  if (!configOptions) return empty;
  const model = configOptions.find((o) => o.id === MODEL_CONFIG_ID);
  if (!model || model.type !== "select") return empty;
  const options: ModelOption[] = [];
  const walk = (entries: unknown[]) => {
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as {
        value?: string;
        name?: string;
        description?: string;
        options?: unknown[];
      };
      if (typeof e.value === "string") {
        options.push({
          value: e.value,
          name: e.name,
          description: e.description,
        });
      } else if (Array.isArray(e.options)) {
        walk(e.options);
      }
    }
  };
  if (Array.isArray(model.options)) walk(model.options as unknown[]);
  return {
    currentValue: model.currentValue as string | boolean | undefined,
    options,
  };
}

async function applyModel(
  ctx: acp.ClientContext,
  sessionId: string,
  model: string | undefined,
  configOptions: acp.SessionConfigOption[] | null | undefined,
  log: (line: string) => void,
): Promise<{
  modelRequested: string | null;
  modelSet: string | null;
  modelVerified: boolean;
  availableModels: string[];
}> {
  const modelInfo = collectModelOptions(configOptions);
  const availableModels = modelInfo.options.map((o) => o.value);
  log(
    `available models (${availableModels.length}): ${formatAvailableModels(modelInfo.options)}`,
  );

  const current =
    typeof modelInfo.currentValue === "string" ? modelInfo.currentValue : null;

  // No override requested — leave adapter default alone.
  if (!model) {
    log(`no --model override; using adapter default currentValue=${current ?? "(none)"}`);
    return {
      modelRequested: null,
      modelSet: current,
      modelVerified: true,
      availableModels,
    };
  }

  if (modelInfo.options.length === 0) {
    throw new Error(
      `Cannot set model "${model}": agent did not expose a model config option. available=(none listed)`,
    );
  }

  const resolved = resolveListedModelValue(model, modelInfo.options);
  if (!resolved) {
    throw new Error(
      `Unknown model "${model}". Available: ${formatAvailableModels(modelInfo.options)}`,
    );
  }

  log(`setting model config → ${resolved} (requested=${model})`);
  const setResult = await ctx.request(acp.methods.agent.session.setConfigOption, {
    sessionId,
    configId: MODEL_CONFIG_ID,
    value: resolved,
  });
  const after = collectModelOptions(setResult.configOptions);
  const modelSet =
    typeof after.currentValue === "string" ? after.currentValue : resolved;
  const optsForMatch = after.options.length ? after.options : modelInfo.options;
  const modelVerified = modelMatches(model, modelSet, optsForMatch);
  log(`model currentValue=${modelSet} verified=${modelVerified}`);
  if (!modelVerified) {
    throw new Error(
      `Refusing to continue: model not verified. requested=${model} set=${modelSet} available=${formatAvailableModels(optsForMatch)}`,
    );
  }
  return {
    modelRequested: model,
    modelSet,
    modelVerified,
    availableModels: after.options.length
      ? after.options.map((o) => o.value)
      : availableModels,
  };
}

function resolvePolicy(
  cwd: string,
  partial?: Partial<PermissionPolicy>,
): PermissionPolicy {
  const mode: PermissionMode = partial?.mode ?? "allow-all";
  return {
    cwd,
    mode,
    allowExecuteInCwd:
      partial?.allowExecuteInCwd ?? (mode === "allow-all" ? true : false),
  };
}

export class ClaudeAcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private logger: UpdateLogger;
  private opts: AcpClientOptions;
  private cwd: string;

  constructor(opts: AcpClientOptions) {
    this.opts = opts;
    this.cwd = path.resolve(opts.cwd);
    this.logger = createUpdateLogger({
      logFile: opts.logFile,
      quietStdout: opts.quietStdout,
    });
  }

  private fsAllowed(absPath: string, policy: PermissionPolicy): boolean {
    if ((policy.mode ?? "allow-all") === "allow-all") return true;
    return absPath === this.cwd || absPath.startsWith(this.cwd + path.sep);
  }

  private attachHandlers(
    builder: ReturnType<typeof acp.client>,
    policy: PermissionPolicy,
  ) {
    return builder
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const decision = decidePermission(ctx.params, policy);
        const title = ctx.params.toolCall.title ?? ctx.params.toolCall.toolCallId;
        this.logger.logLine(
          `🔐 permission ${decision.outcome.outcome === "selected" ? decision.outcome.optionId : decision.outcome.outcome} for: ${title}`,
        );
        return decision;
      })
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
        const p = path.resolve(ctx.params.path);
        if (!this.fsAllowed(p, policy)) {
          throw new Error(`fs/read_text_file denied outside cwd: ${p}`);
        }
        const content = await fs.promises.readFile(p, "utf8");
        return { content };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        const p = path.resolve(ctx.params.path);
        if (!this.fsAllowed(p, policy)) {
          throw new Error(`fs/write_text_file denied outside cwd: ${p}`);
        }
        await fs.promises.mkdir(path.dirname(p), { recursive: true });
        await fs.promises.writeFile(p, ctx.params.content, "utf8");
        return {};
      })
      .onNotification(acp.methods.client.session.update, async (ctx) => {
        void ctx;
      });
  }

  async runPrompt(prompt: string): Promise<PromptResult> {
    const model = this.opts.model?.trim() || undefined;
    const adapter = this.opts.adapterCommand ?? findAdapterBin();
    const args = this.opts.adapterArgs ?? [];

    this.logger.logLine(`ACP adapter: ${adapter} ${args.join(" ")}`.trim());
    this.logger.logLine(`cwd: ${this.cwd}`);
    this.logger.logLine(`model requested: ${model ?? "(adapter default)"}`);

    this.child = spawn(adapter, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...this.opts.env,
        ...(process.env.CLAUDE_CODE_OAUTH_TOKEN
          ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }
          : {}),
      },
      cwd: this.cwd,
    });

    this.child.stderr.on("data", (buf: Buffer) => {
      const text = buf.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        if (/oauth|token|authorization|api[_-]?key/i.test(line)) {
          this.logger.logLine(`[adapter:stderr] <redacted>`);
        } else {
          this.logger.logLine(`[adapter:stderr] ${line}`);
        }
      }
    });

    const input = Writable.toWeb(this.child.stdin);
    const output = Readable.toWeb(
      this.child.stdout,
    ) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const policy = resolvePolicy(this.cwd, this.opts.permissionPolicy);
    this.logger.logLine(`permission mode: ${policy.mode}`);

    try {
      const result = await this.attachHandlers(
        acp.client({ name: "acp-run" }),
        policy,
      ).connectWith(stream, async (ctx) => {
          const init = await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: true },
            },
            clientInfo: {
              name: "acp-run",
              version: "1.0.0",
            },
          });

          this.logger.logLine(
            `✅ initialized protocol v${init.protocolVersion}`,
          );
          const caps = init.agentCapabilities ?? {};
          this.logger.logLine(
            `agent caps: loadSession=${Boolean(caps.loadSession)} resume=${Boolean(
              (caps as { sessionCapabilities?: { resume?: unknown } })
                .sessionCapabilities?.resume,
            )}`,
          );

          let session: acp.ActiveSession;
          let configOptions: acp.SessionConfigOption[] | null | undefined;
          let sessionId: string;

          if (this.opts.sessionId) {
            sessionId = this.opts.sessionId;
            const canResume = Boolean(
              (caps as { sessionCapabilities?: { resume?: unknown } })
                .sessionCapabilities?.resume,
            );
            const canLoad = Boolean(caps.loadSession);
            const preferResume = this.opts.preferResume !== false;

            if (preferResume && canResume) {
              this.logger.logLine(`↻ session/resume ${sessionId}`);
              const resumed = await ctx.request(acp.methods.agent.session.resume, {
                sessionId,
                cwd: this.cwd,
                mcpServers: [],
              });
              configOptions = resumed?.configOptions;
              session = (
                ctx as unknown as {
                  attachSession: (r: { sessionId: string }) => acp.ActiveSession;
                }
              ).attachSession({
                sessionId,
                ...(resumed ?? {}),
              });
            } else if (canLoad) {
              this.logger.logLine(`↻ session/load ${sessionId}`);
              const loaded = await ctx.request(acp.methods.agent.session.load, {
                sessionId,
                cwd: this.cwd,
                mcpServers: [],
              });
              configOptions = loaded?.configOptions;
              session = (
                ctx as unknown as {
                  attachSession: (r: { sessionId: string }) => acp.ActiveSession;
                }
              ).attachSession({
                sessionId,
                ...(loaded ?? {}),
              });
            } else {
              throw new Error(
                `Agent cannot load/resume session ${sessionId} (loadSession=${canLoad}, resume=${canResume})`,
              );
            }
          } else {
            session = await ctx
              .buildSession({
                cwd: this.cwd,
                mcpServers: [],
              })
              .start();
            sessionId = session.sessionId;
            configOptions = session.newSessionResponse.configOptions;
            this.logger.logLine(`📝 session ${sessionId}`);
          }

          const modelResult = await applyModel(
            ctx,
            sessionId,
            model,
            configOptions,
            (line) => this.logger.logLine(line),
          );

          this.logger.logLine(
            `💬 prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? "…" : ""}`,
          );
          void session.prompt(prompt);

          let stopReason = "unknown";
          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind === "stop") {
              stopReason = message.stopReason ?? message.response.stopReason;
              this.logger.logLine(`\n⏹ stop: ${stopReason}`);
              break;
            }
            this.logger.logUpdate(message.notification);
          }

          session.dispose();

          const closeCap = (
            caps as { sessionCapabilities?: { close?: unknown } }
          ).sessionCapabilities?.close;
          if (closeCap) {
            try {
              await ctx.request(acp.methods.agent.session.close, { sessionId });
            } catch {
              // ignore
            }
          }

          return {
            sessionId,
            stopReason,
            modelRequested: modelResult.modelRequested,
            modelSet: modelResult.modelSet,
            modelVerified: modelResult.modelVerified,
            availableModels: modelResult.availableModels,
          } satisfies PromptResult;
        });

      return result;
    } finally {
      this.shutdown();
    }
  }

  /**
   * Run two prompts in one adapter process / same ACP session (no reload).
   * Used by the e2e test.
   */
  async runPromptsInSameSession(
    prompts: string[],
  ): Promise<{ sessionId: string; results: PromptResult[] }> {
    if (prompts.length === 0) throw new Error("no prompts");
    const model = this.opts.model?.trim() || undefined;
    const adapter = this.opts.adapterCommand ?? findAdapterBin();
    const args = this.opts.adapterArgs ?? [];

    this.child = spawn(adapter, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...this.opts.env,
        ...(process.env.CLAUDE_CODE_OAUTH_TOKEN
          ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }
          : {}),
      },
      cwd: this.cwd,
    });

    this.child.stderr.on("data", (buf: Buffer) => {
      const text = buf.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        if (/oauth|token|authorization|api[_-]?key/i.test(line)) {
          this.logger.logLine(`[adapter:stderr] <redacted>`);
        } else {
          this.logger.logLine(`[adapter:stderr] ${line}`);
        }
      }
    });

    const input = Writable.toWeb(this.child.stdin);
    const output = Readable.toWeb(
      this.child.stdout,
    ) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const policy = resolvePolicy(this.cwd, this.opts.permissionPolicy);
    this.logger.logLine(`permission mode: ${policy.mode}`);

    try {
      return await this.attachHandlers(
        acp.client({ name: "acp-run" }),
        policy,
      ).connectWith(stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: true },
            },
            clientInfo: { name: "acp-run", version: "1.0.0" },
          });

          const session = await ctx
            .buildSession({ cwd: this.cwd, mcpServers: [] })
            .start();
          const sessionId = session.sessionId;
          this.logger.logLine(`📝 session ${sessionId}`);

          const modelResult = await applyModel(
            ctx,
            sessionId,
            model,
            session.newSessionResponse.configOptions,
            (line) => this.logger.logLine(line),
          );

          const results: PromptResult[] = [];
          for (const [i, prompt] of prompts.entries()) {
            this.logger.logLine(`\n===== prompt ${i + 1}/${prompts.length} =====`);
            this.logger.logLine(`💬 ${prompt.slice(0, 200)}`);
            void session.prompt(prompt);
            let stopReason = "unknown";
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") {
                stopReason = message.stopReason ?? message.response.stopReason;
                this.logger.logLine(`\n⏹ stop: ${stopReason}`);
                break;
              }
              this.logger.logUpdate(message.notification);
            }
            results.push({
              sessionId,
              stopReason,
              modelRequested: modelResult.modelRequested,
              modelSet: modelResult.modelSet,
              modelVerified: modelResult.modelVerified,
              availableModels: modelResult.availableModels,
            });
          }

          session.dispose();
          return { sessionId, results };
        });
    } finally {
      this.shutdown();
    }
  }

  private shutdown() {
    this.logger.close();
    if (this.child && !this.child.killed) {
      try {
        this.child.stdin.end();
      } catch {
        /* ignore */
      }
      this.child.kill("SIGTERM");
      setTimeout(() => {
        try {
          this.child?.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 2000).unref();
    }
    this.child = null;
  }
}
