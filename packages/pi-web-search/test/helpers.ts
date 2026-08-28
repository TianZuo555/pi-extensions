/**
 * Test helpers for hiding or faking ~/.pi/agent/auth.json so provider
 * resolution tests stay hermetic on machines with real stored logins
 * (e.g. openai-codex, websearch-exa). config.ts treats a read error as
 * "no auth file" and only reads paths ending in auth.json.
 */
import fs from "node:fs";

function isAuthPath(path: fs.PathOrFileDescriptor | fs.PathLike): boolean {
    return String(path).endsWith("auth.json");
}

function isConfigPath(path: fs.PathOrFileDescriptor | fs.PathLike): boolean {
    const s = String(path);
    return s.endsWith("pi-web-search/config.json") || s.endsWith("web-search.json");
}

/** Make the stored web-search config invisible for the duration of a test,
 * so provider resolution does not pick up the developer machine's real
 * searchProvider/fetchProvider/order settings. */
export function hideStoredConfig(): () => void {
    const originalReadFileSync = fs.readFileSync;
    const originalExistsSync = fs.existsSync;
    fs.existsSync = ((path: fs.PathLike) =>
        isConfigPath(path) ? false : originalExistsSync(path)) as typeof fs.existsSync;
    fs.readFileSync = ((
        path: fs.PathOrFileDescriptor,
        options?: unknown,
    ) => {
        if (isConfigPath(path)) {
            throw new Error("web-search config hidden from this test");
        }
        return originalReadFileSync(
            path,
            options as Parameters<typeof originalReadFileSync>[1],
        );
    }) as typeof fs.readFileSync;
    return () => {
        fs.readFileSync = originalReadFileSync;
        fs.existsSync = originalExistsSync;
    };
}

/** Make auth.json invisible to config.ts for the duration of a test. */
export function hidePiAuthFile(): () => void {
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = ((
        path: fs.PathOrFileDescriptor,
        options?: unknown,
    ) => {
        if (isAuthPath(path)) {
            throw new Error("auth.json hidden from this test");
        }
        return originalReadFileSync(
            path,
            options as Parameters<typeof originalReadFileSync>[1],
        );
    }) as typeof fs.readFileSync;
    return () => {
        fs.readFileSync = originalReadFileSync;
    };
}

/** Serve fake auth.json contents to config.ts for the duration of a test. */
export function stubPiAuthData(
    data: Record<string, unknown>,
): () => void {
    const originalReadFileSync = fs.readFileSync;
    const originalExistsSync = fs.existsSync;
    const json = JSON.stringify(data);
    fs.existsSync = ((path: fs.PathLike) =>
        isAuthPath(path) ? true : originalExistsSync(path)) as typeof fs.existsSync;
    fs.readFileSync = ((
        path: fs.PathOrFileDescriptor,
        options?: unknown,
    ) => {
        if (isAuthPath(path)) return json;
        return originalReadFileSync(
            path,
            options as Parameters<typeof originalReadFileSync>[1],
        );
    }) as typeof fs.readFileSync;
    return () => {
        fs.readFileSync = originalReadFileSync;
        fs.existsSync = originalExistsSync;
    };
}
