import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@openreel/agent", () => ({
  CORE_TOOL_NAMES: new Set(["get_editor_state", "list_clips"]),
}));

import {
  useWebMcpActivityStore,
  groupExposedTools,
  MAX_CALL_LOG,
} from "./webmcp-activity-store";

const reset = () =>
  useWebMcpActivityStore.setState({
    available: false,
    exposed: [],
    reasons: {},
    activeRules: [],
    truncated: false,
    lastSyncAt: null,
    calls: [],
  });

describe("groupExposedTools", () => {
  it("puts core first, then one group per rule in rule order", () => {
    const groups = groupExposedTools(
      ["get_editor_state", "list_clips", "add_track", "set_clip_volume"],
      { add_track: "a project is open", set_clip_volume: "the project has audio" },
      ["a project is open", "the project has audio"],
    );
    expect(groups.map((g) => [g.label, g.count])).toEqual([
      ["always available", 2],
      ["a project is open", 1],
      ["the project has audio", 1],
    ]);
  });

  it("omits rules that contributed nothing to the exposed set", () => {
    const groups = groupExposedTools(
      ["get_editor_state"],
      {},
      ["a project is open", "the project has audio"],
    );
    expect(groups.map((g) => g.label)).toEqual(["always available"]);
  });

  it("handles an empty surface", () => {
    expect(groupExposedTools([], {}, [])).toEqual([]);
  });
});

describe("useWebMcpActivityStore", () => {
  beforeEach(reset);

  it("records a sync", () => {
    useWebMcpActivityStore.getState().recordSync({
      names: ["list_clips", "add_track"],
      reasons: { add_track: "a project is open" },
      activeRules: ["a project is open"],
      truncated: false,
    });
    const state = useWebMcpActivityStore.getState();
    expect(state.exposed).toEqual(["list_clips", "add_track"]);
    expect(state.activeRules).toEqual(["a project is open"]);
    expect(state.lastSyncAt).toBeTypeOf("number");
  });

  it("logs a successful call with a duration", () => {
    const id = useWebMcpActivityStore.getState().beginCall("add_track", {
      trackType: "audio",
    });
    expect(useWebMcpActivityStore.getState().calls[0]).toMatchObject({
      name: "add_track",
      status: "running",
    });
    useWebMcpActivityStore
      .getState()
      .finishCall(id, { ok: true, summary: "add_track applied" });
    const call = useWebMcpActivityStore.getState().calls[0];
    expect(call.status).toBe("ok");
    expect(call.summary).toBe("add_track applied");
    expect(call.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("distinguishes a refusal from an error", () => {
    const refusedId = useWebMcpActivityStore.getState().beginCall("delete_media", {});
    useWebMcpActivityStore.getState().finishCall(refusedId, {
      ok: false,
      summary: "Confirmation required",
      error: { code: "CONFIRMATION_REQUIRED", message: "needs approval" },
    });
    expect(useWebMcpActivityStore.getState().calls[0].status).toBe("refused");

    const errorId = useWebMcpActivityStore.getState().beginCall("remove_track", {});
    useWebMcpActivityStore.getState().finishCall(errorId, {
      ok: false,
      summary: "Track not found",
      error: { code: "NOT_FOUND", message: "no such track" },
    });
    expect(useWebMcpActivityStore.getState().calls[0].status).toBe("error");
  });

  it("keeps newest first and caps the log", () => {
    for (let i = 0; i < MAX_CALL_LOG + 6; i += 1) {
      useWebMcpActivityStore.getState().beginCall(`tool_${i}`, {});
    }
    const calls = useWebMcpActivityStore.getState().calls;
    expect(calls).toHaveLength(MAX_CALL_LOG);
    expect(calls[0].name).toBe(`tool_${MAX_CALL_LOG + 5}`);
  });

  it("ignores finishing an unknown call id", () => {
    expect(() =>
      useWebMcpActivityStore.getState().finishCall("nope", { ok: true, summary: "x" }),
    ).not.toThrow();
  });

  it("tracks availability", () => {
    useWebMcpActivityStore.getState().setAvailable(true);
    expect(useWebMcpActivityStore.getState().available).toBe(true);
    useWebMcpActivityStore.getState().setAvailable(false);
    expect(useWebMcpActivityStore.getState().available).toBe(false);
  });
});
