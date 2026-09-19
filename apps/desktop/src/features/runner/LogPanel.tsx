import type { LogLine } from "@rootray/shared";
import { useEffect, useRef } from "react";
import { ChevronDownIcon, ChevronUpIcon, ClearIcon } from "../../components/icons";
import { Splitter } from "../../components/Splitter";
import { stripAnsi } from "../../lib/format";
import { OUTPUT_MAX, OUTPUT_MIN } from "../../state/layout";
import { useStore } from "../../state/store";

/**
 * Output/log panel — resizable via its top edge and collapsible to a
 * slim header bar. Logs stay in state while collapsed; stderr traffic
 * flags the bar so a folded panel still signals errors.
 */
export function LogPanel({
  logs,
  onCover,
}: {
  logs: LogLine[];
  /** Hide the native preview surface while the height drag runs. */
  onCover?: (covered: boolean) => void;
}) {
  const { state, dispatch } = useStore();
  const layout = state.layout;
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // Drag deltas are absolute since drag start — apply to this base.
  const heightBase = useRef(170);

  // biome-ignore lint/correctness/useExhaustiveDependencies: logs is a scroll trigger, refs are stable
  useEffect(() => {
    if (stickToBottom.current) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [logs]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const errCount = logs.reduce((n, l) => n + (l.stream === "stderr" ? 1 : 0), 0);
  const meta = (
    <span className="meta">
      {errCount > 0 && (
        <span className="logpanel-errflag">
          {errCount} error{errCount === 1 ? "" : "s"} ·{" "}
        </span>
      )}
      {logs.length} lines
    </span>
  );

  if (!layout.outputVisible) {
    return (
      <section className="logpanel collapsed" data-testid="logpanel">
        <div className="logpanel-head">
          <h2 className="section-title">Output</h2>
          {meta}
          <span className="logpanel-head-spacer" />
          <button
            type="button"
            className="icon-btn"
            aria-label="Expand output (Ctrl+J)"
            title="Expand output (Ctrl+J)"
            onClick={() => dispatch({ type: "layout-update", patch: { outputVisible: true } })}
          >
            <ChevronUpIcon />
          </button>
        </div>
      </section>
    );
  }

  const setHeight = (h: number) => dispatch({ type: "layout-update", patch: { outputHeight: h } });

  return (
    <section className="logpanel" style={{ height: layout.outputHeight }} data-testid="logpanel">
      <Splitter
        orientation="horizontal"
        label="Output height"
        valueNow={layout.outputHeight}
        valueMin={OUTPUT_MIN}
        valueMax={OUTPUT_MAX}
        onDelta={(d) => setHeight(heightBase.current - d)}
        onDragState={(d) => {
          if (d) heightBase.current = layout.outputHeight;
          onCover?.(d);
        }}
        onNudge={(d) => setHeight(layout.outputHeight - d)}
        onReset={() => setHeight(170)}
      />
      <div className="logpanel-head">
        <h2 className="section-title">Output</h2>
        {meta}
        <span className="logpanel-head-spacer" />
        <button
          type="button"
          className="icon-btn"
          aria-label="Clear logs"
          title="Clear logs"
          onClick={() => dispatch({ type: "logs-cleared" })}
        >
          <ClearIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Collapse output (Ctrl+J)"
          title="Collapse output (Ctrl+J)"
          onClick={() => dispatch({ type: "layout-update", patch: { outputVisible: false } })}
        >
          <ChevronDownIcon />
        </button>
      </div>
      <div className="logbox" ref={boxRef} onScroll={onScroll}>
        {logs.length === 0 ? (
          <div className="muted log-empty">Waiting for server output…</div>
        ) : (
          logs.map((l, i) => (
            <div key={`${l.at}-${i}`} className={`log-line log-${l.stream}`}>
              <span className="log-stream">{l.stream === "stderr" ? "!" : "›"}</span>
              <span className="log-text">{stripAnsi(l.line)}</span>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
}
