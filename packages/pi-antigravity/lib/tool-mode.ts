export type AgyToolMode = "native" | "pi";

/** No argument toggles; explicit on/off commands are idempotent. */
export function resolveAgyToolModeCommand(
  args: string,
  current: AgyToolMode,
): AgyToolMode | "status" | undefined {
  switch (args.trim().toLowerCase()) {
    case "":
      return current === "pi" ? "native" : "pi";
    case "on":
      return "pi";
    case "off":
      return "native";
    case "status":
      return "status";
    default:
      return undefined;
  }
}

/** CLI and environment overrides take precedence over the saved user preference. */
export function readAgyToolMode(
  flag: unknown = undefined,
  env: NodeJS.ProcessEnv = process.env,
  savedMode: AgyToolMode | undefined = undefined,
): AgyToolMode {
  const value = flag ?? env.PI_ANTIGRAVITY_TOOLS ?? savedMode ?? "native";
  if (typeof value !== "string" || (value.trim() !== "native" && value.trim() !== "pi")) {
    throw new Error('--agy-tools / PI_ANTIGRAVITY_TOOLS must be exactly "native" or "pi".');
  }
  return value.trim() as AgyToolMode;
}
