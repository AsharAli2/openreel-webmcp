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

/** Set by installWebMcpSurface so debug helpers can inspect the live surface. */
let activeSurface: WebMcpToolSurface | null = null;

export function getActiveWebMcpSurface(): WebMcpToolSurface | null {
  return activeSurface;
}

/**
 * Runs a tool once consent is settled. Read-only tools go straight through;
 * anything destructive or expensive parks in the confirm store until a human
 * answers, then reuses the bridge core's own refusal path when declined.
 */
async function invokeWithConsent(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const allowed = await confirmWebMcpTool(name, args);
  return callToolForBridge(name, args, {
    allowSensitive: allowed,
    confirmationHint: `'${name}' needs approval in the editor before an agent can run it.`,
  });
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
    options.onUnavailable?.();
    return () => {};
  }
  activeSurface = surface;

  const stopController = startSurfaceController(surface, {
    onSync: (selection, state) => {
      if (activeSurface !== surface) return;
      options.onSync?.(selection, state);
    },
  });

  return () => {
    stopController();
    surface.dispose();
    // Nothing may stay parked on a human once the surface is gone.
    useWebMcpConfirmStore.getState().rejectAll();
    if (activeSurface === surface) activeSurface = null;
  };
}
