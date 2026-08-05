import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import type { Component, Container } from "@earendil-works/pi-tui";
import { buildCompactToolGroup } from "./compact-tool-group.ts";
import { firstSanitizedLine, sanitizeCompactText } from "./sanitize-text.ts";
import { tryReadToolExecutionInternals } from "./tool-internals.ts";

const PATCH_SYMBOL = Symbol.for("pi-tian-compact-output.patch-state");

type ToolRender = (this: ToolExecutionComponent, width: number) => string[];
type ToolSetExpanded = (this: ToolExecutionComponent, expanded: boolean) => void;
type AssistantUpdateContent = (this: AssistantMessageComponent, message: AssistantMessage) => void;
type AssistantSetExpanded = (this: AssistantMessageComponent, expanded: boolean) => void;
type ContainerAddChild = (this: Container, component: Component) => void;

type AssistantPrototype = typeof AssistantMessageComponent.prototype & {
  setExpanded?: AssistantSetExpanded;
};

interface ToolRecord {
  component: ToolExecutionComponent;
  sequence: number;
  order: number;
  parent?: Container;
}

interface PatchState {
  refCount: number;
  expandedStates: WeakMap<ToolExecutionComponent, boolean>;
  assistantExpandedStates: WeakMap<AssistantMessageComponent, boolean>;
  assistantMessages: WeakMap<AssistantMessageComponent, AssistantMessage>;
  assistantDisplayMessages: WeakMap<AssistantMessage, AssistantMessage>;
  reasoningExpanded: boolean;
  toolRecords: ToolRecord[];
  nextToolOrder: number;
  toolSequence: number;
  toolSequenceOpen: boolean;
  installed: boolean;
  unsupportedReason?: string;
  originalContainerAddChild?: ContainerAddChild;
  originalToolRender?: ToolRender;
  originalToolSetExpanded?: ToolSetExpanded;
  originalAssistantUpdateContent?: AssistantUpdateContent;
  originalAssistantSetExpanded?: AssistantSetExpanded;
  containerAddChildWrapper?: ContainerAddChild;
  toolRenderWrapper?: ToolRender;
  toolSetExpandedWrapper?: ToolSetExpanded;
  assistantUpdateContentWrapper?: AssistantUpdateContent;
  assistantSetExpandedWrapper?: AssistantSetExpanded;
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
    assistantExpandedStates: new WeakMap(),
    assistantMessages: new WeakMap(),
    assistantDisplayMessages: new WeakMap(),
    reasoningExpanded: false,
    toolRecords: [],
    nextToolOrder: 0,
    toolSequence: 0,
    toolSequenceOpen: false,
    installed: false,
  };
}

function getToolContainerPrototype(): { addChild: ContainerAddChild } {
  return Object.getPrototypeOf(ToolExecutionComponent.prototype) as { addChild: ContainerAddChild };
}

function hasPatchablePrototypeMethods(): boolean {
  const containerPrototype = getToolContainerPrototype();
  return (
    typeof containerPrototype.addChild === "function" &&
    typeof ToolExecutionComponent.prototype.render === "function" &&
    typeof ToolExecutionComponent.prototype.setExpanded === "function" &&
    typeof AssistantMessageComponent.prototype.updateContent === "function"
  );
}

function hasNonEmptyAssistantText(message: AssistantMessage): boolean {
  return message.content.some(
    (part) => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
  );
}

function hasAssistantToolCall(message: AssistantMessage): boolean {
  return message.content.some((part) => part.type === "toolCall");
}

function noteAssistantMessage(state: PatchState, message: AssistantMessage): void {
  if (hasAssistantToolCall(message)) {
    if (!state.toolSequenceOpen) {
      state.toolSequence++;
      state.toolSequenceOpen = true;
    }
    return;
  }

  if (hasNonEmptyAssistantText(message)) {
    state.toolSequence++;
    state.toolSequenceOpen = false;
  }
}

export function compactThinkingSummary(message: AssistantMessage): string | undefined {
  const lines: string[] = [];
  for (const part of message.content) {
    if (part.type !== "thinking") continue;
    const line = firstSanitizedLine(part.thinking);
    if (line) lines.push(line);
  }
  if (lines.length === 0) return undefined;
  return sanitizeCompactText(lines.join(" · "));
}

export function formatThinkingWorkingMessage(message: AssistantMessage): string {
  const summary = compactThinkingSummary(message);
  return summary ? `Thinking: ${summary}` : "Thinking";
}

function compactAssistantMessage(message: AssistantMessage): AssistantMessage {
  if (!message.content.some((part) => part.type === "thinking")) {
    return message;
  }

  const summary = compactThinkingSummary(message);
  const content: AssistantMessage["content"] = [];
  let insertedThinking = false;

  for (const part of message.content) {
    if (part.type !== "thinking") {
      content.push(part);
      continue;
    }
    if (!insertedThinking && summary) {
      content.push({ ...part, thinking: summary });
      insertedThinking = true;
    }
  }

  return { ...message, content };
}

function withAssistantThinkingVisible<T>(
  component: AssistantMessageComponent,
  render: () => T,
): T {
  const internals = component as unknown as { hideThinkingBlock?: unknown };
  if (typeof internals.hideThinkingBlock !== "boolean") {
    return render();
  }

  const wasHidden = internals.hideThinkingBlock;
  internals.hideThinkingBlock = false;
  try {
    return render();
  } finally {
    internals.hideThinkingBlock = wasHidden;
  }
}

function findToolRecord(state: PatchState, component: ToolExecutionComponent): ToolRecord | undefined {
  return state.toolRecords.find((record) => record.component === component);
}

function ensureToolRecord(state: PatchState, component: ToolExecutionComponent): ToolRecord {
  const existing = findToolRecord(state, component);
  if (existing) return existing;

  if (!state.toolSequenceOpen) {
    state.toolSequence++;
    state.toolSequenceOpen = true;
  }

  const record: ToolRecord = {
    component,
    sequence: state.toolSequence,
    order: state.nextToolOrder++,
  };
  state.toolRecords.push(record);
  return record;
}

function isMounted(record: ToolRecord): boolean {
  return record.parent ? record.parent.children.includes(record.component) : true;
}

function getToolGroup(state: PatchState, record: ToolRecord): ToolRecord[] {
  return state.toolRecords
    .filter((candidate) => {
      if (candidate.sequence !== record.sequence || !isMounted(candidate)) return false;
      if (record.parent) return candidate.parent === record.parent;
      return !candidate.parent;
    })
    .sort((a, b) => a.order - b.order);
}

function buildToolGroup(state: PatchState, record: ToolRecord, width: number): string[] {
  const items = getToolGroup(state, record)
    .flatMap((candidate) => {
      const internals = tryReadToolExecutionInternals(candidate.component);
      if (!internals || internals.hideComponent) return [];
      return [{ internals }];
    });
  return buildCompactToolGroup(items, width);
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

  const containerPrototype = getToolContainerPrototype();
  const originalContainerAddChild = containerPrototype.addChild;
  const originalToolRender = ToolExecutionComponent.prototype.render as ToolRender;
  const originalToolSetExpanded = ToolExecutionComponent.prototype.setExpanded as ToolSetExpanded;
  const originalAssistantUpdateContent =
    AssistantMessageComponent.prototype.updateContent as AssistantUpdateContent;
  const assistantPrototype = AssistantMessageComponent.prototype as AssistantPrototype;
  const originalAssistantSetExpanded = assistantPrototype.setExpanded;

  const containerAddChildWrapper: ContainerAddChild = function containerAddChildWrapper(
    this: Container,
    component: Component,
  ) {
    originalContainerAddChild.call(this, component);
    const current = getPatchState();
    if (current?.installed && component instanceof ToolExecutionComponent) {
      const record = ensureToolRecord(current, component);
      record.parent = this;
    }
  };

  const toolSetExpandedWrapper: ToolSetExpanded = function toolSetExpandedWrapper(
    this: ToolExecutionComponent,
    expanded: boolean,
  ) {
    const current = getPatchState();
    if (current?.installed) {
      current.expandedStates.set(this, expanded);
      current.reasoningExpanded = expanded;
      ensureToolRecord(current, this);
    }
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
      if (internals.hideComponent) {
        return [];
      }

      const record = ensureToolRecord(current, this);
      const group = getToolGroup(current, record);
      if (group.at(-1)?.component !== this) {
        return [];
      }
      return buildToolGroup(current, record, width);
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
      const sourceMessage = current.assistantDisplayMessages.get(message) ?? message;
      noteAssistantMessage(current, sourceMessage);
      current.assistantMessages.set(this, sourceMessage);
      const expanded = current.assistantExpandedStates.get(this) ?? current.reasoningExpanded;
      const displayMessage = expanded ? sourceMessage : compactAssistantMessage(sourceMessage);
      if (displayMessage !== sourceMessage) {
        current.assistantDisplayMessages.set(displayMessage, sourceMessage);
      }
      withAssistantThinkingVisible(this, () => originalAssistantUpdateContent.call(this, displayMessage));
    } catch {
      originalAssistantUpdateContent.call(this, message);
    }
  };

  const assistantSetExpandedWrapper: AssistantSetExpanded = function assistantSetExpandedWrapper(
    this: AssistantMessageComponent,
    expanded: boolean,
  ) {
    const current = getPatchState();
    if (current?.installed) {
      current.reasoningExpanded = expanded;
      current.assistantExpandedStates.set(this, expanded);
      const message = current.assistantMessages.get(this);
      if (message) {
        try {
          const displayMessage = expanded ? message : compactAssistantMessage(message);
          if (displayMessage !== message) {
            current.assistantDisplayMessages.set(displayMessage, message);
          }
          withAssistantThinkingVisible(this, () => originalAssistantUpdateContent.call(this, displayMessage));
        } catch {
          originalAssistantUpdateContent.call(this, message);
        }
      }
    }
    originalAssistantSetExpanded?.call(this, expanded);
  };

  containerPrototype.addChild = containerAddChildWrapper;
  ToolExecutionComponent.prototype.setExpanded = toolSetExpandedWrapper;
  ToolExecutionComponent.prototype.render = toolRenderWrapper;
  AssistantMessageComponent.prototype.updateContent = assistantUpdateContentWrapper;
  assistantPrototype.setExpanded = assistantSetExpandedWrapper;

  state.originalContainerAddChild = originalContainerAddChild;
  state.originalToolRender = originalToolRender;
  state.originalToolSetExpanded = originalToolSetExpanded;
  state.originalAssistantUpdateContent = originalAssistantUpdateContent;
  state.originalAssistantSetExpanded = originalAssistantSetExpanded;
  state.containerAddChildWrapper = containerAddChildWrapper;
  state.toolRenderWrapper = toolRenderWrapper;
  state.toolSetExpandedWrapper = toolSetExpandedWrapper;
  state.assistantUpdateContentWrapper = assistantUpdateContentWrapper;
  state.assistantSetExpandedWrapper = assistantSetExpandedWrapper;
  state.installed = true;
  setPatchState(state);
  return { installed: true };
}

function restorePatchedMethods(state: PatchState): void {
  if (
    state.containerAddChildWrapper &&
    getToolContainerPrototype().addChild === state.containerAddChildWrapper &&
    state.originalContainerAddChild
  ) {
    getToolContainerPrototype().addChild = state.originalContainerAddChild;
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
  const assistantPrototype = AssistantMessageComponent.prototype as AssistantPrototype;
  if (
    state.assistantSetExpandedWrapper &&
    assistantPrototype.setExpanded === state.assistantSetExpandedWrapper
  ) {
    if (state.originalAssistantSetExpanded) {
      assistantPrototype.setExpanded = state.originalAssistantSetExpanded;
    } else {
      delete assistantPrototype.setExpanded;
    }
  }
}

export function releaseUiPatches(): void {
  const state = getPatchState();
  if (!state) return;

  state.refCount--;
  if (state.refCount > 0) return;

  if (state.installed) {
    restorePatchedMethods(state);
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
  restorePatchedMethods(state);
  setPatchState(undefined);
}
