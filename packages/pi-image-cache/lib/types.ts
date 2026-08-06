export type CachedImage = {
  id: number;
  placeholder: string;
  filePath: string;
  mimeType: string;
  createdAt: number;
  /** sha256 of the *original* pasted bytes, used to deduplicate repeated pastes. */
  sourceHash: string;
  sourcePath?: string;
};

export type Manifest = {
  version: 1;
  images: CachedImage[];
};

export type PreviewEntryData = {
  placeholder: string;
  filePath: string;
  mimeType: string;
};

export type ClipboardScriptResult =
  | { kind: "data" }
  | { kind: "files"; paths: string[] }
  | { kind: "none" };

export type ClipboardImages = {
  images: CachedImage[];
  /** Copied files we could see on the pasteboard but could not read (usually TCC). */
  unreadable: string[];
};
