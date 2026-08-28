/**
 * Per-child Windows Job Objects.
 *
 * On Windows, PID-based tree kills (`taskkill /T`) walk the parent chain:
 * once the shell exits, its descendants are re-parented and unreachable, so a
 * descendant holding the inherited stdio pipes open survives every cleanup we
 * control (libuv's global KILL_ON_JOB_CLOSE job only closes when the whole Pi
 * process dies).
 *
 * Assigning the spawned shell to a dedicated Job Object with
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE closes that gap: job membership is
 * inherited by every descendant, so closing our job handle makes the kernel
 * terminate all surviving tree members — orphaned or not — which also
 * releases the stdio pipes they hold open.
 *
 * The kernel32 surface is loaded lazily through koffi and only on Windows; on
 * any failure (load error, pre-Windows-8 nested-job restriction, child that
 * exited before assignment) callers silently fall back to the legacy
 * PID-based cleanup.
 */

export interface ChildJobHandle {
  /**
   * Close the job handle. Idempotent and synchronous, so it is safe to call
   * from `process.on("exit")`. The kernel terminates any process still in
   * the job.
   */
  close(): void;
}

// winnt.h
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

interface Kernel32 {
  openProcess(desiredAccess: number, inheritHandle: boolean, pid: number): unknown;
  createJobObjectW(jobAttributes: null, name: null): unknown;
  setInformationJobObject(
    job: unknown,
    infoClass: number,
    info: unknown,
    infoLength: number,
  ): boolean;
  assignProcessToJobObject(job: unknown, process: unknown): boolean;
  closeHandle(object: unknown): boolean;
}

/** Cached kernel32 surface. `null` once proven unavailable (non-Windows
 * platform or koffi load failure); callers then use the PID-based fallback. */
let kernel32: Kernel32 | null | undefined;
/** Zero-initialized extended limits with KILL_ON_JOB_CLOSE set; allocated
 * once and reused for every job. Read-only for the API. */
let limitInfo: unknown;
let limitInfoSize = 0;

async function loadKernel32(): Promise<Kernel32 | null> {
  if (kernel32 !== undefined) return kernel32;
  if (process.platform !== "win32") {
    kernel32 = null;
    return kernel32;
  }
  try {
    const koffi = (await import("koffi")).default;
    const lib = koffi.load("kernel32.dll");
    const handle = koffi.pointer("BT_Handle", koffi.opaque());
    const ioCounters = koffi.struct("BT_IoCounters", {
      readOperationCount: "uint64_t",
      writeOperationCount: "uint64_t",
      otherOperationCount: "uint64_t",
      readTransferCount: "uint64_t",
      writeTransferCount: "uint64_t",
      otherTransferCount: "uint64_t",
    });
    // Natural (non-packed) alignment: koffi inserts the same padding the
    // compiler emits for JOBOBJECT_BASIC_LIMIT_INFORMATION on x64/arm64.
    const basicLimits = koffi.struct("BT_JobBasicLimits", {
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
    const extendedLimits = koffi.struct("BT_JobExtendedLimits", {
      basicLimitInformation: basicLimits,
      ioInfo: ioCounters,
      processMemoryLimit: "uint64_t",
      jobMemoryLimit: "uint64_t",
      peakProcessMemoryUsed: "uint64_t",
      peakJobMemoryUsed: "uint64_t",
    });
    // Input structs accept plain objects: koffi copies fields by name and
    // zero-fills the rest (same pattern as koffi's own GetCursorPos example).
    limitInfo = {
      basicLimitInformation: { limitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE },
    };
    limitInfoSize = koffi.sizeof(extendedLimits);

    kernel32 = {
      openProcess: lib.func(
        `${handle} __stdcall OpenProcess(uint32_t dwDesiredAccess, int8_t bInheritHandle, uint32_t dwProcessId)`,
      ),
      createJobObjectW: lib.func(
        `${handle} __stdcall CreateJobObjectW(void *lpJobAttributes, const wchar_t *lpName)`,
      ),
      setInformationJobObject: lib.func(
        `int32_t __stdcall SetInformationJobObject(${handle} hJob, int32_t JobObjectInfoClass, BT_JobExtendedLimits *lpJobObjectInfo, uint32_t cbJobObjectInfoLength)`,
      ),
      assignProcessToJobObject: lib.func(
        `int32_t __stdcall AssignProcessToJobObject(${handle} hJob, ${handle} hProcess)`,
      ),
      closeHandle: lib.func(`int32_t __stdcall CloseHandle(${handle} hObject)`),
    } as Kernel32;
  } catch {
    kernel32 = null;
  }
  return kernel32;
}

/** Warm the kernel32 surface at manager startup so per-terminal assignment
 * runs its (already synchronous) FFI calls in the same tick as the spawn. */
export function preloadChildJobSupport(): Promise<void> {
  return loadKernel32().then(() => undefined);
}

/**
 * Put the freshly spawned child (and, by inheritance, every descendant it is
 * about to create) into a dedicated KILL_ON_JOB_CLOSE job. Resolves
 * `undefined` on any failure or non-Windows platform — cleanup then relies on
 * the legacy PID-based paths exactly as before.
 */
export async function assignChildJob(pid: number): Promise<ChildJobHandle | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const k = await loadKernel32();
  if (!k) return undefined;
  try {
    const child = k.openProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, false, pid);
    if (!child) return undefined;
    try {
      const job = k.createJobObjectW(null, null);
      if (!job) return undefined;
      if (
        !k.setInformationJobObject(
          job,
          JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
          limitInfo,
          limitInfoSize,
        ) ||
        !k.assignProcessToJobObject(job, child)
      ) {
        // An empty job is harmless, but close it to release the handle.
        k.closeHandle(job);
        return undefined;
      }
      let closed = false;
      return {
        close() {
          if (closed) return;
          closed = true;
          try {
            k.closeHandle(job);
          } catch {
            // Handle already invalidated; the tree is gone either way.
          }
        },
      };
    } finally {
      k.closeHandle(child);
    }
  } catch {
    return undefined;
  }
}
