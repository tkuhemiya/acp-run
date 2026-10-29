import fs from "node:fs";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";

export type UpdateLogger = {
  logLine: (line: string) => void;
  logUpdate: (notification: acp.SessionNotification) => void;
  close: () => void;
};

export function createUpdateLogger(opts: {
  logFile?: string;
  quietStdout?: boolean;
}): UpdateLogger {
  const streams: fs.WriteStream[] = [];
  if (opts.logFile) {
    fs.mkdirSync(path.dirname(path.resolve(opts.logFile)), { recursive: true });
    streams.push(fs.createWriteStream(opts.logFile, { flags: "a" }));
  }

  const write = (line: string) => {
    if (!opts.quietStdout) {
      process.stdout.write(line.endsWith("\n") ? line : line + "\n");
    }
    for (const s of streams) {
      s.write(line.endsWith("\n") ? line : line + "\n");
    }
  };

  return {
    logLine: write,
    logUpdate(notification) {
      const update = notification.update as {
        sessionUpdate: string;
        content?: { type: string; text?: string } | unknown;
        title?: string;
        status?: string;
        toolCallId?: string;
        kind?: string;
        name?: string;
      };
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
        case "agent_thought_chunk":
        case "user_message_chunk": {
          const c = update.content as { type?: string; text?: string } | undefined;
          if (c && c.type === "text" && typeof c.text === "string") {
            if (update.sessionUpdate === "agent_message_chunk") {
              process.stdout.write(c.text);
              for (const s of streams) s.write(c.text);
            } else {
              write(`[${update.sessionUpdate}] ${c.text}`);
            }
          } else {
            write(`[${update.sessionUpdate}] ${JSON.stringify(c)}`);
          }
          break;
        }
        case "tool_call": {
          write(
            `\n🔧 tool_call ${update.name ?? ""} [${update.kind ?? "?"}] ${update.title ?? ""} (${update.status ?? "pending"})`,
          );
          break;
        }
        case "tool_call_update": {
          write(
            `🔧 tool_call_update ${update.toolCallId ?? ""} → ${update.status ?? "?"}`,
          );
          // Diffs / content
          const content = (update as { content?: unknown[] }).content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                block &&
                typeof block === "object" &&
                (block as { type?: string }).type === "diff"
              ) {
                const d = block as {
                  path: string;
                  oldText?: string | null;
                  newText?: string;
                };
                write(`   diff ${d.path}`);
                if (d.oldText != null) {
                  write(`   --- old (${d.oldText.length} chars)`);
                }
                if (d.newText != null) {
                  write(`   +++ new (${d.newText.length} chars)`);
                }
              }
            }
          }
          break;
        }
        case "plan":
          write(`[plan] ${JSON.stringify(update)}`);
          break;
        case "config_option_update":
          write(`[config_option_update]`);
          break;
        default:
          write(`[${update.sessionUpdate}]`);
          break;
      }
    },
    close() {
      for (const s of streams) s.end();
    },
  };
}
