import {
  CORE_TOOL_NAMES,
  DEFAULT_AGENT_TOOL_LIMIT,
  listTools,
} from "@openreel/agent";
import type { ToolDomain } from "@openreel/agent";

/**
 * Derives the tool surface from what is actually on the timeline.
 *
 * The registry holds 311 tools, far more than any agent can hold in context, so
 * something has to choose. `selectToolsForPrompt` in the agent package picks by
 * keyword against the user's message; that only works when there IS a message.
 * An agent arriving over WebMCP has no prompt — it has a page. So here the
 * editor's own state does the choosing, and the exposed set changes as the human
 * works: import media and clip tools appear, add an audio track and mixing
 * tools appear, select a text clip and the text animators appear.
 *
 * This is the one thing a server-side MCP cannot do. A server publishes a fixed
 * tool list at connect time; a page can re-publish on every state change.
 */

/** A snapshot of everything the selection rules care about. */
export interface EditorSurfaceState {
  readonly hasProject: boolean;
  readonly mediaCount: number;
  readonly clipCount: number;
  readonly videoTrackCount: number;
  readonly hasAudio: boolean;
  readonly hasSubtitles: boolean;
  readonly markerCount: number;
  readonly selectedClipCount: number;
  readonly hasTextSelection: boolean;
  readonly hasShapeSelection: boolean;
  readonly hasMotionComposition: boolean;
}

export const EMPTY_SURFACE_STATE: EditorSurfaceState = {
  hasProject: false,
  mediaCount: 0,
  clipCount: 0,
  videoTrackCount: 0,
  hasAudio: false,
  hasSubtitles: false,
  markerCount: 0,
  selectedClipCount: 0,
  hasTextSelection: false,
  hasShapeSelection: false,
  hasMotionComposition: false,
};

/**
 * Ceiling on the live surface. Reuses the agent package's own provider budget
 * rather than inventing a second number. Only the motion family (190 tools) is
 * large enough to hit it; the editing domains together fit comfortably.
 */
export const MAX_EXPOSED_TOOLS = DEFAULT_AGENT_TOOL_LIMIT;

interface Rule {
  /** Human-readable reason, surfaced in the UI so the choice is legible. */
  readonly label: string;
  readonly domains: readonly ToolDomain[];
  readonly when: (state: EditorSurfaceState) => boolean;
  readonly include?: RegExp;
  readonly exclude?: RegExp;
}

/**
 * `motion` is 190 of the 311 tools — real motion graphics, the 3D "creation"
 * engine, and the text animators all share one domain. Domain alone cannot
 * separate them, so these patterns subdivide the bucket.
 */
const MOTION_TEXT_ANIMATORS = /text_(animator|shader)/;
const MOTION_CREATION = /creation|scene3d|_3d_|gltf|rig_/;

/**
 * Priority order. Earlier rules win a slot when the cap bites, so the tools
 * closest to what the human is doing right now survive.
 */
const RULES: readonly Rule[] = [
  {
    label: "a project is open",
    domains: ["project", "track", "marker"],
    when: (s) => s.hasProject,
  },
  {
    label: "a clip is selected",
    domains: ["transform", "speed", "clip"],
    when: (s) => s.selectedClipCount > 0,
  },
  {
    label: "a text clip is selected",
    domains: ["motion"],
    when: (s) => s.hasTextSelection,
    include: MOTION_TEXT_ANIMATORS,
  },
  {
    label: "the project has text",
    domains: ["text"],
    when: (s) => s.hasProject,
  },
  {
    label: "a shape or graphic is selected",
    domains: ["graphics"],
    when: (s) => s.hasShapeSelection,
  },
  {
    label: "the timeline has clips",
    domains: ["effect", "color", "keyframe"],
    when: (s) => s.clipCount > 0,
  },
  {
    label: "media has been imported",
    domains: ["media", "clip"],
    when: (s) => s.mediaCount > 0,
  },
  {
    label: "the project has audio",
    domains: ["audio"],
    when: (s) => s.hasAudio,
  },
  {
    label: "the timeline has more than one clip",
    domains: ["transition"],
    when: (s) => s.clipCount > 1,
  },
  {
    label: "subtitles or audio are present",
    domains: ["subtitle"],
    when: (s) => s.hasSubtitles || s.hasAudio,
  },
  {
    label: "the project has graphics",
    domains: ["graphics"],
    when: (s) => s.hasProject,
  },
  {
    label: "the timeline has something to export",
    domains: ["export"],
    when: (s) => s.clipCount > 0,
  },
  {
    label: "the project has multiple video tracks",
    domains: ["multicam"],
    when: (s) => s.videoTrackCount > 1,
  },
  {
    label: "a motion composition exists",
    domains: ["motion"],
    when: (s) => s.hasMotionComposition,
    exclude: MOTION_CREATION,
  },
];

export interface SelectionResult {
  readonly names: readonly string[];
  /** Why each non-core tool is exposed, for the activity rail. */
  readonly reasons: Readonly<Record<string, string>>;
  /** Rules that fired, in priority order. */
  readonly activeRules: readonly string[];
  /** True when the cap forced tools out of the surface. */
  readonly truncated: boolean;
}

const CORE_PRIORITY = -1;

/**
 * Chooses the tools to expose for a given editor state. Pure: no store reads,
 * no registry mutation, same input always yields the same surface.
 */
export function selectToolsForState(
  state: EditorSurfaceState,
  limit: number = MAX_EXPOSED_TOOLS,
): SelectionResult {
  const tools = listTools();
  const priority = new Map<string, number>();
  const reasons: Record<string, string> = {};
  const activeRules: string[] = [];

  for (const tool of tools) {
    if (CORE_TOOL_NAMES.has(tool.name)) priority.set(tool.name, CORE_PRIORITY);
  }

  RULES.forEach((rule, index) => {
    if (!rule.when(state)) return;
    activeRules.push(rule.label);
    for (const tool of tools) {
      if (priority.has(tool.name)) continue;
      if (!rule.domains.includes(tool.domain)) continue;
      if (rule.include && !rule.include.test(tool.name)) continue;
      if (rule.exclude && rule.exclude.test(tool.name)) continue;
      priority.set(tool.name, index);
      reasons[tool.name] = rule.label;
    }
  });

  const readOnly = new Map(tools.map((tool) => [tool.name, tool.readOnly]));
  const ordered = [...priority.entries()]
    .sort((a, b) => {
      if (a[1] !== b[1]) return a[1] - b[1];
      const roA = readOnly.get(a[0]) ? 0 : 1;
      const roB = readOnly.get(b[0]) ? 0 : 1;
      if (roA !== roB) return roA - roB;
      return a[0].localeCompare(b[0]);
    })
    .map(([name]) => name);

  const names = ordered.slice(0, Math.max(limit, 0));
  const kept = new Set(names);
  for (const name of Object.keys(reasons)) {
    if (!kept.has(name)) delete reasons[name];
  }

  return {
    names,
    reasons,
    activeRules,
    truncated: ordered.length > names.length,
  };
}
