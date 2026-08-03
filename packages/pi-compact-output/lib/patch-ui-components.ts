import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { buildCompactToolLine } from "./compact-tool-line.ts";
import { tryReadToolExecutionInternals } from "./tool-internals.ts";

const PATCH_SYMBOL = Symbol.for("pi-tian-compact-output.patch-state");

type ToolRender = (this: ToolExecutionComponent, width: number) => string[];
type ToolSetExpanded = (this: ToolExecutionComponent, expanded: boolean) => void;
type AssistantUpdateContent = (this: AssistantMessageComponent, message: AssistantMessage) => void;

interface PatchState {
  refCount: number;
  expandedStates: WeakMap<ToolExecutionComponent, boolean>;
  installed: boolean;
  unsupportedReason?: string;
  originalToolRender?: ToolRender;
  originalToolSetExpanded?: ToolSetExpanded;
  originalAssistantUpdateContent?: AssistantUpdateContent;
  toolRenderWrapper?: ToolRender;
  toolSetExpandedWrapper?: ToolSetExpanded;
  assistantUpdateContentWrapper?: AssistantUpdateContent;
}

export interface PatchInstallResult {
  installed: boolean;
  reason?: string;
}

function getPatchState(): PatchState | undefined {
  return (globalThis as Record<symbol, PatchState | undefined>)[PATCH_SYMBOL];
}

function setPatchState(state: PatchState | undefined): void {
  (globalThis as Record<symbol, PatchState | undefined>)[PATCH_SYMBOL] = state;
}

export function isSupportedPiVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) return false;
  return Number(match[1]) === 0 && Number(match[2]) === 83;
}

function createPatchState(): PatchState {
  return {
    refCount: 0,
    expandedStates: new WeakMap(),
    installed: false,
  };
}

function hasPatchablePrototypeMethods(): boolean {
  return (
    typeof ToolExecutionComponent.prototype.render === "function" &&
    typeof ToolExecutionComponent.prototype.setExpanded === "function" &&
    typeof AssistantMessageComponent.prototype.updateContent === "function"
  );
}

export function installUiPatches(): PatchInstallResult {
  let state = getPatchState();
  if (state) {
    state.refCount++;
    return { installed: state.installed, reason: state.unsupportedReason };
  }

  state = createPatchState();
  state.refCount = 1;

  if (!isSupportedPiVersion(VERSION)) {
    state.unsupportedReason = `pi-tian-compact-output requires Pi 0.83.x (found ${VERSION})`;
    setPatchState(state);
    return { installed: false, reason: state.unsupportedReason };
  }

  if (!hasPatchablePrototypeMethods()) {
    state.unsupportedReason = "pi-tian-compact-output: required TUI prototype methods are missing";
    setPatchState(state);
    return { installed: false, reason: state.unsupportedReason };
  }

  const originalToolRender = ToolExecutionComponent.prototype.render as ToolRender;
  const originalToolSetExpanded = ToolExecutionComponent.prototype.setExpanded as ToolSetExpanded;
  const originalAssistantUpdateContent =
    AssistantMessageComponent.prototype.updateContent as AssistantUpdateContent;

  const toolSetExpandedWrapper: ToolSetExpanded = function toolSetExpandedWrapper(
    this: ToolExecutionComponent,
    expanded: boolean,
  ) {
    const current = getPatchState();
    current?.expandedStates.set(this, expanded);
    originalToolSetExpanded.call(this, expanded);
  };

  const toolRenderWrapper: ToolRender = function toolRenderWrapper(this: ToolExecutionComponent, width: number) {
    const current = getPatchState();
    if (!current?.installed) {
      return originalToolRender.call(this, width);
    }

    const expanded = current.expandedStates.get(this) ?? false;
    if (expanded) {
      return originalToolRender.call(this, width);
    }

    try {
      const internals = tryReadToolExecutionInternals(this);
      if (!internals) {
        return originalToolRender.call(this, width);
      }
      return buildCompactToolLine(internals, width);
    } catch {
      return originalToolRender.call(this, width);
    }
  };

  const assistantUpdateContentWrapper: AssistantUpdateContent = function assistantUpdateContentWrapper(
    this: AssistantMessageComponent,
    message: AssistantMessage,
  ) {
    const current = getPatchState();
    if (!current?.installed) {
      originalAssistantUpdateContent.call(this, message);
      return;
    }

    try {
      if (Array.isArray(message.content) && message.content.some((part) => part.type === "thinking")) {
        const displayMessage = {
          ...message,
          content: message.content.filter((part) => part.type !== "thinking"),
        };
        originalAssistantUpdateContent.call(this, displayMessage);
        return;
      }
      originalAssistantUpdateContent.call(this, message);
    } catch {
      originalAssistantUpdateContent.call(this, message);
    }
  };

  ToolExecutionComponent.prototype.setExpanded = toolSetExpandedWrapper;
  ToolExecutionComponent.prototype.render = toolRenderWrapper;
  AssistantMessageComponent.prototype.updateContent = assistantUpdateContentWrapper;

  state.originalToolRender = originalToolRender;
  state.originalToolSetExpanded = originalToolSetExpanded;
  state.originalAssistantUpdateContent = originalAssistantUpdateContent;
  state.toolRenderWrapper = toolRenderWrapper;
  state.toolSetExpandedWrapper = toolSetExpandedWrapper;
  state.assistantUpdateContentWrapper = assistantUpdateContentWrapper;
  state.installed = true;
  setPatchState(state);
  return { installed: true };
}

export function releaseUiPatches(): void {
  const state = getPatchState();
  if (!state) return;

  state.refCount--;
  if (state.refCount > 0) return;

  if (state.installed) {
    if (
      state.toolRenderWrapper &&
      ToolExecutionComponent.prototype.render === state.toolRenderWrapper &&
      state.originalToolRender
    ) {
      ToolExecutionComponent.prototype.render = state.originalToolRender;
    }
    if (
      state.toolSetExpandedWrapper &&
      ToolExecutionComponent.prototype.setExpanded === state.toolSetExpandedWrapper &&
      state.originalToolSetExpanded
    ) {
      ToolExecutionComponent.prototype.setExpanded = state.originalToolSetExpanded;
    }
    if (
      state.assistantUpdateContentWrapper &&
      AssistantMessageComponent.prototype.updateContent === state.assistantUpdateContentWrapper &&
      state.originalAssistantUpdateContent
    ) {
      AssistantMessageComponent.prototype.updateContent = state.originalAssistantUpdateContent;
    }
  }

  setPatchState(undefined);
}

export function getPatchDiagnostics(): PatchInstallResult {
  const state = getPatchState();
  if (!state) {
    return { installed: false };
  }
  return { installed: state.installed, reason: state.unsupportedReason };
}

// Test-only helpers.
export function __getPatchStateForTests(): PatchState | undefined {
  return getPatchState();
}

export function __resetPatchStateForTests(): void {
  const state = getPatchState();
  if (!state?.installed) {
    setPatchState(undefined);
    return;
  }
  if (
    state.toolRenderWrapper &&
    ToolExecutionComponent.prototype.render === state.toolRenderWrapper &&
    state.originalToolRender
  ) {
    ToolExecutionComponent.prototype.render = state.originalToolRender;
  }
  if (
    state.toolSetExpandedWrapper &&
    ToolExecutionComponent.prototype.setExpanded === state.toolSetExpandedWrapper &&
    state.originalToolSetExpanded
  ) {
    ToolExecutionComponent.prototype.setExpanded = state.originalToolSetExpanded;
  }
  if (
    state.assistantUpdateContentWrapper &&
    AssistantMessageComponent.prototype.updateContent === state.assistantUpdateContentWrapper &&
    state.originalAssistantUpdateContent
  ) {
    AssistantMessageComponent.prototype.updateContent = state.originalAssistantUpdateContent;
  }
  setPatchState(undefined);
}
