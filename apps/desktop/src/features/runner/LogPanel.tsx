import type { LogLine } from "@rootray/shared";
import { useEffect, useRef } from "react";
import { stripAnsi } from "../../lib/format";

export function LogPanel({ logs }: { logs: LogLine[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

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

  return (
    <section className="logpanel">
      <div className="logpanel-head">
        <h2 className="section-title">Output</h2>
        <span className="meta">{logs.length} lines</span>
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
