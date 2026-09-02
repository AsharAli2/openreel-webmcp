import type { JSX } from "react";
import { ToolcraftButton as Button, ToolcraftText as Text } from "@openreel/ui";
import { AlertTriangle, Zap } from "@/icons/lucide-compat";
import { useWebMcpConfirmStore } from "../../services/agent/webmcp-confirm-store";

/**
 * Consent surface for agent tool calls arriving over WebMCP.
 *
 * Chrome does not prompt for these — a tool marked `readOnlyHint: false` runs
 * with no confirmation — so this is the only thing standing between an agent on
 * the page and a destructive edit. Rendered app-wide rather than inside the
 * chat panel because the caller is an external agent, not the chat.
 */
export function WebMcpConfirmPrompt(): JSX.Element | null {
  const queue = useWebMcpConfirmStore((state) => state.queue);
  const resolve = useWebMcpConfirmStore((state) => state.resolve);
  const request = queue[0];
  if (!request) return null;

  const argKeys = Object.keys(request.args ?? {});
  const reason = request.destructive
    ? "can modify or delete parts of your project"
    : "can take significant time or cost";

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[340px] rounded-lg border border-status-warning/40 bg-bg p-3 text-[12px] shadow-lg">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-fg">
        {request.destructive ? (
          <AlertTriangle size={13} className="text-status-warning" />
        ) : (
          <Zap size={13} className="text-status-warning" />
        )}
        Agent wants to run a tool
        {queue.length > 1 && (
          <span className="ml-auto text-[10px] font-normal text-fg-2">
            +{queue.length - 1} waiting
          </span>
        )}
      </div>
      <Text type="supporting" color="secondary" className="mb-2 block text-fg-2">
        <span className="font-mono text-fg">{request.name}</span> {reason}.
      </Text>
      {argKeys.length > 0 && (
        <pre className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-bg-2 p-1.5 font-mono text-[10px] text-fg-2">
          {JSON.stringify(request.args, null, 2)}
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          label="Approve"
          variant="primary"
          size="sm"
          onClick={() => resolve(request.id, "approve")}
          className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-fg hover:bg-accent/90"
        />
        <Button
          label="Always allow this tool"
          variant="secondary"
          size="sm"
          onClick={() => resolve(request.id, "approve_for_turn")}
          className="rounded-md bg-bg-2 px-2.5 py-1 text-[11px] font-medium text-fg-2 hover:bg-hover"
        />
        <Button
          label="Reject"
          variant="destructive"
          size="sm"
          onClick={() => resolve(request.id, "reject")}
          className="rounded-md px-2.5 py-1 text-[11px] font-medium text-status-error hover:bg-status-error/10"
        />
      </div>
    </div>
  );
}
