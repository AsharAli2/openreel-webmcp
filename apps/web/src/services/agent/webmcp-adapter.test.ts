import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  getTool: vi.fn(),
  callToolForBridge: vi.fn(),
}));

vi.mock("@openreel/agent", () => ({ getTool: h.getTool }));
vi.mock("./mcp-listener", () => ({ callToolForBridge: h.callToolForBridge }));

import {
  WebMcpToolSurface,
  toWebMcpDescriptor,
  getModelContext,
  isWebMcpAvailable,
  type ModelContextLike,
  type WebMcpToolDescriptor,
} from "./webmcp-adapter";

const def = (over: Partial<Record<string, unknown>> = {}) => ({
  name: "list_clips",
  domain: "read",
  title: "List clips",
  description: "All clips",
  inputSchema: { type: "object", properties: {} },
  readOnly: true,
  destructive: false,
  expensive: false,
  ...over,
}) as never;

class FakeModelContext implements ModelContextLike {
  registered = new Map<string, WebMcpToolDescriptor>();
  failOn: string | null = null;
  async registerTool(
    tool: WebMcpToolDescriptor,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    if (this.failOn === tool.name) throw new Error("Duplicate tool name");
    if (this.registered.has(tool.name)) throw new Error("Duplicate tool name");
    this.registered.set(tool.name, tool);
    options?.signal?.addEventListener("abort", () => {
      this.registered.delete(tool.name);
    });
  }
  async getTools() {
    return [...this.registered.keys()].map((name) => ({ name }));
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

describe("toWebMcpDescriptor", () => {
  it("maps readOnly to readOnlyHint and flags untrusted-content domains", () => {
    const invoke = vi.fn();
    const readTool = toWebMcpDescriptor(def(), invoke);
    expect(readTool.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });

    const clipTool = toWebMcpDescriptor(
      def({ name: "add_clip", domain: "clip", readOnly: false }),
      invoke,
    );
    expect(clipTool.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: false,
    });
  });

  it("passes parsed input straight through to the invoker", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, summary: "done" });
    const tool = toWebMcpDescriptor(def(), invoke);
    await tool.execute({ trackId: "t1" });
    expect(invoke).toHaveBeenCalledWith("list_clips", { trackId: "t1" });
  });

  it("drops an oversized rendered image rather than shipping it to the agent", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      summary: "rendered",
      image: { dataUrl: "d".repeat(200_001) },
    });
    const result = (await toWebMcpDescriptor(def(), invoke).execute({})) as Record<
      string,
      unknown
    >;
    expect(result.image).toBeUndefined();
    expect(String(result.imageOmitted)).toContain("omitted");
  });

  it("keeps a small rendered image intact", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      summary: "rendered",
      image: { dataUrl: "d".repeat(64) },
    });
    const result = (await toWebMcpDescriptor(def(), invoke).execute({})) as Record<
      string,
      unknown
    >;
    expect(result.image).toEqual({ dataUrl: "d".repeat(64) });
  });
});

describe("WebMcpToolSurface", () => {
  let mc: FakeModelContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mc = new FakeModelContext();
    h.getTool.mockImplementation((name: string) => def({ name }));
    h.callToolForBridge.mockResolvedValue({ ok: true, summary: "ok" });
  });

  it("registers the desired set", async () => {
    const surface = new WebMcpToolSurface(mc);
    await surface.sync(["list_clips", "add_clip"]);
    expect(surface.exposed()).toEqual(["add_clip", "list_clips"]);
    expect([...mc.registered.keys()].sort()).toEqual(["add_clip", "list_clips"]);
  });

  it("retracts tools that leave the desired set", async () => {
    const surface = new WebMcpToolSurface(mc);
    await surface.sync(["list_clips", "add_clip"]);
    await surface.sync(["list_clips"]);
    expect(surface.exposed()).toEqual(["list_clips"]);
    expect([...mc.registered.keys()]).toEqual(["list_clips"]);
  });

  it("is idempotent — a repeated sync does not re-register and duplicate", async () => {
    const surface = new WebMcpToolSurface(mc);
    await surface.sync(["list_clips"]);
    await surface.sync(["list_clips"]);
    expect(surface.exposed()).toEqual(["list_clips"]);
  });

  it("reports a registration failure without losing the rest of the set", async () => {
    const onError = vi.fn();
    mc.failOn = "add_clip";
    const surface = new WebMcpToolSurface(mc, { onError });
    await surface.sync(["list_clips", "add_clip"]);
    expect(surface.exposed()).toEqual(["list_clips"]);
    expect(onError).toHaveBeenCalledWith("add_clip", expect.any(Error));
  });

  it("skips names absent from the registry", async () => {
    const onError = vi.fn();
    h.getTool.mockImplementation((name: string) =>
      name === "ghost_tool" ? undefined : def({ name }),
    );
    const surface = new WebMcpToolSurface(mc, { onError });
    await surface.sync(["ghost_tool", "list_clips"]);
    expect(surface.exposed()).toEqual(["list_clips"]);
    expect(onError).toHaveBeenCalledWith("ghost_tool", expect.any(Error));
  });

  it("fails closed by default — sensitive tools are refused without a gated invoke", async () => {
    const surface = new WebMcpToolSurface(mc);
    await surface.sync(["add_clip"]);
    await mc.registered.get("add_clip")!.execute({ mediaId: "m1" });
    expect(h.callToolForBridge).toHaveBeenCalledWith(
      "add_clip",
      { mediaId: "m1" },
      { allowSensitive: false },
    );
  });

  it("uses a supplied invoke so callers can gate on human consent", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, summary: "gated" });
    const surface = new WebMcpToolSurface(mc, { invoke });
    await surface.sync(["add_clip"]);
    await mc.registered.get("add_clip")!.execute({ mediaId: "m1" });
    expect(invoke).toHaveBeenCalledWith("add_clip", { mediaId: "m1" });
    expect(h.callToolForBridge).not.toHaveBeenCalled();
  });

  it("dispose retracts everything", async () => {
    const surface = new WebMcpToolSurface(mc);
    await surface.sync(["list_clips", "add_clip"]);
    surface.dispose();
    expect(surface.exposed()).toEqual([]);
    expect(mc.registered.size).toBe(0);
  });
});

describe("getModelContext", () => {
  it("reports unavailable when the browser exposes no modelContext", () => {
    expect(getModelContext()).toBeNull();
    expect(isWebMcpAvailable()).toBe(false);
  });

  it("prefers document.modelContext", () => {
    const stub = new FakeModelContext();
    Object.defineProperty(document, "modelContext", {
      value: stub,
      configurable: true,
    });
    try {
      expect(getModelContext()).toBe(stub);
      expect(isWebMcpAvailable()).toBe(true);
    } finally {
      delete (document as unknown as Record<string, unknown>).modelContext;
    }
  });
});
