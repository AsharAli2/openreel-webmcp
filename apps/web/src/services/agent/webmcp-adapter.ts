import { getTool, type ToolDef, type ToolResult } from "@openreel/agent";
import { callToolForBridge } from "./mcp-listener";

/**
 * Minimal structural type for the WebMCP entry point.
 *
 * Verified against Chrome 152 (Experimental Web Platform Features): the object
 * lives on `document.modelContext`, NOT `navigator.modelContext`, and the
 * handler member is `execute`, NOT `handler`. `navigator` is probed first only
 * so a future Chrome that relocates the namespace keeps working.
 */
export interface ModelContextLike {
  registerTool(
    tool: WebMcpToolDescriptor,
    options?: { signal?: AbortSignal; exposedTo?: readonly string[] },
  ): Promise<void> | void;
  getTools(options?: {
    fromOrigins?: readonly string[];
  }): Promise<ReadonlyArray<{ name: string }>>;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface WebMcpAnnotations {
  readonly readOnlyHint?: boolean;
  readonly untrustedContentHint?: boolean;
}

export interface WebMcpToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: WebMcpAnnotations;
  /**
   * Receives a PARSED object. (Callers of `modelContext.executeTool` must pass
   * a JSON string and get a JSON string back, but that marshalling happens on
   * the agent side of the boundary, not here.)
   */
  execute(
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

type ModelContextCarrier = {
  modelContext?: ModelContextLike;
};

/** Returns the live ModelContext, or null when WebMCP is unavailable. */
export function getModelContext(): ModelContextLike | null {
  if (typeof document === "undefined") return null;
  const fromDocument = (document as unknown as ModelContextCarrier).modelContext;
  if (fromDocument) return fromDocument;
  const fromNavigator =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as unknown as ModelContextCarrier).modelContext;
  return fromNavigator ?? null;
}

export function isWebMcpAvailable(): boolean {
  return getModelContext() !== null;
}

/**
 * Tool domains whose results embed content we did not author — media filenames,
 * imported subtitle text, user-entered captions. Flagged so an agent applies
 * extra scrutiny before acting on what comes back, per the WebMCP spec's
 * output-injection guidance.
 */
const UNTRUSTED_CONTENT_DOMAINS = new Set<ToolDef["domain"]>([
  "media",
  "subtitle",
  "text",
  "read",
]);

/**
 * Tool results must be JSON-serializable and travel through the agent's context
 * window. `render_motion_frame` and friends return a data URL that can be
 * megabytes at 4K, so oversized images are dropped with a note rather than
 * blowing up the channel.
 */
const MAX_IMAGE_DATA_URL_CHARS = 200_000;

/** Backoff before retrying a registration that hit a still-settling abort. */
const DUPLICATE_RETRY_MS = 25;

function sanitizeResult(result: ToolResult): unknown {
  const image = result.image;
  if (image && image.dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) {
    const { image: _dropped, ...rest } = result;
    return {
      ...rest,
      imageOmitted: `Rendered image omitted (${image.dataUrl.length} chars exceeds the ${MAX_IMAGE_DATA_URL_CHARS} transport limit).`,
    };
  }
  return result;
}

export function toWebMcpDescriptor(
  def: ToolDef,
  invoke: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
): WebMcpToolDescriptor {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: def.inputSchema as Record<string, unknown>,
    annotations: {
      readOnlyHint: def.readOnly,
      untrustedContentHint: UNTRUSTED_CONTENT_DOMAINS.has(def.domain),
    },
    execute: async (input) => sanitizeResult(await invoke(def.name, input ?? {})),
  };
}

export interface WebMcpSurfaceOptions {
  /**
   * Runs a tool. The default FAILS CLOSED: destructive and expensive tools are
   * refused outright, because Chrome does not gate WebMCP calls itself — a tool
   * with `readOnlyHint: false` executes with no prompt and ModelContext exposes
   * no consent API. Callers that can actually ask a human (see
   * `installWebMcpSurface`) pass a gated invoke instead.
   */
  readonly invoke?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
  readonly onError?: (name: string, error: unknown) => void;
}

const defaultInvoke = (name: string, args: Record<string, unknown>) =>
  callToolForBridge(name, args, { allowSensitive: false });

/**
 * Owns the set of tools currently exposed to agents on this page.
 *
 * WebMCP has no `unregisterTool`: removal happens by aborting the signal passed
 * at registration, and re-registering a live name rejects with "Duplicate tool
 * name". So the surface holds one AbortController per tool and diffs on every
 * sync, which is also what makes a tool set that tracks editor state possible.
 */
export class WebMcpToolSurface {
  private readonly controllers = new Map<string, AbortController>();
  private disposed = false;
  private readonly invoke: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
  private readonly onError: (name: string, error: unknown) => void;

  constructor(
    private readonly modelContext: ModelContextLike,
    options: WebMcpSurfaceOptions = {},
  ) {
    this.invoke = options.invoke ?? defaultInvoke;
    this.onError =
      options.onError ??
      ((name, error) =>
        console.warn(`[webmcp] tool '${name}' failed to register`, error));
  }

  /** Names currently registered with the browser. */
  exposed(): string[] {
    return [...this.controllers.keys()].sort();
  }

  private async add(name: string): Promise<void> {
    if (this.disposed) return;
    const def = getTool(name);
    if (!def) {
      this.onError(name, new Error(`No tool named '${name}' in the registry`));
      return;
    }
    const descriptor = toWebMcpDescriptor(def, this.invoke);

    // A prior abort can still be settling when the same name comes straight
    // back — React StrictMode remounts do exactly this — and WebMCP rejects a
    // live name with "Duplicate tool name". Retry once after a tick.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      try {
        await this.modelContext.registerTool(descriptor, {
          signal: controller.signal,
        });
        if (this.disposed) {
          controller.abort();
          return;
        }
        this.controllers.set(name, controller);
        return;
      } catch (error) {
        const duplicate = /duplicate tool name/i.test(
          error instanceof Error ? error.message : String(error),
        );
        if (!duplicate || attempt === 1) {
          this.onError(name, error);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, DUPLICATE_RETRY_MS));
        if (this.disposed) return;
      }
    }
  }

  private remove(name: string): void {
    this.controllers.get(name)?.abort();
    this.controllers.delete(name);
  }

  /**
   * Makes the exposed set exactly `desired`, registering and retracting the
   * difference. Retractions are applied before additions so a name can move
   * between syncs without tripping the duplicate-name rejection.
   */
  async sync(desired: Iterable<string>): Promise<void> {
    const target = new Set(desired);
    for (const name of [...this.controllers.keys()]) {
      if (!target.has(name)) this.remove(name);
    }
    const additions = [...target].filter((name) => !this.controllers.has(name));
    for (const name of additions) {
      if (this.disposed) return;
      await this.add(name);
    }
  }

  /** Retracts every tool this surface registered. Terminal — do not reuse. */
  dispose(): void {
    this.disposed = true;
    for (const name of [...this.controllers.keys()]) this.remove(name);
  }
}

/**
 * Creates a surface if the browser supports WebMCP. Returns null otherwise, so
 * callers degrade to a normal editor with no agent surface.
 */
export function createWebMcpSurface(
  options: WebMcpSurfaceOptions = {},
): WebMcpToolSurface | null {
  const modelContext = getModelContext();
  return modelContext ? new WebMcpToolSurface(modelContext, options) : null;
}
