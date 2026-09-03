import { describe, it, expect } from "vitest";
import { listSubtitles } from "./serialize";
import type { Project } from "@openreel/core/types/project";

function projectWithSubtitles(
  subtitles: Array<{
    id: string;
    text: string;
    startTime: number;
    endTime: number;
    style?: { position?: "top" | "center" | "bottom"; color?: string };
  }>,
): Project {
  return {
    id: "p1",
    name: "Captioned",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    timeline: {
      duration: 30,
      subtitles,
      markers: [],
      tracks: [],
    },
    mediaLibrary: { items: [] },
  } as unknown as Project;
}

describe("listSubtitles", () => {
  it("returns cue text, timing, and style", () => {
    const view = listSubtitles(
      projectWithSubtitles([
        { id: "s1", text: "Hello", startTime: 0, endTime: 2, style: { position: "bottom", color: "#fff" } },
      ]),
    );
    expect(view).toEqual([
      { id: "s1", text: "Hello", startSec: 0, endSec: 2, position: "bottom", color: "#fff" },
    ]);
  });

  it("returns an empty list when there are no subtitles", () => {
    expect(listSubtitles(projectWithSubtitles([]))).toEqual([]);
  });

  it("filters by overlapping range", () => {
    const project = projectWithSubtitles([
      { id: "s1", text: "a", startTime: 0, endTime: 2 },
      { id: "s2", text: "b", startTime: 5, endTime: 7 },
      { id: "s3", text: "c", startTime: 10, endTime: 12 },
    ]);
    const view = listSubtitles(project, { fromSec: 4, toSec: 8 });
    expect(view.map((s) => s.id)).toEqual(["s2"]);
  });

  it("tolerates a timeline with no subtitles array", () => {
    const project = { timeline: { tracks: [] } } as unknown as Project;
    expect(listSubtitles(project)).toEqual([]);
  });
});
