import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  destructive: new Set<string>(["delete_media"]),
  expensive: new Set<string>(["export_video"]),
}));

vi.mock("@openreel/agent", () => ({
  getTool: (name: string) => ({ title: `T:${name}`, description: `D:${name}` }),
  isDestructive: (name: string) => h.destructive.has(name),
  isExpensive: (name: string) => h.expensive.has(name),
}));

import {
  useWebMcpConfirmStore,
  confirmWebMcpTool,
  CONFIRM_TIMEOUT_MS,
} from "./webmcp-confirm-store";

const reset = () => {
  useWebMcpConfirmStore.getState().rejectAll();
  useWebMcpConfirmStore.setState({ queue: [], sessionApproved: [] });
};

describe("confirmWebMcpTool", () => {
  beforeEach(reset);
  afterEach(() => {
    reset();
    vi.useRealTimers();
  });

  it("lets a read-only tool straight through without parking anything", async () => {
    await expect(confirmWebMcpTool("list_clips", {})).resolves.toBe(true);
    expect(useWebMcpConfirmStore.getState().queue).toHaveLength(0);
  });

  it("parks a destructive tool until a human approves", async () => {
    const decision = confirmWebMcpTool("delete_media", { mediaId: "m1" });
    await vi.waitFor(() =>
      expect(useWebMcpConfirmStore.getState().queue).toHaveLength(1),
    );
    const request = useWebMcpConfirmStore.getState().queue[0];
    expect(request.name).toBe("delete_media");
    expect(request.destructive).toBe(true);
    expect(request.args).toEqual({ mediaId: "m1" });

    useWebMcpConfirmStore.getState().resolve(request.id, "approve");
    await expect(decision).resolves.toBe(true);
    expect(useWebMcpConfirmStore.getState().queue).toHaveLength(0);
  });

  it("refuses when the human rejects", async () => {
    const decision = confirmWebMcpTool("delete_media", {});
    await vi.waitFor(() =>
      expect(useWebMcpConfirmStore.getState().queue).toHaveLength(1),
    );
    const { id } = useWebMcpConfirmStore.getState().queue[0];
    useWebMcpConfirmStore.getState().resolve(id, "reject");
    await expect(decision).resolves.toBe(false);
  });

  it("parks an expensive tool too", async () => {
    const decision = confirmWebMcpTool("export_video", {});
    await vi.waitFor(() =>
      expect(useWebMcpConfirmStore.getState().queue).toHaveLength(1),
    );
    const request = useWebMcpConfirmStore.getState().queue[0];
    expect(request.expensive).toBe(true);
    expect(request.destructive).toBe(false);
    useWebMcpConfirmStore.getState().resolve(request.id, "approve");
    await expect(decision).resolves.toBe(true);
  });

  it("approve_for_turn skips the prompt for later calls to the same tool", async () => {
    const first = confirmWebMcpTool("delete_media", {});
    await vi.waitFor(() =>
      expect(useWebMcpConfirmStore.getState().queue).toHaveLength(1),
    );
    const { id } = useWebMcpConfirmStore.getState().queue[0];
    useWebMcpConfirmStore.getState().resolve(id, "approve_for_turn");
    await expect(first).resolves.toBe(true);
    expect(useWebMcpConfirmStore.getState().sessionApproved).toEqual([
      "delete_media",
    ]);

    await expect(confirmWebMcpTool("delete_media", {})).resolves.toBe(true);
    expect(useWebMcpConfirmStore.getState().queue).toHaveLength(0);

    // A different sensitive tool still parks.
    const other = confirmWebMcpTool("export_video", {});
    await vi.waitFor(() =>
      expect(useWebMcpConfirmStore.getState().queue).toHaveLength(1),
    );
    useWebMcpConfirmStore
      .getState()
      .resolve(useWebMcpConfirmStore.getState().queue[0].id, "reject");
    await expect(other).resolves.toBe(false);
  });

  it("queues concurrent requests instead of dropping them", async () => {
    const a = confirmWebMcpTool("delete_media", { mediaId: "a" });
    const b = confirmWebMcpTool("export_video", { preset: "4k" });
    await vi.waitFor(() =>
      expect(useWebMcpConfirmStore.getState().queue).toHaveLength(2),
    );
    const [first, second] = useWebMcpConfirmStore.getState().queue;
    useWebMcpConfirmStore.getState().resolve(second.id, "approve");
    useWebMcpConfirmStore.getState().resolve(first.id, "reject");
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(true);
    expect(useWebMcpConfirmStore.getState().queue).toHaveLength(0);
  });

  it("rejectAll releases everything parked", async () => {
    const a = confirmWebMcpTool("delete_media", {});
    const b = confirmWebMcpTool("export_video", {});
    await vi.waitFor(() =>
      expect(useWebMcpConfirmStore.getState().queue).toHaveLength(2),
    );
    useWebMcpConfirmStore.getState().rejectAll();
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(false);
    expect(useWebMcpConfirmStore.getState().queue).toHaveLength(0);
  });

  it("times out an unanswered prompt rather than hanging the agent", async () => {
    vi.useFakeTimers();
    const decision = confirmWebMcpTool("delete_media", {});
    await Promise.resolve();
    expect(useWebMcpConfirmStore.getState().queue).toHaveLength(1);
    vi.advanceTimersByTime(CONFIRM_TIMEOUT_MS);
    await expect(decision).resolves.toBe(false);
    expect(useWebMcpConfirmStore.getState().queue).toHaveLength(0);
  });

  it("ignores a decision for an unknown or already-settled id", async () => {
    expect(() =>
      useWebMcpConfirmStore.getState().resolve("nope", "approve"),
    ).not.toThrow();
    const decision = confirmWebMcpTool("delete_media", {});
    await vi.waitFor(() =>
      expect(useWebMcpConfirmStore.getState().queue).toHaveLength(1),
    );
    const { id } = useWebMcpConfirmStore.getState().queue[0];
    useWebMcpConfirmStore.getState().resolve(id, "approve");
    await expect(decision).resolves.toBe(true);
    expect(() =>
      useWebMcpConfirmStore.getState().resolve(id, "reject"),
    ).not.toThrow();
  });
});
