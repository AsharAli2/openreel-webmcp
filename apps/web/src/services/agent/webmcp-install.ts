import { type ToolResult } from "@openreel/agent";
import { createWebMcpSurface, type WebMcpToolSurface } from "./webmcp-adapter";
import { startSurfaceController } from "./webmcp-surface-controller";
import type { EditorSurfaceState } from "./webmcp-tool-selection";
import type { SelectionResult } from "./webmcp-tool-selection";
import { callToolForBridge } from "./mcp-listener";
import {
  confirmWebMcpTool,
  useWebMcpConfirmStore,
} from "./webmcp-confirm-store";
import { useWebMcpActivityStore } from "./webmcp-activity-store";

/** Set by installWebMcpSurface so debug helpers can inspect the live surface. */
let activeSurface: WebMcpToolSurface | null = null;

export function getActiveWebMcpSurface(): WebMcpToolSurface | null {
  return activeSurface;
}

/**
 * Runs a tool once consent is settled. Read-only tools go straight through;
 * anything destructive or expensive parks in the confirm store until a human
 * answers, then reuses the bridge core's own refusal path when declined.
 *
 * Every call is logged to the activity store, including the ones that park and
 * the ones that get refused — a refusal is the most interesting entry in the
 * log, so it must not be silent.
 */
async function invokeWithConsent(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const activity = useWebMcpActivityStore.getState();
  const callId = activity.beginCall(name, args);
  try {
    const allowed = await confirmWebMcpTool(name, args);
    const result = await callToolForBridge(name, args, {
      allowSensitive: allowed,
      confirmationHint: `'${name}' needs approval in the editor before an agent can run it.`,
    });
    useWebMcpActivityStore.getState().finishCall(callId, result);
    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Tool invocation failed";
    const failure: ToolResult = {
      ok: false,
      summary: message,
      error: { code: "INVOKE_FAILED", message },
    };
    useWebMcpActivityStore.getState().finishCall(callId, failure);
    return failure;
  }
}

export interface InstallWebMcpOptions {
  /** Fired after every surface sync, including the first. */
  readonly onSync?: (
    selection: SelectionResult,
    state: EditorSurfaceState,
  ) => void;
  readonly onUnavailable?: () => void;
}

/**
 * Exposes the editor's tools to any agent on the page and returns a teardown.
 *
 * A no-op when the browser has no WebMCP support, so the editor behaves exactly
 * as before on unflagged Chrome and every other browser.
 */
export function installWebMcpSurface(
  options: InstallWebMcpOptions = {},
): () => void {
  const surface = createWebMcpSurface({ invoke: invokeWithConsent });
  if (!surface) {
    activeSurface = null;
    useWebMcpActivityStore.getState().setAvailable(false);
    options.onUnavailable?.();
    return () => {};
  }
  activeSurface = surface;
  useWebMcpActivityStore.getState().setAvailable(true);

  const stopController = startSurfaceController(surface, {
    onSync: (selection, state) => {
      if (activeSurface !== surface) return;
      useWebMcpActivityStore.getState().recordSync(selection);
      options.onSync?.(selection, state);
    },
  });

  return () => {
    stopController();
    surface.dispose();
    // Nothing may stay parked on a human once the surface is gone.
    useWebMcpConfirmStore.getState().rejectAll();
    useWebMcpActivityStore.getState().setAvailable(false);
    if (activeSurface === surface) activeSurface = null;
  };
}
