import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  surface: { sync: vi.fn(), exposed: vi.fn(() => []), dispose: vi.fn() },
  createWebMcpSurface: vi.fn(),
  startSurfaceController: vi.fn(),
  stopController: vi.fn(),
  callToolForBridge: vi.fn(),
  confirmWebMcpTool: vi.fn(),
  rejectAll: vi.fn(),
}));

vi.mock("@openreel/agent", () => ({}));

vi.mock("./webmcp-adapter", () => ({
  createWebMcpSurface: h.createWebMcpSurface,
}));

vi.mock("./webmcp-surface-controller", () => ({
  startSurfaceController: h.startSurfaceController,
}));

vi.mock("./mcp-listener", () => ({ callToolForBridge: h.callToolForBridge }));

vi.mock("./webmcp-confirm-store", () => ({
  confirmWebMcpTool: h.confirmWebMcpTool,
  useWebMcpConfirmStore: { getState: () => ({ rejectAll: h.rejectAll }) },
}));

import { installWebMcpSurface, getActiveWebMcpSurface } from "./webmcp-install";

describe("installWebMcpSurface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createWebMcpSurface.mockReturnValue(h.surface);
    h.startSurfaceController.mockReturnValue(h.stopController);
    h.callToolForBridge.mockResolvedValue({ ok: true, summary: "ran" });
    h.confirmWebMcpTool.mockResolvedValue(true);
  });

  const capturedInvoke = () =>
    h.createWebMcpSurface.mock.calls[0][0].invoke as (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>;

  it("hands the surface to the state-driven controller", () => {
    installWebMcpSurface();
    expect(h.startSurfaceController).toHaveBeenCalledWith(
      h.surface,
      expect.objectContaining({ onSync: expect.any(Function) }),
    );
    expect(getActiveWebMcpSurface()).toBe(h.surface);
  });

  it("forwards controller syncs to the caller", () => {
    const onSync = vi.fn();
    installWebMcpSurface({ onSync });
    const controllerOptions = h.startSurfaceController.mock.calls[0][1];
    const selection = { names: ["list_clips"], reasons: {}, activeRules: [], truncated: false };
    const state = { hasProject: true };
    controllerOptions.onSync(selection, state);
    expect(onSync).toHaveBeenCalledWith(selection, state);
  });

  it("is inert and reports unavailable when the browser has no WebMCP", () => {
    h.createWebMcpSurface.mockReturnValue(null);
    const onUnavailable = vi.fn();
    const teardown = installWebMcpSurface({ onUnavailable });
    expect(onUnavailable).toHaveBeenCalled();
    expect(h.startSurfaceController).not.toHaveBeenCalled();
    expect(getActiveWebMcpSurface()).toBeNull();
    expect(() => teardown()).not.toThrow();
  });

  it("runs a tool the human approved", async () => {
    installWebMcpSurface();
    await capturedInvoke()("delete_media", { mediaId: "m1" });
    expect(h.confirmWebMcpTool).toHaveBeenCalledWith("delete_media", {
      mediaId: "m1",
    });
    expect(h.callToolForBridge).toHaveBeenCalledWith(
      "delete_media",
      { mediaId: "m1" },
      expect.objectContaining({ allowSensitive: true }),
    );
  });

  it("refuses a tool the human declined", async () => {
    h.confirmWebMcpTool.mockResolvedValue(false);
    installWebMcpSurface();
    await capturedInvoke()("delete_media", {});
    expect(h.callToolForBridge).toHaveBeenCalledWith(
      "delete_media",
      {},
      expect.objectContaining({ allowSensitive: false }),
    );
  });

  it("teardown stops the controller, disposes, and releases parked calls", () => {
    const teardown = installWebMcpSurface();
    teardown();
    expect(h.stopController).toHaveBeenCalled();
    expect(h.surface.dispose).toHaveBeenCalled();
    expect(h.rejectAll).toHaveBeenCalled();
    expect(getActiveWebMcpSurface()).toBeNull();
  });
});
