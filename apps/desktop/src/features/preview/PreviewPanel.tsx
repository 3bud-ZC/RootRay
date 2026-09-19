/**
 * Embedded project preview — the browser toolbar and the layout rect the
 * native child webview is pinned to.
 *
 * The preview itself is NOT a DOM element: it's a WebView2 child surface
 * positioned by `preview_set_bounds`. The `.preview-host` div below is
 * only a placeholder we measure — ResizeObserver + rAF pushes bounds to
 * the native side, and the surface hides whenever a React overlay or a
 * pane-drag needs its pixels.
 */

import { errorMessage, isLoopbackUrl } from "@rootray/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrandLoader } from "../../components/BrandLoader";
import { BackIcon, CloseIcon, FocusIcon, ForwardIcon, ReloadIcon } from "../../components/icons";
import { Splitter } from "../../components/Splitter";
import {
  openBrowser,
  type PreviewRect,
  previewBack,
  previewForward,
  previewNavigate,
  previewReload,
  setInspection,
} from "../../lib/ipc";
import { CODE_MIN_PX, LAYOUT_DEFAULTS, PREVIEW_MIN_PX } from "../../state/layout";
import { useStore } from "../../state/store";
import { quickEdit } from "../editor/controller";
import {
  createPreview,
  hidePreview,
  reportPreviewRect,
  showPreview,
  syncBounds,
} from "./controller";

const PHASE_LABEL: Record<string, string> = {
  hidden: "Off",
  waiting: "Waiting",
  loading: "Loading",
  ready: "Connected",
  error: "Error",
  stopped: "Stopped",
};

export function PreviewPanel({
  covered,
  onCover,
  tab,
  onTab,
  children,
}: {
  /** A modal/palette/drag owns the preview's pixels right now. */
  covered: boolean;
  /** Split-divider drags also need the surface covered. */
  onCover?: (covered: boolean) => void;
  tab: "preview" | "code" | "split";
  onTab: (t: "preview" | "code" | "split") => void;
  /** The code pane — rendered beside the host in Split, alone in Code. */
  children?: React.ReactNode;
}) {
  const { state, dispatch } = useStore();
  const { runtime, inspector, preview, autoPreview, layout } = state;
  const hostRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastSent = useRef<PreviewRect | null>(null);
  const createInFlight = useRef(false);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [inspectBusy, setInspectBusy] = useState(false);
  const ratioBase = useRef(LAYOUT_DEFAULTS.splitRatio);

  const focusMode = layout.focusMode;
  const focused = focusMode !== "none";
  // Focus modes force the rendered tab without touching workspaceTab —
  // leaving focus restores exactly what the user had before.
  const effTab = focusMode === "preview" ? "preview" : focusMode === "code" ? "code" : tab;

  const running = runtime.phase === "running";
  const url = preview.url ?? runtime.url;
  const urlSafe = url ? isLoopbackUrl(url) : false;
  // A live surface exists while the preview is waiting/loading/ready —
  // stopped/error/hidden mean there is nothing to position or show.
  const surfaceAlive =
    preview.phase === "waiting" || preview.phase === "loading" || preview.phase === "ready";
  const hostVisible = effTab !== "code" && !covered;
  const inspectable = inspector.phase === "connected" || inspector.phase === "inspecting";
  const inspecting = inspector.inspectionEnabled;

  // --- surface creation -------------------------------------------------
  // The store marks `waiting` when the runtime starts; once a URL exists
  // the host rect is measured here and the native surface is created —
  // automatically when the preference allows, else on explicit request.
  const wantsSurface = urlSafe && (preview.phase === "waiting" || preview.phase === "hidden");
  const tryCreate = useCallback(
    (rectOverride?: PreviewRect) => {
      // The rect can come from an override, the last pushed bounds, or a
      // synchronous host measure — the URL can legitimately arrive before
      // the first ResizeObserver→rAF tick resolves, and nothing re-runs
      // this effect after that tick, so a missing rect must not be fatal.
      const hostRect = hostRef.current?.getBoundingClientRect();
      const rect: PreviewRect | null =
        rectOverride ??
        lastSent.current ??
        (hostRect && hostRect.width > 0 && hostRect.height > 0
          ? { x: hostRect.x, y: hostRect.y, width: hostRect.width, height: hostRect.height }
          : null);
      if (!url || !urlSafe || !rect || createInFlight.current) return;
      reportPreviewRect(rect);
      createInFlight.current = true;
      createPreview(url, rect)
        .catch((e) => dispatch({ type: "notice", message: errorMessage(e) }))
        .finally(() => {
          createInFlight.current = false;
        });
    },
    [url, urlSafe, dispatch],
  );

  useEffect(() => {
    if (wantsSurface && autoPreview && effTab !== "code") tryCreate();
  }, [wantsSurface, autoPreview, effTab, tryCreate]);

  // --- bounds sync --------------------------------------------------------
  // ResizeObserver → rAF → set_bounds, only when the rect actually moved.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || effTab === "code") return;
    let raf = 0;
    const measure = () => {
      const r = host.getBoundingClientRect();
      const rect: PreviewRect = { x: r.x, y: r.y, width: r.width, height: r.height };
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        syncBounds(rect, lastSent.current)
          .then((sent) => {
            lastSent.current = sent;
          })
          .catch(() => {});
      });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    measure();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      reportPreviewRect(null);
    };
  }, [effTab]);

  // --- visibility ---------------------------------------------------------
  // The native surface must not float over React overlays or linger when
  // the Code tab takes its place. Hidden surfaces keep their state.
  useEffect(() => {
    if (!surfaceAlive) return;
    if (hostVisible) showPreview();
    else hidePreview();
  }, [hostVisible, surfaceAlive]);

  // Surface gone → forget the last-sent rect so the next create positions
  // from scratch.
  useEffect(() => {
    if (!surfaceAlive) lastSent.current = null;
  }, [surfaceAlive]);

  const nav = (fn: () => Promise<void>) => {
    fn().catch((e) => dispatch({ type: "notice", message: errorMessage(e) }));
  };

  const submitUrl = () => {
    if (urlDraft === null) return;
    const target = urlDraft.trim();
    setUrlDraft(null);
    if (!target || target === url) return;
    if (!isLoopbackUrl(target)) {
      dispatch({
        type: "notice",
        message: "The preview only navigates to local dev URLs (localhost / 127.0.0.1).",
      });
      return;
    }
    previewNavigate(target).catch((e) => dispatch({ type: "notice", message: errorMessage(e) }));
  };

  const toggleInspect = async () => {
    setInspectBusy(true);
    try {
      await setInspection(!inspecting);
    } catch (e) {
      dispatch({ type: "notice", message: errorMessage(e) });
    } finally {
      setInspectBusy(false);
    }
  };

  const openExternal = () => {
    if (!url || !urlSafe) return;
    openBrowser(url).catch((e) => dispatch({ type: "notice", message: errorMessage(e) }));
  };

  const overlay = (() => {
    if (!running && preview.phase !== "stopped" && preview.phase !== "error") return null;
    switch (preview.phase) {
      case "waiting":
        return url && !autoPreview ? (
          <div className="preview-overlay">
            <p className="muted">Preview is off.</p>
            <button type="button" className="btn btn-primary" onClick={() => tryCreate()}>
              Show Preview
            </button>
          </div>
        ) : (
          <div className="preview-overlay">
            <BrandLoader label="Waiting for dev server…" />
          </div>
        );
      case "loading":
        return (
          <div className="preview-overlay">
            <BrandLoader label="Loading preview…" />
          </div>
        );
      case "error":
        return (
          <div className="preview-overlay">
            <p className="bad">Preview error</p>
            <p className="muted">{preview.error ?? "The embedded preview failed."}</p>
            <div className="preview-overlay-actions">
              {url && (
                <button type="button" className="btn" onClick={() => tryCreate()}>
                  Retry
                </button>
              )}
              {urlSafe && (
                <button type="button" className="btn" onClick={openExternal}>
                  Open External
                </button>
              )}
            </div>
          </div>
        );
      case "stopped":
        return (
          <div className="preview-overlay">
            <p className="muted">Server stopped — the preview is closed.</p>
          </div>
        );
      case "hidden":
        return url ? (
          <div className="preview-overlay">
            <p className="muted">Preview is off.</p>
            <button type="button" className="btn btn-primary" onClick={() => tryCreate()}>
              Show Preview
            </button>
          </div>
        ) : null;
      default:
        return null;
    }
  })();

  return (
    <section className="preview-panel" aria-label="Project preview">
      <div className="preview-toolbar">
        <button
          type="button"
          className="icon-btn"
          aria-label="Back"
          title="Back"
          disabled={!surfaceAlive}
          onClick={() => nav(previewBack)}
        >
          <BackIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Forward"
          title="Forward"
          disabled={!surfaceAlive}
          onClick={() => nav(previewForward)}
        >
          <ForwardIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Reload"
          title="Reload"
          disabled={!surfaceAlive}
          onClick={() => nav(previewReload)}
        >
          <ReloadIcon />
        </button>
        <input
          className="preview-url"
          aria-label="Preview URL"
          title="Local dev URL — Enter to navigate"
          value={urlDraft ?? url ?? ""}
          placeholder={running ? "waiting for URL…" : "no URL"}
          spellCheck={false}
          disabled={!surfaceAlive}
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitUrl();
            if (e.key === "Escape") setUrlDraft(null);
          }}
          onBlur={() => setUrlDraft(null)}
        />
        <span className={`preview-phase preview-phase-${preview.phase}`}>
          {PHASE_LABEL[preview.phase] ?? preview.phase}
        </span>
        {!focused && (
          <div className="seg seg-views" role="tablist" aria-label="Workbench view">
            {(["preview", "code", "split"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`seg-btn ${tab === t ? "active" : ""}`}
                onClick={() => onTab(t)}
              >
                {t === "preview" ? "Preview" : t === "code" ? "Code" : "Split"}
              </button>
            ))}
          </div>
        )}
        <fieldset className="seg seg-mode" aria-label="Interaction mode">
          <button
            type="button"
            className={`seg-btn ${!inspecting ? "active" : ""}`}
            disabled={inspectBusy || inspecting === false}
            onClick={toggleInspect}
            title="Use the app normally"
          >
            Interact
          </button>
          <button
            type="button"
            className={`seg-btn seg-btn-inspect ${inspecting ? "active" : ""}`}
            disabled={inspectBusy || !inspectable || inspecting}
            onClick={toggleInspect}
            title={
              inspectable
                ? "Click elements to inspect (Ctrl+Shift+C)"
                : "Waiting for the preview to connect"
            }
          >
            Inspect
          </button>
        </fieldset>
        {focusMode === "preview" && state.revealOffer && (
          <output className="focus-reveal">
            <span className="focus-reveal-path" title={state.revealOffer.relativePath}>
              {state.revealOffer.relativePath}
              {state.revealOffer.source.line ? `:${state.revealOffer.source.line}` : ""}
            </span>
            <button
              type="button"
              className="btn btn-primary focus-reveal-btn"
              onClick={() => {
                const offer = state.revealOffer;
                if (!offer) return;
                dispatch({ type: "layout-focus", mode: "none" });
                dispatch({ type: "workspace-tab", tab: "split" });
                void quickEdit(state, dispatch, offer.relativePath, offer.source);
              }}
            >
              Show Source
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Dismiss source offer"
              onClick={() => dispatch({ type: "reveal-offer-clear" })}
            >
              <CloseIcon size={12} />
            </button>
          </output>
        )}
        {focused ? (
          <button
            type="button"
            className="btn pv-focus-exit"
            onClick={() => dispatch({ type: "layout-focus", mode: "none" })}
            title="Exit focus mode (Esc)"
          >
            <CloseIcon size={12} style={{ marginRight: 4 }} /> Exit Focus
          </button>
        ) : (
          <button
            type="button"
            className="icon-btn"
            aria-label="Preview Focus"
            title="Preview Focus (Ctrl+Shift+P)"
            onClick={() => dispatch({ type: "layout-focus", mode: "preview" })}
          >
            <FocusIcon />
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={!url || !urlSafe}
          onClick={openExternal}
          title="Open in the system browser"
        >
          External
        </button>
      </div>

      <div className="preview-body" ref={bodyRef}>
        {effTab !== "code" && (
          <div
            ref={hostRef}
            className="preview-host"
            style={effTab === "split" ? { flex: layout.splitRatio } : undefined}
          >
            {overlay}
          </div>
        )}
        {effTab === "split" && (
          <Splitter
            label="Preview/Code split"
            valueNow={Math.round(layout.splitRatio * 100)}
            valueMin={10}
            valueMax={90}
            valueText={`Preview ${Math.round(layout.splitRatio * 100)}%, Code ${Math.round((1 - layout.splitRatio) * 100)}%`}
            onDelta={(d) => {
              const w = bodyRef.current?.getBoundingClientRect().width ?? 0;
              if (w < 4) return;
              const min = Math.max(0.1, PREVIEW_MIN_PX / w);
              const max = Math.min(0.9, 1 - CODE_MIN_PX / w);
              const next = Math.min(max, Math.max(min, ratioBase.current + d / w));
              dispatch({ type: "layout-update", patch: { splitRatio: next } });
            }}
            onDragState={(d) => {
              if (d) ratioBase.current = layout.splitRatio;
              onCover?.(d);
            }}
            onNudge={(d) => {
              const w = bodyRef.current?.getBoundingClientRect().width ?? 0;
              if (w < 4) return;
              const min = Math.max(0.1, PREVIEW_MIN_PX / w);
              const max = Math.min(0.9, 1 - CODE_MIN_PX / w);
              const next = Math.min(max, Math.max(min, layout.splitRatio + d / w));
              dispatch({ type: "layout-update", patch: { splitRatio: next } });
            }}
            onReset={() =>
              dispatch({
                type: "layout-update",
                patch: { splitRatio: LAYOUT_DEFAULTS.splitRatio },
              })
            }
          />
        )}
        {children}
      </div>
    </section>
  );
}
