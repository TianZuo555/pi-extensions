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
