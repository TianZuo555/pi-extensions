// /websearch-order UI — tabbed grab-and-move lists for the search and fetch
// fallback chains. Tab switches tools; ↑↓ navigates or moves a grabbed item;
// enter grabs/saves; space drops without saving; esc cancels.

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
  /** True when the provider is currently available for this tool. */
  active: boolean;
}

export interface OrderTab {
  id: "search" | "fetch";
  label: string;
  items: OrderItem[];
}

export interface ProviderOrders {
  search: string[];
  fetch: string[];
}

const NAME_WIDTH = 11;

/** Build the editable full order without losing unavailable providers from a
 * previously saved order. */
export function completeProviderOrder<P extends string>(
  canonical: readonly P[],
  resolved: readonly P[],
  configuredHead?: P,
  configuredOrder?: readonly P[],
): P[] {
  const known = new Set(canonical);
  return [
    ...new Set([
      ...(configuredHead && known.has(configuredHead) ? [configuredHead] : []),
      ...(Array.isArray(configuredOrder)
        ? configuredOrder.filter((provider) => known.has(provider))
        : []),
      ...resolved,
      ...canonical,
    ]),
  ];
}

/** Open the tabbed reorder dialog; resolves with both orders, or null on cancel. */
export function promptProviderOrder(
  ctx: ExtensionCommandContext,
  tabs: [OrderTab, OrderTab],
): Promise<ProviderOrders | null> {
  return ctx.ui.custom<ProviderOrders | null>(
    (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done) => {
      let tabIndex = 0;
      let grabbed = false;
      const orders: ProviderOrders = {
        search: tabs.find((tab) => tab.id === "search")?.items.map((item) => item.id) ?? [],
        fetch: tabs.find((tab) => tab.id === "fetch")?.items.map((item) => item.id) ?? [],
      };
      const cursors: Record<OrderTab["id"], number> = { search: 0, fetch: 0 };

      const activeTab = (): OrderTab => tabs[tabIndex];
      const activeOrder = (): string[] => orders[activeTab().id];

      const move = (delta: -1 | 1): void => {
        const tab = activeTab();
        const order = activeOrder();
        const cursor = cursors[tab.id];
        if (grabbed) {
          const target = cursor + delta;
          if (target < 0 || target >= order.length) return;
          [order[cursor], order[target]] = [order[target], order[cursor]];
          cursors[tab.id] = target;
        } else if (order.length > 0) {
          cursors[tab.id] = (cursor + delta + order.length) % order.length;
        }
        tui.requestRender();
      };

      const switchTab = (): void => {
        grabbed = false;
        tabIndex = (tabIndex + 1) % tabs.length;
        tui.requestRender();
      };

      const component: Component = {
        render: (width: number): string[] => {
          const tab = activeTab();
          const order = activeOrder();
          const itemById = new Map(tab.items.map((item) => [item.id, item]));
          const tabLabels = tabs
            .map((candidate, index) => {
              const label = ` ${candidate.label} `;
              return index === tabIndex
                ? theme.bg("selectedBg", theme.fg("text", theme.bold(label)))
                : theme.fg("dim", label);
            })
            .join(" ");
          const help = grabbed
            ? "↑↓ move item • space drop • enter save • tab switch • esc cancel"
            : "↑↓ navigate • enter grab • tab switch • esc cancel";
          const lines = [
            theme.fg("accent", theme.bold("Web provider order")),
            "",
            `${tabLabels}${theme.fg("dim", "  Tab switches tool")}`,
            "",
            theme.fg("dim", help),
            "",
          ];

          order.forEach((id, index) => {
            const item = itemById.get(id);
            const isCursor = index === cursors[tab.id];
            const isGrabbed = isCursor && grabbed;
            const marker = isGrabbed
              ? theme.fg("accent", "● ")
              : isCursor
                ? theme.fg("accent", "→ ")
                : "  ";
            const name = isGrabbed ? theme.fg("accent", theme.bold(id)) : theme.bold(id);
            const pad = " ".repeat(Math.max(0, NAME_WIDTH - id.length));
            const status = item?.active ? theme.fg("success", "✓") : theme.fg("dim", "•");
            const detail = theme.fg("muted", item?.detail ?? "");
            lines.push(`${marker}${name}${pad} ${status} ${detail}`);
          });
          lines.push(
            "",
            theme.fg(
              "dim",
              "Top runs first; unavailable (•) providers keep their position and are skipped.",
            ),
          );
          return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
        },
        invalidate: (): void => {},
        handleInput: (data: string): void => {
          if (keybindings.matches(data, "tui.select.cancel")) {
            done(null);
            return;
          }
          if (keybindings.matches(data, "tui.input.tab")) {
            switchTab();
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
              done({ search: [...orders.search], fetch: [...orders.fetch] });
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
