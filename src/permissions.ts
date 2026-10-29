import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";

export type PermissionPolicy = {
  /** Absolute cwd; reads/edits whose paths resolve under this are allowed. */
  cwd: string;
  /** When true, also allow execute tools whose cwd/working dir is inside cwd. Default false. */
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

/**
 * Default policy: allow read/edit (and similar) when every named path is inside
 * cwd; otherwise reject. Execute/delete/fetch/other denied unless explicitly
 * allowed by policy flags.
 */
export function decidePermission(
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
    allow = allInside || noPaths; // search with no path often means workspace-scoped
  } else if (kind === "edit" || kind === "move") {
    allow = allInside;
  } else if (kind === "delete") {
    allow = allInside; // still inside cwd only
  } else if (kind === "execute") {
    allow = Boolean(policy.allowExecuteInCwd) && (allInside || noPaths);
  } else if (kind === "think" || kind === "switch_mode") {
    allow = true;
  } else {
    // fetch / other: deny by default
    allow = false;
  }

  // Title/path fallback: if kind missing but paths all inside and looks like file op
  if (!allow && allInside && (kind === "other" || !tool.kind)) {
    allow = true;
  }

  const selected = allow
    ? pickOption(params.options, ["allow_once", "allow_always"])
    : pickOption(params.options, ["reject_once", "reject_always"]);

  if (!selected) {
    // No matching option — cancel rather than guess
    return { outcome: { outcome: "cancelled" } };
  }

  return {
    outcome: {
      outcome: "selected",
      optionId: selected.optionId,
    },
  };
}
