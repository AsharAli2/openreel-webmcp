import { describe, expect, it } from "vitest";
import { whisperChunksToMulticamTranscript } from "./multicam-transcription";

describe("multicam transcription", () => {
  it("normalizes Whisper timestamps and removes empty chunks", () => {
    expect(whisperChunksToMulticamTranscript([
      { text: " Hello ", timestamp: [0.25, 1.5] },
      { text: "  ", timestamp: [1.5, 2] },
      { text: "world", timestamp: [2, null] },
    ])).toEqual([
      { text: "Hello", startMs: 250, endMs: 1_500 },
      { text: "world", startMs: 2_000, endMs: 5_000 },
    ]);
  });
});
