// Optional MiMo console cookie import from a Playwriter-enabled browser tab.
// Never print or persist browser cookies; only the balance endpoint receives them.

const BALANCE_URL = "https://platform.xiaomimimo.com/api/v1/balance";
const COOKIE_NAMES = ["api-platform_serviceToken", "userId", "api-platform_ph", "api-platform_slh"];

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
}

export function xiaomiCookieHeader(
  cookies: readonly BrowserCookie[],
  now = Date.now() / 1000,
): string | undefined {
  const selected = new Map<string, BrowserCookie>();
  for (const cookie of cookies) {
    if (
      !COOKIE_NAMES.includes(cookie.name) ||
      !cookie.value ||
      (cookie.expires > 0 && cookie.expires <= now)
    )
      continue;
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    if (domain !== "xiaomimimo.com" && domain !== "platform.xiaomimimo.com") continue;
    if (!"/api/v1/balance".startsWith(cookie.path)) continue;
    const previous = selected.get(cookie.name);
    if (!previous || domain.length > previous.domain.replace(/^\./, "").length)
      selected.set(cookie.name, cookie);
  }
  if (!selected.has("api-platform_serviceToken") || !selected.has("userId")) return undefined;
  return COOKIE_NAMES.flatMap((name) => {
    const cookie = selected.get(name);
    return cookie ? [`${name}=${cookie.value}`] : [];
  }).join("; ");
}

export async function importXiaomiBrowserCookie(): Promise<string | undefined> {
  const { connectViaExtension, getCDPSessionForPage } = await import("playwriter");
  const connection = await connectViaExtension({ tabGroup: "mimo" });
  try {
    // The confirmed command only inspects an already-enabled MiMo console tab.
    const page = connection.browser
      .contexts()
      .flatMap((context) => context.pages())
      .reverse()
      .find((candidate) => candidate.url().startsWith("https://platform.xiaomimimo.com/"));
    if (!page) return undefined;
    const cdp = await getCDPSessionForPage({ page });
    const { cookies } = await cdp.send("Network.getCookies", { urls: [BALANCE_URL] });
    return xiaomiCookieHeader(cookies);
  } finally {
    await connection.close();
  }
}
