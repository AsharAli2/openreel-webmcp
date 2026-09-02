import { create } from "zustand";
import { CORE_TOOL_NAMES } from "@openreel/agent";
import type { ToolResult } from "@openreel/agent";
import type { SelectionResult } from "./webmcp-tool-selection";

/**
 * Observability for the in-page agent surface.
 *
 * The tool surface only exists inside `document.modelContext`, so without this
 * the most interesting thing about it — that it tracks editor state — is
 * invisible to the person using the editor. This store keeps the current
 * surface and a short call log so the UI can show both.
 */

export type ToolCallStatus = "running" | "ok" | "error" | "refused";

export interface ToolCallRecord {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly status: ToolCallStatus;
  readonly summary?: string;
  readonly errorCode?: string;
  readonly durationMs?: number;
  readonly startedAt: number;
}

/** Enough history to show a sequence of agent work, not enough to leak memory. */
export const MAX_CALL_LOG = 24;

/** One row of the exposed surface, grouped by why those tools are exposed. */
export interface ToolGroup {
  readonly label: string;
  readonly count: number;
  readonly names: readonly string[];
}

interface WebMcpActivityState {
  /** Whether this browser exposes WebMCP at all. */
  readonly available: boolean;
  readonly exposed: readonly string[];
  readonly reasons: Readonly<Record<string, string>>;
  readonly activeRules: readonly string[];
  readonly truncated: boolean;
  readonly lastSyncAt: number | null;
  readonly calls: readonly ToolCallRecord[];

  setAvailable(available: boolean): void;
  recordSync(selection: SelectionResult): void;
  beginCall(name: string, args: Record<string, unknown>): string;
  finishCall(id: string, result: ToolResult): void;
  clearCalls(): void;
}

const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const useWebMcpActivityStore = create<WebMcpActivityState>((set) => ({
  available: false,
  exposed: [],
  reasons: {},
  activeRules: [],
  truncated: false,
  lastSyncAt: null,
  calls: [],

  setAvailable: (available) => set({ available }),

  recordSync: (selection) =>
    set({
      exposed: selection.names,
      reasons: selection.reasons,
      activeRules: selection.activeRules,
      truncated: selection.truncated,
      lastSyncAt: Date.now(),
    }),

  beginCall: (name, args) => {
    const id = newId();
    set((state) => ({
      calls: [
        {
          id,
          name,
          args,
          status: "running" as ToolCallStatus,
          startedAt: Date.now(),
        },
        ...state.calls,
      ].slice(0, MAX_CALL_LOG),
    }));
    return id;
  },

  finishCall: (id, result) =>
    set((state) => ({
      calls: state.calls.map((call) => {
        if (call.id !== id) return call;
        const refused = result.error?.code === "CONFIRMATION_REQUIRED";
        return {
          ...call,
          status: result.ok ? "ok" : refused ? "refused" : "error",
          summary: result.summary,
          errorCode: result.error?.code,
          durationMs: Date.now() - call.startedAt,
        };
      }),
    })),

  clearCalls: () => set({ calls: [] }),
}));

/**
 * Groups the exposed surface by the rule that put each tool there, in the order
 * the rules fired, so the UI reads as a cause-and-effect list rather than an
 * alphabetical dump.
 */
export function groupExposedTools(
  exposed: readonly string[],
  reasons: Readonly<Record<string, string>>,
  activeRules: readonly string[],
): readonly ToolGroup[] {
  const core = exposed.filter((name) => CORE_TOOL_NAMES.has(name));
  const groups: ToolGroup[] = [];
  if (core.length > 0) {
    groups.push({ label: "always available", count: core.length, names: core });
  }
  for (const label of activeRules) {
    const names = exposed.filter((name) => reasons[name] === label);
    if (names.length > 0) groups.push({ label, count: names.length, names });
  }
  return groups;
}
