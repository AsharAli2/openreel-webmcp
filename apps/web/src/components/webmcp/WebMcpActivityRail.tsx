import { useMemo, useState, type JSX } from "react";
import { ToolcraftText as Text } from "@openreel/ui";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  ShieldOff,
  Sparkles,
  X,
} from "@/icons/lucide-compat";
import {
  groupExposedTools,
  useWebMcpActivityStore,
  type ToolCallRecord,
} from "../../services/agent/webmcp-activity-store";

/**
 * Shows what agents can currently do on this page, and what they just did.
 *
 * The tool surface lives inside `document.modelContext`, invisible to the person
 * using the editor, and it changes as they work. This makes that legible: the
 * exposed tools grouped by the editor state that put them there, plus a log of
 * recent calls including the ones a human refused.
 *
 * Renders nothing when the browser has no WebMCP support.
 */

function StatusIcon({ status }: { status: ToolCallRecord["status"] }): JSX.Element {
  if (status === "running")
    return <Loader2 size={11} className="animate-spin text-fg-2" />;
  if (status === "ok") return <Check size={11} className="text-status-success" />;
  if (status === "refused")
    return <ShieldOff size={11} className="text-status-warning" />;
  return <X size={11} className="text-status-error" />;
}

function CallRow({ call }: { call: ToolCallRecord }): JSX.Element {
  const detail =
    call.status === "refused"
      ? "refused"
      : call.status === "running"
        ? "running…"
        : (call.summary ?? call.errorCode ?? "");

  return (
    <li className="flex items-baseline gap-1.5 py-0.5">
      <span className="mt-0.5 shrink-0">
        <StatusIcon status={call.status} />
      </span>
      <span className="shrink-0 font-mono text-[10px] text-fg">{call.name}</span>
      <span className="truncate text-[10px] text-fg-2" title={detail}>
        {detail}
      </span>
      {call.durationMs !== undefined && (
        <span className="ml-auto shrink-0 font-mono text-[9px] text-fg-2">
          {call.durationMs}ms
        </span>
      )}
    </li>
  );
}

export function WebMcpActivityRail(): JSX.Element | null {
  const available = useWebMcpActivityStore((state) => state.available);
  const exposed = useWebMcpActivityStore((state) => state.exposed);
  const reasons = useWebMcpActivityStore((state) => state.reasons);
  const activeRules = useWebMcpActivityStore((state) => state.activeRules);
  const truncated = useWebMcpActivityStore((state) => state.truncated);
  const calls = useWebMcpActivityStore((state) => state.calls);
  const [collapsed, setCollapsed] = useState(false);

  const groups = useMemo(
    () => groupExposedTools(exposed, reasons, activeRules),
    [exposed, reasons, activeRules],
  );

  if (!available) return null;

  return (
    <div className="fixed bottom-4 left-4 z-40 w-[268px] overflow-hidden rounded-lg border border-border bg-bg/95 shadow-lg backdrop-blur">
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left hover:bg-hover"
      >
        <Sparkles size={12} className="text-accent" />
        <span className="text-[11px] font-medium text-fg">
          {exposed.length} tools exposed
        </span>
        <span className="ml-auto text-fg-2">
          {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </button>

      {!collapsed && (
        <div className="border-t border-border px-2.5 pb-2.5 pt-2">
          <ul className="mb-2">
            {groups.map((group) => (
              <li
                key={group.label}
                className="flex items-baseline gap-2 py-0.5 text-[10px]"
                title={group.names.join(", ")}
              >
                <span className="truncate text-fg-2">{group.label}</span>
                <span className="ml-auto shrink-0 font-mono text-fg">
                  {group.count}
                </span>
              </li>
            ))}
          </ul>

          {truncated && (
            <Text
              type="supporting"
              color="secondary"
              className="mb-2 block text-[9px] text-fg-2"
            >
              Capped — lower-priority tools withheld.
            </Text>
          )}

          <div className="border-t border-border pt-1.5">
            {calls.length === 0 ? (
              <Text
                type="supporting"
                color="secondary"
                className="block py-1 text-[10px] text-fg-2"
              >
                No agent calls yet.
              </Text>
            ) : (
              <ul className="max-h-44 overflow-y-auto">
                {calls.map((call) => (
                  <CallRow key={call.id} call={call} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
