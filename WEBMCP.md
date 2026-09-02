# OpenReel × WebMCP

**A professional browser video editor that agents can operate, with a tool surface derived from the timeline itself.**

Live: **https://openreel-webmcp.pages.dev** (Chrome 146+ with `chrome://flags` → *Experimental Web Platform Features* → Enabled)

> Built on OpenReel, my existing MIT-licensed browser video editor stack; the
> WebMCP agent surface in this submission is new work.

---

## What this is

OpenReel is a fully client-side video editor — multi-track timeline, WebGPU effects, WebCodecs export, Web Audio mixing. No uploads, no server-side rendering.

This submission makes the editor **operable by an agent** through WebMCP. An agent on the page reads timeline state, edits clips, mixes audio, drives the motion compositor, and exports — through the same tool registry, the same host, and the same undo history the human uses. Agent and human edit one canvas, and both see it update.

## Why WebMCP, specifically

Three properties of this project only work in-page. A server-side MCP could not deliver any of them:

**The tools are the editor, not an API wrapper.** The tool handlers call the live WebGPU renderer, the Web Audio graph, and the WebCodecs encoder in the tab. There is no backend to expose — the media never leaves the browser, so no server could reach it.

**Agent edits share the human's undo history.** Tool calls run through the same `LiveEditorHost` as the UI, serialized so an agent call and a human edit never interleave their transactions. Ctrl+Z undoes an agent's work like your own.

**The tool surface changes as the human works.** This is the part a server cannot imitate: a server publishes a fixed tool list at connect time, while a page can re-publish on every state change.

## The tool surface is derived from editor state

The registry holds **311 tools** — far more than any agent can hold in context, so something has to choose. OpenReel already had a router that picks tools by keyword against the user's message. But an agent arriving over WebMCP has no message. It has a *page*.

So the timeline does the choosing, and the surface breathes:

| Editor state | Tools exposed |
|---|---|
| Empty editor, no project | **22** |
| Project open | **50** |
| An audio track exists | **62** |
| Audio track removed | **58** |

Adding an audio track registers `set_clip_volume`, `set_clip_fade`, the audio-effect family, and the subtitle tools. Removing it retracts all twelve. Selecting a text clip reveals the text animators; deselecting retracts them. Every transition fires `toolchange`, so the agent's capabilities visibly track what is on screen.

Selection is a set of priority-ordered rules over tool domains (`webmcp-tool-selection.ts`), each carrying a human-readable reason. It is a pure function of editor state — deterministic and unit-tested against the real registry, so domain drift breaks the build rather than the demo.

One wrinkle worth naming: `motion` is 190 of the 311 tools, one domain holding real motion graphics, the 3D creation engine, and the text animators. Domain alone cannot separate them, so name patterns subdivide the bucket and the 3D creation family stays out of the default surface.

## Consent: the page owns it, because the browser doesn't

Probing Chrome 152 produced the finding that shaped the security design:

```
registeredAnnotations: {"readOnlyHint": false}
executedWithoutAnyPrompt: true      elapsedMs: 0
hasConsentApi: "none"
```

**Chrome does not gate WebMCP tool calls.** A tool annotated `readOnlyHint: false` executes immediately, and `ModelContext` exposes no consent API — only `registerTool`, `getTools`, `executeTool`, `ontoolchange`. The annotations are advisory metadata for the agent, not an enforcement boundary. A page cannot even observe whether the agent asked.

Since that layer is unobservable, it cannot be relied on. So:

- Every tool the registry marks **destructive** or **expensive** parks in a confirm store until a human answers in the editor. Read-only tools pass straight through.
- The adapter's default invoke **fails closed** — sensitive tools are refused unless a caller explicitly supplies a consent-gated invoke.
- An unanswered prompt **times out and rejects** rather than hanging the agent forever.
- Tools whose results carry content we did not author — imported filenames, SRT text, user captions — are annotated `untrustedContentHint: true`, per the spec's output-injection guidance.

## Chrome 152 vs. the documentation

Published examples are wrong for the shipping implementation. Verified empirically:

| | Docs & blogs | Chrome 152 |
|---|---|---|
| Namespace | `navigator.modelContext` | **`document.modelContext`** (`navigator` is absent) |
| Handler member | `handler` | **`execute`** (`handler` throws `TypeError`) |
| Older draft | `provideContext()` | does not exist |

Also load-bearing, and undocumented:

- `executeTool(tool, input)` requires `input` as a **JSON string** and resolves to a **JSON string** — passing an object rejects with *"Failed to parse input arguments."* The `execute` handler, however, receives a parsed object.
- `getTools()` returns each `inputSchema` as a JSON **string**, not an object.
- **Re-registering a live name rejects** with *"Duplicate tool name."* There is no `unregisterTool`; removal is via the `AbortController` passed at registration. A surface that changes therefore holds one controller per tool and diffs on every sync.
- Bulk registration is sequential, so a `getTools()` landing mid-sync legitimately sees a partial set.
- COOP `same-origin` + COEP `require-corp` (required here for ffmpeg.wasm) does **not** break WebMCP: `crossOriginIsolated` is `true` and every call behaves identically.

## Architecture

```
apps/web/src/services/agent/
  webmcp-adapter.ts             ModelContext adapter; per-tool AbortControllers; fails closed
  webmcp-tool-selection.ts      Pure state → tool-set rules (priority ordered, capped)
  webmcp-surface-controller.ts  Store subscriptions, debounce, re-entrancy guard, diffed sync
  webmcp-confirm-store.ts       Consent queue: park, approve, always-allow, timeout
  webmcp-install.ts             Wiring; no-op when the browser has no WebMCP
  mcp-listener.ts               Shared call core, also used by the desktop MCP bridge
apps/web/src/components/webmcp/
  WebMcpConfirmPrompt.tsx       The consent surface
```

The editor degrades cleanly: on browsers without WebMCP the install is inert and OpenReel behaves exactly as before.

## Running it

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm test         # 82 tests across the WebMCP surface
```

Then, in a WebMCP-enabled Chrome, inspect the live surface from the console:

```js
const tools = await document.modelContext.getTools();
tools.length;                      // grows as you build a project
tools.map(t => t.name);
```

## License

MIT, inherited from OpenReel — see [LICENSE](LICENSE). Copyright © 2024–2026 Augustus Otu and Contributors.
