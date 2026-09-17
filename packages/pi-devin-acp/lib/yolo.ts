/** Keep the in-memory permission policy aligned with a successful mode change,
 * even when saving the preference to disk fails. Persistence is not the
 * source of truth for the mode already applied to the running session.
 */
export async function applyYoloMode(
  enabled: boolean,
  deps: {
    setMode: (enabled: boolean) => Promise<void>;
    setEnabled: (enabled: boolean) => void;
    persist: (enabled: boolean) => void;
  },
): Promise<{ persisted: true } | { persisted: false; error: unknown }> {
  await deps.setMode(enabled);
  deps.setEnabled(enabled);
  try {
    deps.persist(enabled);
    return { persisted: true };
  } catch (error) {
    return { persisted: false, error };
  }
}
