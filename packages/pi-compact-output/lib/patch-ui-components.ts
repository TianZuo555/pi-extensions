import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import type { Component, Container } from "@earendil-works/pi-tui";
import {
  buildCompactReasoningPreview,
  CompactReasoningComponent,
  normalizeReasoningText,
  type CompactReasoningPreview,
} from "./compact-reasoning.ts";
import { buildCompactToolGroup } from "./compact-tool-group.ts";
import { getThinkingSegmentText, parseAssistantContentSegments } from "./content-segments.ts";
import { firstSanitizedLines } from "./sanitize-text.ts";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "./compact-status.ts";
import { tryReadToolExecutionInternals } from "./tool-internals.ts";

const PATCH_SYMBOL = Symbol.for("pi-compact-output.patch-state");

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
  toolCallId?: string;
  sequence: number;
  order: number;
  parent?: Container;
  assistant?: AssistantMessageComponent;
  /** True when a later component re-created the same toolCallId (pi re-creates
   * components for finished tools on every message_update). Ghosts never
   * execute, never group, and render nothing; the first record wins. */
  duplicate: boolean;
}

interface AssistantTurnState {
  assistant: AssistantMessageComponent;
  parent?: Container;
  lastMessage?: AssistantMessage;
  reasoningComponents: Map<number, CompactReasoningComponent>;
  reasoningPreviews: Map<number, CompactReasoningPreview>;
  /** Index of each tools segment (among tools segments, per message) mapped to
   * its global sequence. Stable across stream chunks, unique across turns. */
  toolRunSequences: Map<number, number>;
}

const COMPACT_REASON_LINE_COUNT = 3;

export interface CompactReasonState {
  segmentIndex: number;
  summary?: string;
}

interface PatchState {
  refCount: number;
  expandedStates: WeakMap<ToolExecutionComponent, boolean>;
  assistantExpandedStates: WeakMap<AssistantMessageComponent, boolean>;
  assistantMessages: WeakMap<AssistantMessageComponent, AssistantMessage>;
  assistantDisplayMessages: WeakMap<AssistantMessage, AssistantMessage>;
  reasoningExpanded: boolean;
  assistantReasonStates: WeakMap<AssistantMessageComponent, CompactReasonState>;
  assistantTurns: WeakMap<AssistantMessageComponent, AssistantTurnState>;
  lastUpdatedAssistant?: AssistantMessageComponent;
  reorderingTurn: boolean;
  toolRecords: ToolRecord[];
  nextToolOrder: number;
  toolSequence: number;
  installed: boolean;
  reasoningStreaming: boolean;
  reasoningComponents: CompactReasoningComponent[];
  toolSpinnerFrame: number;
  toolSpinnerInterval?: ReturnType<typeof setInterval>;
  toolLineCount: number;
  reasoningLineCount: number;
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
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 0 && (minor === 83 || minor === 84);
}

function createPatchState(): PatchState {
  return {
    refCount: 0,
    expandedStates: new WeakMap(),
    assistantExpandedStates: new WeakMap(),
    assistantMessages: new WeakMap(),
    assistantDisplayMessages: new WeakMap(),
    reasoningExpanded: false,
    assistantReasonStates: new WeakMap(),
    assistantTurns: new WeakMap(),
    reorderingTurn: false,
    toolRecords: [],
    nextToolOrder: 0,
    toolSequence: 0,
    installed: false,
    reasoningStreaming: false,
    reasoningComponents: [],
    toolSpinnerFrame: 0,
    toolLineCount: 3,
    reasoningLineCount: 5,
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

function getThinkingSegments(message: AssistantMessage): string[] {
  const segments: string[] = [];
  for (const part of message.content) {
    if (part.type !== "thinking") continue;
    const thinking = part.thinking.trim();
    if (thinking) segments.push(thinking);
  }
  return segments;
}

export function compactThinkingSummary(
  message: AssistantMessage,
  previous?: CompactReasonState,
): { summary?: string; state: CompactReasonState } {
  const segments = getThinkingSegments(message);
  if (segments.length === 0) {
    return { summary: undefined, state: { segmentIndex: -1 } };
  }

  const segmentIndex = segments.length - 1;

  if (previous?.summary !== undefined && segmentIndex === previous.segmentIndex) {
    return { summary: previous.summary, state: previous };
  }

  const latest = normalizeReasoningText(segments[segmentIndex] ?? "");
  if (
    segmentIndex > (previous?.segmentIndex ?? -1) &&
    firstSanitizedLines(latest, 1).length === 0
  ) {
    return {
      summary: previous?.summary,
      state: previous ?? { segmentIndex: -1 },
    };
  }

  const lines = firstSanitizedLines(latest, COMPACT_REASON_LINE_COUNT);
  if (lines.length === 0) {
    return {
      summary: previous?.summary,
      state: previous ?? { segmentIndex: -1 },
    };
  }

  const summary = lines.join("\n");
  return { summary, state: { segmentIndex, summary } };
}

export function formatThinkingWorkingMessage(
  message: AssistantMessage,
  previous?: CompactReasonState,
): { message: string; state: CompactReasonState } {
  const { summary, state } = compactThinkingSummary(message, previous);
  if (!summary) {
    return { message: "Thinking", state };
  }
  const oneLine = summary.replace(/\s*\n\s*/g, " · ");
  return { message: `Thinking: ${oneLine}`, state };
}

function isCommentaryText(part: TextContent): boolean {
  const signature = part.textSignature;
  if (!signature?.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(signature) as { v?: number; phase?: string };
    return parsed.v === 1 && parsed.phase === "commentary";
  } catch {
    return false;
  }
}

function compactAssistantMessage(message: AssistantMessage): AssistantMessage {
  const hasThinking = message.content.some((part) => part.type === "thinking");
  const hasCommentary = message.content.some(
    (part) => part.type === "text" && isCommentaryText(part),
  );
  if (!hasThinking && !hasCommentary) {
    return message;
  }

  const content = message.content.filter((part) => {
    if (part.type === "thinking") return false;
    if (part.type === "text" && isCommentaryText(part)) return false;
    return true;
  });

  return { ...message, content };
}

function withAssistantThinkingHidden<T>(component: AssistantMessageComponent, render: () => T): T {
  const internals = component as unknown as { hideThinkingBlock?: unknown };
  if (typeof internals.hideThinkingBlock !== "boolean") {
    return render();
  }

  const wasHidden = internals.hideThinkingBlock;
  internals.hideThinkingBlock = true;
  try {
    return render();
  } finally {
    internals.hideThinkingBlock = wasHidden;
  }
}

function readToolCallId(component: ToolExecutionComponent): string | undefined {
  const value = (component as unknown as { toolCallId?: unknown }).toolCallId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function findToolRecordByCallId(state: PatchState, toolCallId: string): ToolRecord | undefined {
  return state.toolRecords.find((record) => record.toolCallId === toolCallId && !record.duplicate);
}

function findToolComponent(
  state: PatchState,
  toolCallId: string,
): ToolExecutionComponent | undefined {
  return findToolRecordByCallId(state, toolCallId)?.component;
}

function getAssistantTurn(
  state: PatchState,
  assistant: AssistantMessageComponent,
): AssistantTurnState {
  const existing = state.assistantTurns.get(assistant);
  if (existing) return existing;
  const turn: AssistantTurnState = {
    assistant,
    reasoningComponents: new Map(),
    reasoningPreviews: new Map(),
    toolRunSequences: new Map(),
  };
  state.assistantTurns.set(assistant, turn);
  return turn;
}

function assignToolSequences(
  state: PatchState,
  turn: AssistantTurnState,
  message: AssistantMessage,
): void {
  const segments = parseAssistantContentSegments(message.content);
  let runIndex = 0;
  for (const segment of segments) {
    if (segment.kind !== "tools") continue;
    let sequence = turn.toolRunSequences.get(runIndex);
    if (sequence === undefined) {
      state.toolSequence++;
      sequence = state.toolSequence;
      turn.toolRunSequences.set(runIndex, sequence);
    }
    for (const toolCallId of segment.toolCallIds) {
      const record = findToolRecordByCallId(state, toolCallId);
      if (record) {
        record.sequence = sequence;
      }
    }
    runIndex++;
  }
}

function captureRequestRender(state: PatchState): (() => void) | undefined {
  for (const record of state.toolRecords) {
    const ui = (
      record.component as unknown as {
        ui?: { requestRender?: unknown };
      }
    ).ui;
    if (ui && typeof ui.requestRender === "function") {
      const requestRender = ui.requestRender as () => void;
      return () => requestRender.call(ui);
    }
  }
  return undefined;
}

/** Drive the compact tool status spinner while the agent is working. */
function setToolSpinnerStreaming(state: PatchState, streaming: boolean): void {
  if (!streaming) {
    if (state.toolSpinnerInterval) {
      clearInterval(state.toolSpinnerInterval);
      state.toolSpinnerInterval = undefined;
    }
    return;
  }

  if (state.toolSpinnerInterval) return;
  state.toolSpinnerInterval = setInterval(() => {
    state.toolSpinnerFrame = (state.toolSpinnerFrame + 1) % SPINNER_FRAMES.length;
    captureRequestRender(state)?.();
  }, SPINNER_INTERVAL_MS);
}

/** Set the reasoning blocks' streaming state (drives the loading sign). */
export function setReasoningStreaming(streaming: boolean): void {
  const state = getPatchState();
  if (!state?.installed) return;
  state.reasoningStreaming = streaming;
  setToolSpinnerStreaming(state, streaming);
  const requestRender = captureRequestRender(state);
  for (const component of state.reasoningComponents) {
    component.setStreaming(streaming, requestRender);
  }
}

function clampLineCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(12, Math.max(1, Math.floor(value)));
}

/** Configure the maximum collapsed lines for tool and reasoning blocks. */
export function setCompactOutputLimits(toolLines: number, reasoningLines: number): void {
  const state = getPatchState();
  if (!state) return;
  state.toolLineCount = clampLineCount(toolLines);
  state.reasoningLineCount = clampLineCount(reasoningLines);
}

function endsWithThinkingContent(message: AssistantMessage): boolean {
  for (let index = message.content.length - 1; index >= 0; index--) {
    const part = message.content[index];
    if (!part) continue;
    if (part.type === "thinking") {
      if (part.thinking.trim()) return true;
      continue;
    }
    if (part.type === "text" && (!part.text.trim() || isCommentaryText(part))) {
      continue;
    }
    return false;
  }
  return false;
}

function syncReasoningComponents(
  state: PatchState,
  turn: AssistantTurnState,
  message: AssistantMessage,
  expanded: boolean,
): void {
  const segments = parseAssistantContentSegments(message.content);
  const latestThinkingSegment = [...segments]
    .reverse()
    .find((segment) => segment.kind === "thinking");
  const thinkingIsActive = state.reasoningStreaming && endsWithThinkingContent(message);
  const activeSegments = new Set<number>();

  for (const segment of segments) {
    if (segment.kind !== "thinking") continue;
    activeSegments.add(segment.segmentIndex);

    const thinking = getThinkingSegmentText(message.content, segment.segmentIndex);
    if (!thinking) continue;

    const previous = turn.reasoningPreviews.get(segment.segmentIndex);
    const preview = expanded
      ? undefined
      : buildCompactReasoningPreview(
          thinking,
          segment.segmentIndex,
          previous,
          state.reasoningLineCount,
        );
    if (preview) {
      turn.reasoningPreviews.set(segment.segmentIndex, preview);
    }

    let component = turn.reasoningComponents.get(segment.segmentIndex);
    if (!component) {
      component = new CompactReasoningComponent();
      turn.reasoningComponents.set(segment.segmentIndex, component);
      state.reasoningComponents.push(component);
      const parent = turn.parent;
      if (parent) {
        parent.addChild(component);
      }
    }
    const isActive =
      thinkingIsActive && latestThinkingSegment?.segmentIndex === segment.segmentIndex;
    component.setStreaming(isActive, captureRequestRender(state));
    component.updateContent(thinking, preview, expanded, state.reasoningLineCount);
  }

  for (const [segmentIndex, component] of turn.reasoningComponents.entries()) {
    if (activeSegments.has(segmentIndex)) continue;
    component.updateContent(undefined, undefined, false);
    turn.reasoningPreviews.delete(segmentIndex);
  }
}

function buildTurnComponentOrder(state: PatchState, turn: AssistantTurnState): Component[] {
  if (!turn.lastMessage) return [];

  const ordered: Component[] = [];
  const segments = parseAssistantContentSegments(turn.lastMessage.content);

  for (const segment of segments) {
    if (segment.kind === "thinking") {
      const component = turn.reasoningComponents.get(segment.segmentIndex);
      if (component) ordered.push(component);
      continue;
    }
    for (const toolCallId of segment.toolCallIds) {
      const component = findToolComponent(state, toolCallId);
      if (component) ordered.push(component);
    }
  }

  ordered.push(turn.assistant);
  return ordered.filter((component) => {
    const parent = turn.parent;
    return parent ? parent.children.includes(component) : true;
  });
}

function reorderTurnComponents(parent: Container, ordered: readonly Component[]): void {
  if (ordered.length === 0) return;

  const _orderedSet = new Set(ordered);
  const indices = ordered
    .map((component) => parent.children.indexOf(component))
    .filter((index) => index >= 0);
  if (indices.length === 0) return;

  const _minIndex = Math.min(...indices);
  const maxIndex = Math.max(...indices);
  const tail = parent.children.slice(maxIndex + 1);

  for (const component of ordered) {
    parent.removeChild(component);
  }
  for (const component of tail) {
    parent.removeChild(component);
  }
  for (const component of ordered) {
    parent.addChild(component);
  }
  for (const component of tail) {
    parent.addChild(component);
  }
}

function tryReorderAssistantTurn(state: PatchState, assistant: AssistantMessageComponent): void {
  if (state.reorderingTurn) return;

  const turn = state.assistantTurns.get(assistant);
  if (!turn?.lastMessage) return;

  const expanded = state.assistantExpandedStates.get(assistant) ?? state.reasoningExpanded;
  if (expanded) return;

  assignToolSequences(state, turn, turn.lastMessage);

  const parent = turn.parent;
  if (!parent) return;

  turn.parent = parent;
  const ordered = buildTurnComponentOrder(state, turn);
  if (ordered.length === 0) return;

  state.reorderingTurn = true;
  try {
    reorderTurnComponents(parent, ordered);
  } finally {
    state.reorderingTurn = false;
  }
}

function findToolRecord(
  state: PatchState,
  component: ToolExecutionComponent,
): ToolRecord | undefined {
  return state.toolRecords.find((record) => record.component === component);
}

function ensureToolRecord(
  state: PatchState,
  component: ToolExecutionComponent,
  assistant?: AssistantMessageComponent,
): ToolRecord {
  const existing = findToolRecord(state, component);
  if (existing) {
    if (assistant) existing.assistant = assistant;
    const toolCallId = readToolCallId(component);
    if (toolCallId) existing.toolCallId = toolCallId;
    return existing;
  }

  const record: ToolRecord = {
    component,
    toolCallId: readToolCallId(component),
    sequence: 0,
    order: state.nextToolOrder++,
    assistant,
    duplicate: false,
  };
  const callId = record.toolCallId;
  record.duplicate =
    callId !== undefined &&
    state.toolRecords.some(
      (other) =>
        other !== record && other.toolCallId === callId && !other.duplicate && isMounted(other),
    );
  state.toolRecords.push(record);
  return record;
}

function isMounted(record: ToolRecord): boolean {
  return record.parent ? record.parent.children.includes(record.component) : true;
}

function getToolGroup(state: PatchState, record: ToolRecord): ToolRecord[] {
  return state.toolRecords
    .filter((candidate) => {
      if (candidate.duplicate || candidate.sequence !== record.sequence || !isMounted(candidate)) {
        return false;
      }
      if (record.parent) return candidate.parent === record.parent;
      return !candidate.parent;
    })
    .sort((a, b) => a.order - b.order);
}

function buildToolGroup(state: PatchState, record: ToolRecord, width: number): string[] {
  const items = getToolGroup(state, record).flatMap((candidate) => {
    const internals = tryReadToolExecutionInternals(candidate.component);
    if (!internals || internals.hideComponent) return [];
    return [{ internals }];
  });
  return buildCompactToolGroup(items, width, state.toolLineCount, state.toolSpinnerFrame);
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
    state.unsupportedReason = `pi-compact-output requires Pi 0.83.x or 0.84.x (found ${VERSION})`;
    setPatchState(state);
    return { installed: false, reason: state.unsupportedReason };
  }

  if (!hasPatchablePrototypeMethods()) {
    state.unsupportedReason = "pi-compact-output: required TUI prototype methods are missing";
    setPatchState(state);
    return { installed: false, reason: state.unsupportedReason };
  }

  const containerPrototype = getToolContainerPrototype();
  const originalContainerAddChild = containerPrototype.addChild;
  const originalToolRender = ToolExecutionComponent.prototype.render as ToolRender;
  const originalToolSetExpanded = ToolExecutionComponent.prototype.setExpanded as ToolSetExpanded;
  const originalAssistantUpdateContent = AssistantMessageComponent.prototype
    .updateContent as AssistantUpdateContent;
  const assistantPrototype = AssistantMessageComponent.prototype as AssistantPrototype;
  const originalAssistantSetExpanded = assistantPrototype.setExpanded;

  const containerAddChildWrapper: ContainerAddChild = function containerAddChildWrapper(
    this: Container,
    component: Component,
  ) {
    originalContainerAddChild.call(this, component);
    const current = getPatchState();
    if (!current?.installed) return;

    if (component instanceof AssistantMessageComponent) {
      const turn = getAssistantTurn(current, component);
      turn.parent = this;

      // Pi constructs restored assistant components with their message before
      // adding them to the chat container. In that path updateContent() has
      // already created the compact reasoning children while the turn had no
      // parent, so mount them now that the assistant is attached.
      for (const reasoning of turn.reasoningComponents.values()) {
        if (!this.children.includes(reasoning)) {
          originalContainerAddChild.call(this, reasoning);
        }
      }
      tryReorderAssistantTurn(current, component);
      return;
    }

    if (component instanceof ToolExecutionComponent) {
      const record = ensureToolRecord(current, component, current.lastUpdatedAssistant);
      record.parent = this;
      if (current.lastUpdatedAssistant) {
        const turn = getAssistantTurn(current, current.lastUpdatedAssistant);
        turn.parent = this;
        tryReorderAssistantTurn(current, current.lastUpdatedAssistant);
      }
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

  const toolRenderWrapper: ToolRender = function toolRenderWrapper(
    this: ToolExecutionComponent,
    width: number,
  ) {
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
      if (record.duplicate) {
        return [];
      }
      const group = getToolGroup(current, record);
      if (group.at(-1)?.component !== this) {
        return [];
      }
      return buildToolGroup(current, record, width);
    } catch {
      return originalToolRender.call(this, width);
    }
  };

  const assistantUpdateContentWrapper: AssistantUpdateContent =
    function assistantUpdateContentWrapper(
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
        current.lastUpdatedAssistant = this;
        current.assistantMessages.set(this, sourceMessage);

        const turn = getAssistantTurn(current, this);
        turn.lastMessage = sourceMessage;

        const expanded = current.assistantExpandedStates.get(this) ?? current.reasoningExpanded;
        syncReasoningComponents(current, turn, sourceMessage, expanded);

        const displayMessage = compactAssistantMessage(sourceMessage);
        if (displayMessage !== sourceMessage) {
          current.assistantDisplayMessages.set(displayMessage, sourceMessage);
        }
        withAssistantThinkingHidden(this, () =>
          originalAssistantUpdateContent.call(this, displayMessage),
        );
        tryReorderAssistantTurn(current, this);
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
          const turn = getAssistantTurn(current, this);
          turn.lastMessage = message;
          syncReasoningComponents(current, turn, message, expanded);
          const displayMessage = compactAssistantMessage(message);
          if (displayMessage !== message) {
            current.assistantDisplayMessages.set(displayMessage, message);
          }
          withAssistantThinkingHidden(this, () =>
            originalAssistantUpdateContent.call(this, displayMessage),
          );
          tryReorderAssistantTurn(current, this);
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

  if (state.toolSpinnerInterval) {
    clearInterval(state.toolSpinnerInterval);
    state.toolSpinnerInterval = undefined;
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
    if (state?.toolSpinnerInterval) {
      clearInterval(state.toolSpinnerInterval);
      state.toolSpinnerInterval = undefined;
    }
    setPatchState(undefined);
    return;
  }
  restorePatchedMethods(state);
  if (state.toolSpinnerInterval) {
    clearInterval(state.toolSpinnerInterval);
    state.toolSpinnerInterval = undefined;
  }
  setPatchState(undefined);
}
