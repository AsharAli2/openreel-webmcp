import { create } from "zustand";
import { getTool, isDestructive, isExpensive } from "@openreel/agent";
import type { ConfirmDecision } from "@openreel/agent";

/**
 * Chrome does NOT gate WebMCP tool calls. Verified against Chrome 152: a tool
 * registered with `readOnlyHint: false` executes immediately with no prompt, and
 * ModelContext exposes no consent API. The hints are advisory metadata for the
 * agent, not an enforcement boundary.
 *
 * So the page owns consent. Anything the registry marks destructive or
 * expensive waits here for a human before it touches the project.
 */

/** A call that is parked waiting on a human. */
export interface WebMcpConfirmRequest {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly args: Record<string, unknown>;
  readonly destructive: boolean;
  readonly expensive: boolean;
}

/**
 * An unanswered prompt must not park an agent call forever — the agent has no
 * way to know the page is waiting on a human who walked away.
 */
export const CONFIRM_TIMEOUT_MS = 120_000;

interface PendingEntry {
  readonly request: WebMcpConfirmRequest;
  readonly resolve: (decision: ConfirmDecision) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface WebMcpConfirmState {
  readonly queue: readonly WebMcpConfirmRequest[];
  /** Tool names the human approved for the rest of this page session. */
  readonly sessionApproved: readonly string[];
  request(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ConfirmDecision>;
  resolve(id: string, decision: ConfirmDecision): void;
  /** Rejects everything parked — used on teardown so no call hangs. */
  rejectAll(): void;
  clearSessionApprovals(): void;
}

const pending = new Map<string, PendingEntry>();

const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `wmc-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const useWebMcpConfirmStore = create<WebMcpConfirmState>((set, get) => ({
  queue: [],
  sessionApproved: [],

  request(name, args) {
    const def = getTool(name);
    const request: WebMcpConfirmRequest = {
      id: newId(),
      name,
      title: def?.title ?? name,
      description: def?.description ?? "",
      args,
      destructive: isDestructive(name),
      expensive: isExpensive(name),
    };
    return new Promise<ConfirmDecision>((resolve) => {
      const settle = (decision: ConfirmDecision): void => {
        const entry = pending.get(request.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(request.id);
        set((state) => ({
          queue: state.queue.filter((item) => item.id !== request.id),
        }));
        resolve(decision);
      };
      const timer = setTimeout(() => settle("reject"), CONFIRM_TIMEOUT_MS);
      pending.set(request.id, { request, resolve: settle, timer });
      set((state) => ({ queue: [...state.queue, request] }));
    });
  },

  resolve(id, decision) {
    const entry = pending.get(id);
    if (!entry) return;
    if (decision === "approve_for_turn") {
      const name = entry.request.name;
      if (!get().sessionApproved.includes(name)) {
        set((state) => ({ sessionApproved: [...state.sessionApproved, name] }));
      }
    }
    entry.resolve(decision);
  },

  rejectAll() {
    for (const entry of [...pending.values()]) entry.resolve("reject");
  },

  clearSessionApprovals() {
    set({ sessionApproved: [] });
  },
}));

/**
 * Decides whether a tool may run. Read-only tools pass straight through; a name
 * the human already blanket-approved passes too; everything else parks until
 * answered, timed out, or torn down.
 */
export async function confirmWebMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  if (!isDestructive(name) && !isExpensive(name)) return true;
  const store = useWebMcpConfirmStore.getState();
  if (store.sessionApproved.includes(name)) return true;
  const decision = await store.request(name, args);
  return decision === "approve" || decision === "approve_for_turn";
}
