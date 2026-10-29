/** User-facing model ids accepted by acp-run. */
export const ALLOWED_MODELS = [
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

export const DEFAULT_MODEL: AllowedModel = "claude-sonnet-5-5";

/** Adapter-side aliases observed for Claude Code ACP model config. */
const PREFERRED_ALIASES: Record<AllowedModel, string[]> = {
  "claude-sonnet-5-5": ["claude-sonnet-5-5", "sonnet", "sonnet-5-5", "sonnet5.5"],
  "claude-haiku-5-5": ["claude-haiku-5-5", "haiku", "haiku-5-5", "haiku5.5"],
};

export type ModelOption = {
  value: string;
  name?: string;
  description?: string;
};

export function parseModel(raw: string | undefined): AllowedModel {
  const value = (raw ?? DEFAULT_MODEL).trim();
  if ((ALLOWED_MODELS as readonly string[]).includes(value)) {
    return value as AllowedModel;
  }
  throw new Error(
    `Unsupported model "${value}". Allowed: ${ALLOWED_MODELS.join(", ")}`,
  );
}

function familyOf(preferred: AllowedModel): "sonnet" | "haiku" {
  return preferred.includes("haiku") ? "haiku" : "sonnet";
}

/** Pick the best listed config value for a preferred user model id. */
export function resolveListedModelValue(
  preferred: AllowedModel,
  options: ModelOption[],
): string | null {
  if (options.length === 0) return null;

  const aliases = PREFERRED_ALIASES[preferred].map((a) => a.toLowerCase());
  const family = familyOf(preferred);

  // 1. Exact value match against preferred id or known aliases
  for (const opt of options) {
    if (aliases.includes(opt.value.toLowerCase())) return opt.value;
  }

  // 2. Name/description says "Sonnet 5.5" / "Haiku 5.5"
  for (const opt of options) {
    const hay = `${opt.value} ${opt.name ?? ""} ${opt.description ?? ""}`.toLowerCase();
    if (!hay.includes(family)) continue;
    if (/5[.\s-]?5/.test(hay)) return opt.value;
  }

  // 3. Family-only fallback (e.g. value "sonnet" with name "Sonnet")
  for (const opt of options) {
    const hay = `${opt.value} ${opt.name ?? ""}`.toLowerCase();
    if (hay === family || hay.startsWith(family + " ")) return opt.value;
  }

  return null;
}

/** Whether the agent's currentValue satisfies the requested model. */
export function modelMatches(
  preferred: AllowedModel,
  currentValue: string | null | undefined,
  options: ModelOption[],
): boolean {
  if (!currentValue) return false;
  const resolved = resolveListedModelValue(preferred, options);
  if (resolved && currentValue === resolved) return true;

  const aliases = PREFERRED_ALIASES[preferred].map((a) => a.toLowerCase());
  if (aliases.includes(currentValue.toLowerCase())) return true;

  const family = familyOf(preferred);
  const opt = options.find((o) => o.value === currentValue);
  const hay = `${currentValue} ${opt?.name ?? ""} ${opt?.description ?? ""}`.toLowerCase();
  return hay.includes(family) && /5[.\s-]?5/.test(hay);
}
