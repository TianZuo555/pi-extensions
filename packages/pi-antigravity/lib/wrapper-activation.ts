/**
 * Wrapper-tool activation policy.
 *
 * The display-only `antigravity` wrapper is only useful while an agy model is
 * selected (the provider synthesizes its toolCalls from recorded agy
 * activity). For every other model it is dead weight in the tools payload, so
 * the active-tool set is synced on session start and every model switch.
 */

/** Compute the next active-tool list after a model switch, or undefined when
 * the wrapper's activation already matches the selected provider. */
export function wrapperToolActiveAfterModelSwitch(
  activeTools: readonly string[],
  wrapperTool: string,
  provider: string | undefined,
  wrapperProvider: string,
): readonly string[] | undefined {
  const want = provider === wrapperProvider;
  const has = activeTools.includes(wrapperTool);
  if (want === has) return undefined;
  return want ? [...activeTools, wrapperTool] : activeTools.filter((name) => name !== wrapperTool);
}
