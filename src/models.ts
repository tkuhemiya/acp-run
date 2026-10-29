/** Model helpers: pass through any id the adapter lists; no hardcoded allowlist. */

export type ModelOption = {
  value: string;
  name?: string;
  description?: string;
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/^claude[-_]?/, "")
    .replace(/[\s_.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function familyOf(s: string): string | null {
  const n = normalize(s);
  const m = n.match(/(sonnet|haiku|opus|fable)/);
  return m ? m[1] : null;
}

function versionOf(s: string): string | null {
  const m = normalize(s).match(/(\d)[.-]?(\d)/);
  return m ? `${m[1]}.${m[2]}` : null;
}

function optionHay(opt: ModelOption): string {
  return `${opt.value} ${opt.name ?? ""} ${opt.description ?? ""}`;
}

/**
 * Resolve a user-requested model id/alias against the adapter's listed options.
 * Matches exact value, case-insensitive value, normalized id, family+version,
 * then name/description substrings.
 * Returns null if nothing matches (caller should error with the available list).
 */
export function resolveListedModelValue(
  requested: string,
  options: ModelOption[],
): string | null {
  const q = requested.trim();
  if (!q || options.length === 0) return null;

  const lower = q.toLowerCase();
  const normQ = normalize(q);
  const famQ = familyOf(q);
  const verQ = versionOf(q);

  for (const opt of options) {
    if (opt.value === q) return opt.value;
  }
  for (const opt of options) {
    if (opt.value.toLowerCase() === lower) return opt.value;
  }
  for (const opt of options) {
    if (normalize(opt.value) === normQ) return opt.value;
  }

  if (famQ) {
    type Hit = { value: string; score: number };
    const hits: Hit[] = [];
    for (const opt of options) {
      const hay = optionHay(opt);
      if (familyOf(hay) !== famQ) continue;
      const verO = versionOf(hay);
      let score = 10;
      if (verQ && verO === verQ) score += 100;
      else if (verQ && verO && verO !== verQ) continue; // wrong version
      if (normalize(opt.value) === famQ) score += 30;
      score -= Math.min(opt.value.length, 40);
      hits.push({ value: opt.value, score });
    }
    if (hits.length > 0) {
      hits.sort((a, b) => b.score - a.score);
      return hits[0].value;
    }
  }

  const scored: { value: string; score: number }[] = [];
  for (const opt of options) {
    const hay = optionHay(opt).toLowerCase();
    if (!hay.includes(lower) && !hay.includes(normQ)) continue;
    let score = 0;
    if ((opt.name ?? "").toLowerCase() === lower) score += 100;
    if (opt.value.toLowerCase().startsWith(lower)) score += 50;
    if ((opt.name ?? "").toLowerCase().includes(lower)) score += 20;
    score -= opt.value.length;
    scored.push({ value: opt.value, score });
  }
  if (scored.length > 0) {
    scored.sort((a, b) => b.score - a.score);
    return scored[0].value;
  }

  return null;
}

/** Whether currentValue satisfies the requested model. */
export function modelMatches(
  requested: string,
  currentValue: string | null | undefined,
  options: ModelOption[],
): boolean {
  if (!currentValue) return false;
  const resolved = resolveListedModelValue(requested, options);
  if (resolved && currentValue === resolved) return true;
  if (currentValue.toLowerCase() === requested.trim().toLowerCase()) return true;

  const famR = familyOf(requested);
  if (!famR) return false;
  const opt = options.find((o) => o.value === currentValue);
  const hay = opt ? optionHay(opt) : currentValue;
  if (familyOf(hay) !== famR) return false;
  const verR = versionOf(requested);
  if (!verR) return true;
  const verH = versionOf(hay);
  return !verH || verH === verR;
}

export function formatAvailableModels(options: ModelOption[]): string {
  if (options.length === 0) return "(none listed)";
  return options
    .map((o) => (o.name ? `${o.value} (${o.name})` : o.value))
    .join(", ");
}
