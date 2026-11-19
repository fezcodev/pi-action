/**
 * The checkout's `.pi/settings.json`, as the provider extension reads it.
 *
 * The extension layers the checkout's settings over the agent dir's whether or not pi trusts the
 * project, and throws on an invalid `pi-cliproxyapi-provider` block. pi then registers only a
 * placeholder provider and every model reads as unavailable, so the runner checks the block first.
 */

export const PROVIDER_SETTINGS_NAMESPACE = "pi-cliproxyapi-provider";

export const BOOLEAN_SETTINGS = ["perTurnEffort", "midConversationUpdates", "messageThreads", "showStrictMode"];

/**
 * Mirrors the extension's parseSettingsLayer (src/settings.ts). Unparseable JSON is not an error:
 * pi's SettingsManager reads it as empty settings.
 *
 * @param {string} text file contents
 * @returns {{error?: string, messageThreads?: boolean}}
 */
export function readProjectProviderSettings(text) {
  let settings;
  try {
    settings = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  const block = settings[PROVIDER_SETTINGS_NAMESPACE];
  if (block === undefined) return {};
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return { error: `${PROVIDER_SETTINGS_NAMESPACE} must be an object` };
  }
  if (block.gpt56ContextWindow !== undefined && !["canonical", "full"].includes(block.gpt56ContextWindow)) {
    return { error: `${PROVIDER_SETTINGS_NAMESPACE}.gpt56ContextWindow must be "canonical" or "full"` };
  }
  for (const key of BOOLEAN_SETTINGS) {
    if (block[key] !== undefined && typeof block[key] !== "boolean") {
      return { error: `${PROVIDER_SETTINGS_NAMESPACE}.${key} must be a boolean` };
    }
  }
  return block.messageThreads === undefined ? {} : { messageThreads: block.messageThreads };
}
