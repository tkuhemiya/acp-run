import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAcpClient } from "./client.js";

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-e2e-"));
  const logFile = path.join(tmp, "acp.log");
  console.log(`e2e cwd: ${tmp}`);

  const client = new ClaudeAcpClient({
    cwd: tmp,
    model: "claude-sonnet-5-5",
    logFile,
    // Default permission mode is allow-all; no need to elevate.
  });

  const { sessionId, results } = await client.runPromptsInSameSession([
    "Create a file named hello.txt in the current working directory containing exactly: hello world",
    "Edit hello.txt so its contents are exactly: hello ACP",
  ]);

  console.log(`\nSESSION_ID=${sessionId}`);
  console.log(`turns=${results.length}`);
  for (const [i, r] of results.entries()) {
    console.log(
      `turn ${i + 1}: stop=${r.stopReason} modelSet=${r.modelSet} verified=${r.modelVerified}`,
    );
  }

  const helloPath = path.join(tmp, "hello.txt");
  if (!fs.existsSync(helloPath)) {
    throw new Error(`hello.txt missing after prompts. log: ${logFile}`);
  }
  const body = fs.readFileSync(helloPath, "utf8").trim();
  console.log(`hello.txt => ${JSON.stringify(body)}`);
  if (body !== "hello ACP") {
    throw new Error(`expected "hello ACP", got ${JSON.stringify(body)}`);
  }
  console.log("E2E PASS");
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
