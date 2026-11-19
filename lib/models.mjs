/**
 * Model-chain planning against the gateway's /models listing.
 *
 * CLIProxyAPI drops a model from /models while it has the model suspended or
 * cooling down on every credential, and only a successful request through it
 * brings it back. Skipping unlisted models up front therefore never sends the
 * request that would clear the suspension, so a briefly hidden primary stays
 * hidden. The runner instead tries every model in the chain and lets the
 * per-attempt fallback (model_not_found, auth_unavailable, model_cooldown)
 * move on when a model really cannot answer.
 */

// CLIProxyAPI's owned_by values; the provider extension picks the wire API from it.
const OWNER_BY_PREFIX = [
  [/^claude-/, "anthropic"],
  [/^(gpt-|o\d|codex-)/, "openai"],
  [/^gemini-/, "google"],
];

export function inferOwner(id) {
  return OWNER_BY_PREFIX.find(([pattern]) => pattern.test(id))?.[1];
}

const positiveInteger = (value) => (Number.isInteger(value) && value > 0 ? value : undefined);
const stringList = (value) =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim()) ? value : undefined;

/**
 * Per-model specs from CLIProxyAPI's Codex-client catalog (`/models?client_version=`), in the
 * camelCase `spec` shape the provider extension stores in its snapshot. Mirrors the extension's
 * parseCpaModelSpecs: an entry without `max_tokens` is template filler, not CPA's own data.
 *
 * @param {unknown} payload
 * @returns {Map<string, object>} spec per CPA model id
 */
export function parseModelSpecs(payload) {
  const specs = new Map();
  const models = payload && typeof payload === "object" ? payload.models : undefined;
  if (!Array.isArray(models)) return specs;
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.slug === "string" ? entry.slug.trim() : "";
    const maxTokens = positiveInteger(entry.max_tokens);
    if (!id || !maxTokens) continue;
    const levels = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels.flatMap((level) =>
          typeof level?.effort === "string" && level.effort.trim() ? [level.effort.trim().toLowerCase()] : [],
        )
      : [];
    const input = stringList(entry.input_modalities);
    const spec = {
      ...(typeof entry.display_name === "string" && entry.display_name.trim() ? { displayName: entry.display_name } : {}),
      ...(positiveInteger(entry.context_window) ? { contextWindow: entry.context_window } : {}),
      ...(positiveInteger(entry.max_context_window) ? { maxContextWindow: entry.max_context_window } : {}),
      maxTokens,
      ...(levels.length > 0 ? { reasoningLevels: levels } : {}),
      ...(input?.length ? { inputModalities: input } : {}),
    };
    specs.set(id, spec);
  }
  return specs;
}

/** Attach specs to snapshot entries; an entry CPA published no spec for keeps none. */
export function withModelSpecs(snapshot, specs) {
  return snapshot.map(({ spec: _previous, ...entry }) => {
    const spec = specs.get(entry.id);
    return spec ? { ...entry, spec } : entry;
  });
}

/**
 * @param {string[]} modelIds bare ids in chain order (no provider prefix)
 * @param {{id: string, object?: string, owned_by?: string, created?: number}[]} gatewayModels
 * @returns {{unlisted: string[], snapshot: object[]}} unlisted ids, and the listing plus a
 *   synthetic entry per unlisted id so the provider extension registers it with real metadata.
 */
export function planModelChain(modelIds, gatewayModels) {
  const listedIds = new Set(gatewayModels.map((entry) => entry.id));
  const unlisted = [...new Set(modelIds)].filter((id) => !listedIds.has(id));
  const synthetic = unlisted.map((id) => {
    const owner = inferOwner(id);
    return { id, object: "model", ...(owner ? { owned_by: owner } : {}) };
  });
  return { unlisted, snapshot: [...gatewayModels, ...synthetic] };
}
