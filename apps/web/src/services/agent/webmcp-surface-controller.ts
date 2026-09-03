import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { useMotionStore } from "../../motion/stores/motion-store";
import type { WebMcpToolSurface } from "./webmcp-adapter";
import {
  EMPTY_SURFACE_STATE,
  selectToolsForState,
  type EditorSurfaceState,
  type SelectionResult,
} from "./webmcp-tool-selection";

/**
 * Keeps the exposed tool surface in step with the editor.
 *
 * Every store change recomputes the desired set and diffs it against what is
 * registered, so `toolchange` fires as the human works and an agent always sees
 * the tools that match what is actually on screen.
 */

/** Collapses bursts of store writes — a drag emits many — into one sync. */
export const SYNC_DEBOUNCE_MS = 120;

export function readEditorSurfaceState(): EditorSurfaceState {
  const projectState = useProjectStore.getState();
  if (!projectState.hasOpenProject) return EMPTY_SURFACE_STATE;

  const project = projectState.project;
  const tracks = project.timeline?.tracks ?? [];
  const clipCount = tracks.reduce(
    (total, track) => total + (track.clips?.length ?? 0),
    0,
  );
  const media = project.mediaLibrary?.items ?? [];
  const selectedItems = useUIStore.getState().selectedItems ?? [];
  const textClipIds = new Set((project.textClips ?? []).map((clip) => clip.id));

  const hasAudio =
    tracks.some((track) => track.type === "audio") ||
    media.some((item) => item.type === "audio");

  return {
    hasProject: true,
    mediaCount: media.length,
    clipCount,
    videoTrackCount: tracks.filter((track) => track.type === "video").length,
    hasAudio,
    hasSubtitles: (project.timeline?.subtitles ?? []).length > 0,
    markerCount: (project.timeline?.markers ?? []).length,
    selectedClipCount: useUIStore.getState().getSelectedClipIds().length,
    hasTextSelection: selectedItems.some(
      (item) => item.type === "text-clip" || textClipIds.has(item.id),
    ),
    hasShapeSelection: selectedItems.some((item) => item.type === "shape-clip"),
    hasMotionComposition: (project.motionCompositions ?? []).length > 0,
    hasMulticamGroups: (project.multicamGroups ?? []).length > 0,
  };
}

export interface SurfaceControllerOptions {
  /** Fired after every applied sync, for the activity rail. */
  readonly onSync?: (
    selection: SelectionResult,
    state: EditorSurfaceState,
  ) => void;
}

/**
 * Starts tracking editor state. Returns a teardown that stops listening; the
 * caller still owns disposing the surface itself.
 */
export function startSurfaceController(
  surface: WebMcpToolSurface,
  options: SurfaceControllerOptions = {},
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let syncing = false;
  let queuedAgain = false;
  let lastKey = "";

  const applyNow = async (): Promise<void> => {
    if (stopped) return;
    if (syncing) {
      // A store write landed mid-sync; fold it into one follow-up pass.
      queuedAgain = true;
      return;
    }
    syncing = true;
    try {
      const state = readEditorSurfaceState();
      const selection = selectToolsForState(state);
      const key = selection.names.join("|");
      if (key !== lastKey) {
        await surface.sync(selection.names);
        lastKey = key;
      }
      if (!stopped) options.onSync?.(selection, state);
    } finally {
      syncing = false;
      if (queuedAgain && !stopped) {
        queuedAgain = false;
        void applyNow();
      }
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void applyNow();
    }, SYNC_DEBOUNCE_MS);
  };

  const unsubscribes = [
    useProjectStore.subscribe(schedule),
    useUIStore.subscribe(schedule),
    useMotionStore.subscribe(schedule),
  ];

  // Publish the initial surface immediately rather than waiting for a change.
  void applyNow();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
