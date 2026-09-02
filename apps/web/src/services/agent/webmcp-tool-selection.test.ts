import { describe, it, expect } from "vitest";
import { CORE_TOOL_NAMES, getTool } from "@openreel/agent";
import {
  selectToolsForState,
  EMPTY_SURFACE_STATE,
  MAX_EXPOSED_TOOLS,
  type EditorSurfaceState,
} from "./webmcp-tool-selection";

// Runs against the REAL registry so rule/domain drift is actually caught.

const state = (over: Partial<EditorSurfaceState> = {}): EditorSurfaceState => ({
  ...EMPTY_SURFACE_STATE,
  ...over,
});

const domainsOf = (names: readonly string[]): Set<string> =>
  new Set(names.map((name) => getTool(name)?.domain ?? "?"));

describe("selectToolsForState", () => {
  it("exposes only the core on an empty editor", () => {
    const { names, activeRules } = selectToolsForState(EMPTY_SURFACE_STATE);
    expect(activeRules).toEqual([]);
    for (const name of names) expect(CORE_TOOL_NAMES.has(name)).toBe(true);
    expect(names.length).toBeGreaterThan(10);
  });

  it("grows the surface once a project is open", () => {
    const empty = selectToolsForState(EMPTY_SURFACE_STATE).names;
    const open = selectToolsForState(state({ hasProject: true })).names;
    expect(open.length).toBeGreaterThan(empty.length);
    expect(new Set(open)).toEqual(new Set([...open]));
    for (const name of empty) expect(open).toContain(name);
  });

  it("adds media and clip tools when media is imported", () => {
    const before = selectToolsForState(state({ hasProject: true })).names;
    const after = selectToolsForState(
      state({ hasProject: true, mediaCount: 3 }),
    ).names;
    expect(after.length).toBeGreaterThan(before.length);
    expect(domainsOf(after).has("media")).toBe(true);
  });

  it("adds audio tools only when the project has audio", () => {
    const without = selectToolsForState(
      state({ hasProject: true, clipCount: 2 }),
    ).names;
    const withAudio = selectToolsForState(
      state({ hasProject: true, clipCount: 2, hasAudio: true }),
    ).names;
    expect(domainsOf(without).has("audio")).toBe(false);
    expect(domainsOf(withAudio).has("audio")).toBe(true);
  });

  it("adds transition tools only past a second clip", () => {
    const one = selectToolsForState(state({ hasProject: true, clipCount: 1 }));
    const two = selectToolsForState(state({ hasProject: true, clipCount: 2 }));
    expect(domainsOf(one.names).has("transition")).toBe(false);
    expect(domainsOf(two.names).has("transition")).toBe(true);
  });

  it("reveals text animators only while a text clip is selected", () => {
    const unselected = selectToolsForState(
      state({ hasProject: true, clipCount: 1 }),
    ).names;
    const selected = selectToolsForState(
      state({
        hasProject: true,
        clipCount: 1,
        selectedClipCount: 1,
        hasTextSelection: true,
      }),
    ).names;
    const animators = (names: readonly string[]) =>
      names.filter((n) => /text_(animator|shader)/.test(n));
    expect(animators(unselected)).toHaveLength(0);
    expect(animators(selected).length).toBeGreaterThan(0);
  });

  it("retracts tools when state goes away again", () => {
    const withAudio = selectToolsForState(
      state({ hasProject: true, clipCount: 2, hasAudio: true }),
    ).names;
    const withoutAudio = selectToolsForState(
      state({ hasProject: true, clipCount: 2 }),
    ).names;
    const dropped = withAudio.filter((n) => !withoutAudio.includes(n));
    expect(dropped.length).toBeGreaterThan(0);
  });

  it("keeps the 3D creation family out of the surface entirely", () => {
    const busy = selectToolsForState(
      state({
        hasProject: true,
        clipCount: 5,
        hasMotionComposition: true,
        hasTextSelection: true,
        selectedClipCount: 1,
      }),
    );
    const creation = busy.names.filter((n) =>
      /creation|scene3d|_3d_|gltf|rig_/.test(n) && !CORE_TOOL_NAMES.has(n),
    );
    expect(creation).toEqual([]);
  });

  it("exposes the editing domains without truncation on a typical project", () => {
    const typical = selectToolsForState(
      state({
        hasProject: true,
        mediaCount: 3,
        clipCount: 4,
        videoTrackCount: 1,
        hasAudio: true,
        selectedClipCount: 1,
      }),
    );
    expect(typical.truncated).toBe(false);
    const domains = domainsOf(typical.names);
    for (const expected of ["clip", "audio", "effect", "transition", "export"]) {
      expect(domains.has(expected)).toBe(true);
    }
  });

  it("never exceeds the cap and always keeps the core", () => {
    const busy = selectToolsForState(
      state({
        hasProject: true,
        mediaCount: 10,
        clipCount: 20,
        videoTrackCount: 3,
        hasAudio: true,
        hasSubtitles: true,
        selectedClipCount: 1,
        hasTextSelection: true,
        hasShapeSelection: true,
        hasMotionComposition: true,
      }),
    );
    expect(busy.names.length).toBeLessThanOrEqual(MAX_EXPOSED_TOOLS);
    expect(busy.truncated).toBe(true);
    const exposed = new Set(busy.names);
    for (const core of CORE_TOOL_NAMES) {
      if (getTool(core)) expect(exposed.has(core)).toBe(true);
    }
  });

  it("explains every non-core tool it exposes", () => {
    const result = selectToolsForState(
      state({ hasProject: true, mediaCount: 2, clipCount: 2, hasAudio: true }),
    );
    for (const name of result.names) {
      if (CORE_TOOL_NAMES.has(name)) continue;
      expect(result.reasons[name]).toBeTruthy();
    }
    expect(Object.keys(result.reasons).every((n) => result.names.includes(n))).toBe(true);
  });

  it("is deterministic", () => {
    const input = state({ hasProject: true, clipCount: 4, hasAudio: true });
    expect(selectToolsForState(input).names).toEqual(
      selectToolsForState(input).names,
    );
  });

  it("every selected name resolves in the registry", () => {
    const result = selectToolsForState(
      state({ hasProject: true, mediaCount: 1, clipCount: 3, hasAudio: true }),
    );
    for (const name of result.names) expect(getTool(name)).toBeDefined();
  });
});
