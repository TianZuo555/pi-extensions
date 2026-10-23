import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export const MAX_COMPARABLE_WRITE_BYTES = 512_000;
export const MAX_WRITE_METADATA_ENTRIES = 100;

export type WriteExecutionMeta = {
	fileExistedBeforeWrite: boolean;
	previousContent?: string;
	diffUnavailableReason?: string;
};

export class WriteExecutionMetadataStore {
	readonly entries = new Map<string, WriteExecutionMeta>();

	set(toolCallId: string, metadata: WriteExecutionMeta): void {
		this.entries.delete(toolCallId);
		this.entries.set(toolCallId, metadata);
		while (this.entries.size > MAX_WRITE_METADATA_ENTRIES) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	get(toolCallId: unknown): WriteExecutionMeta | undefined {
		return typeof toolCallId === "string" ? this.entries.get(toolCallId) : undefined;
	}

	delete(toolCallId: string): void {
		this.entries.delete(toolCallId);
	}

	clear(): void {
		this.entries.clear();
	}
}

async function capturePreviousContent(absolutePath: string): Promise<WriteExecutionMeta> {
	let info;
	try {
		info = await lstat(absolutePath);
	} catch (error: any) {
		if (error?.code === "ENOENT") return { fileExistedBeforeWrite: false };
		return {
			fileExistedBeforeWrite: true,
			diffUnavailableReason: "unable to inspect the previous file",
		};
	}

	if (!info.isFile()) {
		return {
			fileExistedBeforeWrite: true,
			diffUnavailableReason: "previous path is not a regular file",
		};
	}
	if (info.size > MAX_COMPARABLE_WRITE_BYTES) {
		return {
			fileExistedBeforeWrite: true,
			diffUnavailableReason: `previous file exceeds ${MAX_COMPARABLE_WRITE_BYTES} bytes`,
		};
	}

	try {
		const bytes = await readFile(absolutePath);
		const previousContent = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return { fileExistedBeforeWrite: true, previousContent };
	} catch {
		return {
			fileExistedBeforeWrite: true,
			diffUnavailableReason: "previous file is not comparable UTF-8 text",
		};
	}
}

export async function executeWriteWithMetadata(
	store: WriteExecutionMetadataStore,
	toolCallId: string,
	params: { path: string; content: string },
	signal: AbortSignal | undefined,
	cwd: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
	const absolutePath = isAbsolute(params.path) ? params.path : resolve(cwd, params.path);
	store.delete(toolCallId);
	try {
		return await withFileMutationQueue(absolutePath, async () => {
			const throwIfAborted = () => {
				if (signal?.aborted) throw new Error("Operation aborted");
			};
			throwIfAborted();
			const metadata = await capturePreviousContent(absolutePath);
			throwIfAborted();
			await mkdir(dirname(absolutePath), { recursive: true });
			throwIfAborted();
			await writeFile(absolutePath, params.content, "utf8");
			// The file is already changed. A later abort must not report failure.
			store.set(toolCallId, metadata);
			return {
				content: [
					{
						type: "text",
						text: `Successfully wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${params.path}`,
					},
				],
				details: undefined,
			};
		});
	} catch (error) {
		store.delete(toolCallId);
		throw error;
	}
}
