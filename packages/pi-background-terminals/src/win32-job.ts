import { randomUUID } from "node:crypto";

/**
 * Per-terminal Windows Job Objects.
 *
 * The manager creates a named KILL_ON_JOB_CLOSE job before it starts the
 * Windows launcher. The launcher joins itself to that job before it starts the
 * requested shell, so the shell and every descendant inherit membership with
 * no post-spawn assignment race. The manager keeps the last job handle and can
 * therefore reap the complete tree by closing it.
 */

export interface ChildJobHandle {
  /** Name used by the pre-shell launcher to join this job. */
  readonly name: string;
  /** Close the last manager-owned handle and terminate every job member. */
  close(): void;
}

// winnt.h
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;

interface Kernel32 {
  createJobObjectW(jobAttributes: null, name: string): unknown;
  setInformationJobObject(
    job: unknown,
    infoClass: number,
    info: unknown,
    infoLength: number,
  ): boolean;
  closeHandle(object: unknown): boolean;
}

interface LoadedKernel32 {
  readonly api: Kernel32;
  readonly limitInfo: unknown;
  readonly limitInfoSize: number;
}

/** One initialization promise prevents concurrent managers from defining the
 * same FFI surface twice. All Koffi types are anonymous, so Pi's module-cache-
 * free /reload can evaluate this module again without duplicate-type errors. */
let kernel32Load: Promise<LoadedKernel32 | null> | undefined;

function closeHandle(api: Kernel32, handle: unknown) {
  try {
    api.closeHandle(handle);
  } catch {
    // The process may be terminating or the handle may already be invalid.
  }
}

async function loadKernel32Once(): Promise<LoadedKernel32 | null> {
  if (process.platform !== "win32") return null;
  try {
    const koffi = (await import("koffi")).default;
    const lib = koffi.load("kernel32.dll");
    const handle = koffi.pointer(koffi.opaque());
    const ioCounters = koffi.struct({
      readOperationCount: "uint64_t",
      writeOperationCount: "uint64_t",
      otherOperationCount: "uint64_t",
      readTransferCount: "uint64_t",
      writeTransferCount: "uint64_t",
      otherTransferCount: "uint64_t",
    });
    // Node 26 supports Windows x64/arm64, where SIZE_T and ULONG_PTR are both
    // 64-bit. Natural Koffi alignment matches the Windows SDK structures.
    const basicLimits = koffi.struct({
      perProcessUserTimeLimit: "uint64_t",
      perJobUserTimeLimit: "uint64_t",
      limitFlags: "uint32_t",
      minimumWorkingSetSize: "uint64_t",
      maximumWorkingSetSize: "uint64_t",
      activeProcessLimit: "uint32_t",
      affinity: "uint64_t",
      priorityClass: "uint32_t",
      schedulingClass: "uint32_t",
    });
    const extendedLimits = koffi.struct({
      basicLimitInformation: basicLimits,
      ioInfo: ioCounters,
      processMemoryLimit: "uint64_t",
      jobMemoryLimit: "uint64_t",
      peakProcessMemoryUsed: "uint64_t",
      peakJobMemoryUsed: "uint64_t",
    });
    const extendedLimitsPointer = koffi.pointer(extendedLimits);

    const api = {
      createJobObjectW: lib.func("__stdcall", "CreateJobObjectW", handle, ["void *", "str16"]),
      setInformationJobObject: lib.func("__stdcall", "SetInformationJobObject", "int32_t", [
        handle,
        "int32_t",
        extendedLimitsPointer,
        "uint32_t",
      ]),
      closeHandle: lib.func("__stdcall", "CloseHandle", "int32_t", [handle]),
    } as Kernel32;

    return {
      api,
      // Koffi copies input objects into a zero-initialized native structure.
      limitInfo: {
        basicLimitInformation: { limitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE },
      },
      limitInfoSize: koffi.sizeof(extendedLimits),
    };
  } catch {
    return null;
  }
}

function loadKernel32() {
  kernel32Load ??= loadKernel32Once();
  return kernel32Load;
}

/** Warm the native surface before the first terminal starts. */
export function preloadChildJobSupport(): Promise<void> {
  return loadKernel32().then(() => undefined);
}

/**
 * Create and configure an empty named job before any launcher or shell exists.
 * The returned handle is the manager's kill switch. When unavailable, callers
 * retain the legacy direct-spawn/taskkill behavior.
 */
export async function createChildJob(): Promise<ChildJobHandle | undefined> {
  const loaded = await loadKernel32();
  if (!loaded) return undefined;
  const { api, limitInfo, limitInfoSize } = loaded;
  const name = `pi-background-terminal-${process.pid}-${randomUUID()}`;
  let job: unknown;
  try {
    job = api.createJobObjectW(null, name);
    if (!job) return undefined;
    if (
      !api.setInformationJobObject(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        limitInfo,
        limitInfoSize,
      )
    ) {
      closeHandle(api, job);
      return undefined;
    }
    let closed = false;
    return {
      name,
      close() {
        if (closed) return;
        closed = true;
        closeHandle(api, job);
      },
    };
  } catch {
    if (job) closeHandle(api, job);
    return undefined;
  }
}
