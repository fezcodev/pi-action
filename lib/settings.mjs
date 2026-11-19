/**
 * Provider extension settings the runner reports on. Validation stays with the installed provider:
 * an invalid block makes it log PROVIDER_STARTUP_FAILURE, which the runner turns into a failed step.
 */

export const PROVIDER_SETTINGS_NAMESPACE = "pi-cliproxyapi-provider";

/** Logged by every provider release (0.4.0-0.6.0 checked) when it falls back to placeholder models. */
export const PROVIDER_STARTUP_FAILURE = "[pi-cliproxyapi-provider] registered placeholder provider after startup failure:";

/** `messageThreads` arrived in provider 0.6.0; earlier releases ignore it. */
export function supportsMessageThreads(version) {
  const match = /^(\d+)\.(\d+)\./.exec(String(version ?? ""));
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 0 || minor >= 6;
}

/**
 * The project's boolean `messageThreads`, if it sets one. A non-boolean value fails the provider's
 * own validation, which the runner reports through PROVIDER_STARTUP_FAILURE instead.
 *
 * @param {unknown} settings project settings from pi's SettingsManager.getProjectSettings()
 * @returns {boolean | undefined}
 */
export function projectMessageThreads(settings) {
  const value = settings?.[PROVIDER_SETTINGS_NAMESPACE]?.messageThreads;
  return typeof value === "boolean" ? value : undefined;
}

/** The provider's reason from a stderr line carrying PROVIDER_STARTUP_FAILURE, else undefined. */
export function providerStartupFailure(line) {
  const index = line.indexOf(PROVIDER_STARTUP_FAILURE);
  return index === -1 ? undefined : line.slice(index + PROVIDER_STARTUP_FAILURE.length).trim() || "unknown error";
}
