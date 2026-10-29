import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";

export type PermissionMode = "allow-all" | "safe";

export type PermissionPolicy = {
  /** Absolute cwd; used by "safe" mode to scope read/edit/execute. */
  cwd: string;
  /**
   * "allow-all" (default): auto-approve every permission request, preferring
   * allow_always then allow_once. Intended for disposable servers/sandboxes.
   * "safe": allow read/edit inside cwd only; deny execute/fetch/outside unless
   * allowExecuteInCwd is set.
   */
  mode?: PermissionMode;
  /** When mode is "safe", also allow execute tools scoped to cwd. Default false. */
  allowExecuteInCwd?: boolean;
};

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return (
    resolved === resolvedRoot ||
    resolved.startsWith(resolvedRoot + path.sep)
  );
}

function collectPaths(toolCall: acp.RequestPermissionRequest["toolCall"]): string[] {
  const paths: string[] = [];
  const locs = toolCall.locations ?? [];
  for (const loc of locs) {
    if (loc?.path) paths.push(loc.path);
  }
  const raw = toolCall.rawInput;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["path", "file_path", "filePath", "target", "filename"]) {
      const v = obj[key];
      if (typeof v === "string") paths.push(v);
    }
    if (Array.isArray(obj.paths)) {
      for (const p of obj.paths) {
        if (typeof p === "string") paths.push(p);
      }
    }
  }
  return paths;
}

function pickOption(
  options: acp.PermissionOption[],
  kinds: acp.PermissionOptionKind[],
): acp.PermissionOption | undefined {
  for (const kind of kinds) {
    const hit = options.find((o) => o.kind === kind);
    if (hit) return hit;
  }
  return undefined;
}

function decideSafe(
  params: acp.RequestPermissionRequest,
  policy: PermissionPolicy,
): acp.RequestPermissionResponse {
  const tool = params.toolCall;
  const kind = (tool.kind ?? "other") as string;
  const paths = collectPaths(tool).map((p) =>
    path.isAbsolute(p) ? p : path.resolve(policy.cwd, p),
  );
  const allInside =
    paths.length > 0 && paths.every((p) => isPathInside(policy.cwd, p));
  const noPaths = paths.length === 0;

  let allow = false;
  if (kind === "read" || kind === "search") {
    allow = allInside || noPaths;
  } else if (kind === "edit" || kind === "move") {
    allow = allInside;
  } else if (kind === "delete") {
    allow = allInside;
  } else if (kind === "execute") {
    allow = Boolean(policy.allowExecuteInCwd) && (allInside || noPaths);
  } else if (kind === "think" || kind === "switch_mode") {
    allow = true;
  } else {
    allow = false;
  }

  if (!allow && allInside && (kind === "other" || !tool.kind)) {
    allow = true;
  }

  const selected = allow
    ? pickOption(params.options, ["allow_once", "allow_always"])
    : pickOption(params.options, ["reject_once", "reject_always"]);

  if (!selected) {
    return { outcome: { outcome: "cancelled" } };
  }

  return {
    outcome: {
      outcome: "selected",
      optionId: selected.optionId,
    },
  };
}

function decideAllowAll(
  params: acp.RequestPermissionRequest,
): acp.RequestPermissionResponse {
  // Prefer "allow always" so subsequent identical tool calls aren't re-prompted.
  const selected = pickOption(params.options, ["allow_always", "allow_once"]);
  if (!selected) {
    return { outcome: { outcome: "cancelled" } };
  }
  return {
    outcome: {
      outcome: "selected",
      optionId: selected.optionId,
    },
  };
}

/**
 * Decide a session/request_permission response.
 * Default mode is allow-all (permissive; for disposable sandboxes).
 */
export function decidePermission(
  params: acp.RequestPermissionRequest,
  policy: PermissionPolicy,
): acp.RequestPermissionResponse {
  const mode: PermissionMode = policy.mode ?? "allow-all";
  if (mode === "allow-all") {
    return decideAllowAll(params);
  }
  return decideSafe(params, policy);
}
