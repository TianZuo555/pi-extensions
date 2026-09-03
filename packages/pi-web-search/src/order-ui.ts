/**
 * /websearch-order UI — grab-and-move list for the search fallback chain.
 * Keys: ↑↓ navigate (or move the grabbed item), enter grab then save,
 * space drop without saving, esc cancel. Every rendered line is
 * width-safe via truncateToWidth.
 */

import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

export interface OrderItem {
  id: string;
  /** Short credential/config summary shown next to the name. */
  detail: string;
  /** True when the provider currently has resolvable credentials. */
  active: boolean;
}

const NAME_WIDTH = 11;

/** Open the reorder dialog; resolves with the new id order, or null on cancel. */
export function promptProviderOrder(
  ctx: ExtensionCommandContext,
  title: string,
  items: OrderItem[],
): Promise<string[] | null> {
  const detailById = new Map(items.map((item) => [item.id, item.detail]));
  const activeById = new Map(items.map((item) => [item.id, item.active]));

  return ctx.ui.custom<string[] | null>(
    (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done) => {
      const order = items.map((item) => item.id);
      const initial = [...order];
      let cursor = 0;
      let grabbed = false;

      const move = (delta: -1 | 1): void => {
        if (grabbed) {
          const target = cursor + delta;
          if (target < 0 || target >= order.length) return;
          [order[cursor], order[target]] = [order[target], order[cursor]];
          cursor = target;
        } else if (order.length > 0) {
          cursor = (cursor + delta + order.length) % order.length;
        }
        tui.requestRender();
      };

      const component: Component = {
        render: (width: number): string[] => {
          const help = grabbed
            ? "↑↓ move item • space drop • enter save • esc cancel"
            : "↑↓ navigate • enter grab • esc cancel";
          const lines = [theme.fg("accent", theme.bold(title)), "", theme.fg("dim", help), ""];
          order.forEach((id, index) => {
            const isCursor = index === cursor;
            const isGrabbed = isCursor && grabbed;
            const marker = isGrabbed
              ? theme.fg("accent", "● ")
              : isCursor
                ? theme.fg("accent", "→ ")
                : "  ";
            const name = isGrabbed ? theme.fg("accent", theme.bold(id)) : theme.bold(id);
            const pad = " ".repeat(Math.max(0, NAME_WIDTH - id.length));
            const status =
              (activeById.get(id) ?? false) ? theme.fg("success", "✓") : theme.fg("dim", "•");
            const detail = theme.fg("muted", detailById.get(id) ?? "");
            lines.push(`${marker}${name}${pad} ${status} ${detail}`);
          });
          lines.push(
            "",
            theme.fg(
              "dim",
              "Top runs first; unconfigured (•) providers are skipped until they have credentials.",
            ),
          );
          return lines.map((line) => truncateToWidth(line, width));
        },
        invalidate: (): void => {
          tui.requestRender();
        },
        handleInput: (data: string): void => {
          if (keybindings.matches(data, "tui.select.cancel")) {
            done(null);
            return;
          }
          if (keybindings.matches(data, "tui.select.up")) {
            move(-1);
            return;
          }
          if (keybindings.matches(data, "tui.select.down")) {
            move(1);
            return;
          }
          if (keybindings.matches(data, "tui.select.confirm")) {
            if (grabbed) {
              done(order.every((id, index) => id === initial[index]) ? [...initial] : [...order]);
              return;
            }
            grabbed = true;
            tui.requestRender();
            return;
          }
          if (data === " ") {
            grabbed = !grabbed;
            tui.requestRender();
          }
        },
      };
      return component;
    },
  );
}
