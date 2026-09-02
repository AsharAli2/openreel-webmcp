import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type Listener = () => void;

const makeStore = <T,>(initial: T) => {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    getState: () => value,
    setState: (next: Partial<T>) => {
      value = { ...value, ...next };
      for (const l of [...listeners]) l();
    },
    subscribe: (l: Listener) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    listenerCount: () => listeners.size,
  };
};

const emptyProject = () => ({
  timeline: { tracks: [], subtitles: [], markers: [] },
  mediaLibrary: { items: [] },
  textClips: [],
  motionCompositions: [],
});

const h = vi.hoisted(() => ({
  project: null as unknown as ReturnType<typeof makeStore>,
  ui: null as unknown as ReturnType<typeof makeStore>,
  motion: null as unknown as ReturnType<typeof makeStore>,
}));

vi.mock("../../stores/project-store", () => ({
  get useProjectStore() {
    return h.project;
  },
}));
vi.mock("../../stores/ui-store", () => ({
  get useUIStore() {
    return h.ui;
  },
}));
vi.mock("../../motion/stores/motion-store", () => ({
  get useMotionStore() {
    return h.motion;
  },
}));

import {
  startSurfaceController,
  readEditorSurfaceState,
  SYNC_DEBOUNCE_MS,
} from "./webmcp-surface-controller";

const setup = (over: Record<string, unknown> = {}) => {
  h.project = makeStore({
    hasOpenProject: true,
    project: { ...emptyProject(), ...over },
  }) as never;
  h.ui = makeStore({
    selectedItems: [],
    getSelectedClipIds: () => [],
  }) as never;
  h.motion = makeStore({ activeCompositionId: null }) as never;
};

describe("readEditorSurfaceState", () => {
  it("reports an empty surface when no project is open", () => {
    setup();
    (h.project as never as { setState: (v: unknown) => void }).setState({
      hasOpenProject: false,
    });
    expect(readEditorSurfaceState().hasProject).toBe(false);
  });

  it("derives counts from the project", () => {
    setup({
      timeline: {
        tracks: [
          { type: "video", clips: [{ id: "c1" }, { id: "c2" }] },
          { type: "audio", clips: [{ id: "c3" }] },
        ],
        subtitles: [{ id: "s1" }],
        markers: [{ id: "m1" }],
      },
      mediaLibrary: { items: [{ type: "video" }, { type: "audio" }] },
    });
    const state = readEditorSurfaceState();
    expect(state).toMatchObject({
      hasProject: true,
      clipCount: 3,
      mediaCount: 2,
      videoTrackCount: 1,
      hasAudio: true,
      hasSubtitles: true,
      markerCount: 1,
    });
  });

  it("detects a text selection by clip id as well as by type", () => {
    setup({ textClips: [{ id: "t1" }] });
    (h.ui as never as { setState: (v: unknown) => void }).setState({
      selectedItems: [{ id: "t1", type: "clip" }],
      getSelectedClipIds: () => ["t1"],
    });
    expect(readEditorSurfaceState().hasTextSelection).toBe(true);
  });

  it("survives a project missing optional collections", () => {
    setup();
    (h.project as never as { setState: (v: unknown) => void }).setState({
      project: { timeline: { tracks: [] } },
    });
    expect(() => readEditorSurfaceState()).not.toThrow();
    expect(readEditorSurfaceState().mediaCount).toBe(0);
  });
});

describe("startSurfaceController", () => {
  let surface: { sync: ReturnType<typeof vi.fn>; calls: string[][] };

  beforeEach(() => {
    vi.useFakeTimers();
    setup();
    surface = {
      sync: vi.fn(async (names: Iterable<string>) => {
        surface.calls.push([...names]);
      }),
      calls: [],
    } as never;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes an initial surface without waiting for a change", async () => {
    const stop = startSurfaceController(surface as never);
    await vi.runAllTimersAsync();
    expect(surface.sync).toHaveBeenCalledTimes(1);
    expect(surface.calls[0].length).toBeGreaterThan(0);
    stop();
  });

  it("re-syncs and grows the surface when editor state changes", async () => {
    const stop = startSurfaceController(surface as never);
    await vi.runAllTimersAsync();
    const before = surface.calls[0].length;

    (h.project as never as { setState: (v: unknown) => void }).setState({
      project: {
        ...emptyProject(),
        timeline: {
          tracks: [{ type: "video", clips: [{ id: "a" }, { id: "b" }] }],
          subtitles: [],
          markers: [],
        },
        mediaLibrary: { items: [{ type: "video" }] },
      },
    });
    await vi.runAllTimersAsync();

    expect(surface.sync).toHaveBeenCalledTimes(2);
    expect(surface.calls[1].length).toBeGreaterThan(before);
    stop();
  });

  it("collapses a burst of store writes into one sync", async () => {
    const stop = startSurfaceController(surface as never);
    await vi.runAllTimersAsync();
    surface.sync.mockClear();

    const setState = (h.ui as never as { setState: (v: unknown) => void })
      .setState;
    for (let i = 0; i < 8; i += 1) setState({ selectedItems: [] });
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS * 2);

    // Eight writes, one debounced pass — and no sync at all since the
    // resulting tool set is identical.
    expect(surface.sync).not.toHaveBeenCalled();
    stop();
  });

  it("does not re-sync when the computed set is unchanged", async () => {
    const stop = startSurfaceController(surface as never);
    await vi.runAllTimersAsync();
    surface.sync.mockClear();
    (h.motion as never as { setState: (v: unknown) => void }).setState({
      activeCompositionId: "irrelevant",
    });
    await vi.runAllTimersAsync();
    expect(surface.sync).not.toHaveBeenCalled();
    stop();
  });

  it("reports each applied sync", async () => {
    const onSync = vi.fn();
    const stop = startSurfaceController(surface as never, { onSync });
    await vi.runAllTimersAsync();
    expect(onSync).toHaveBeenCalledTimes(1);
    const [selection, state] = onSync.mock.calls[0];
    expect(selection.names.length).toBeGreaterThan(0);
    expect(state.hasProject).toBe(true);
    stop();
  });

  it("stops listening and syncing after teardown", async () => {
    const stop = startSurfaceController(surface as never);
    await vi.runAllTimersAsync();
    surface.sync.mockClear();
    stop();

    (h.project as never as { setState: (v: unknown) => void }).setState({
      project: {
        ...emptyProject(),
        mediaLibrary: { items: [{ type: "video" }] },
      },
    });
    await vi.runAllTimersAsync();
    expect(surface.sync).not.toHaveBeenCalled();
    expect(
      (h.project as never as { listenerCount: () => number }).listenerCount(),
    ).toBe(0);
  });
});
