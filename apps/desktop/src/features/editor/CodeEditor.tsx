/**
 * CodeMirror 6 wrapper for Quick Edit. The editor is the source of truth
 * while typing; `value` only replaces the document when it differs from
 * what's in the buffer (discard / reload / revert paths).
 */

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { languageExtension } from "./language";

/** Set / clear the "this is where the inspected element lives" line. */
const setMarkedLine = StateEffect.define<number | null>();

const markedLineDeco = Decoration.line({ class: "cm-rootray-marked-line" });

const markedLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setMarkedLine)) {
        if (e.value === null || e.value < 1 || e.value > tr.state.doc.lines) {
          next = Decoration.none;
        } else {
          const line = tr.state.doc.line(e.value);
          next = Decoration.set([markedLineDeco.range(line.from)]);
        }
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const rootRayTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--bg-inset)",
      color: "var(--text)",
      fontSize: "13px",
      height: "100%",
    },
    ".cm-content": {
      fontFamily: "var(--mono)",
      caretColor: "var(--accent)",
      padding: "8px 0",
    },
    ".cm-cursor": { borderLeftColor: "var(--accent)" },
    "&.cm-focused": { outline: "none" },
    ".cm-gutters": {
      backgroundColor: "var(--bg-inset)",
      color: "var(--text-dim)",
      border: "none",
      borderRight: "1px solid var(--border)",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255,107,12,0.06)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(255,107,12,0.10)" },
    ".cm-rootray-marked-line": {
      backgroundColor: "rgba(255,107,12,0.16)",
      boxShadow: "inset 3px 0 #ff6b0c, 0 0 12px rgba(255,107,12,0.18)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "rgba(255,107,12,0.22) !important",
    },
    ".cm-matchingBracket": { backgroundColor: "rgba(63,185,80,0.25)" },
    ".cm-searchMatch": { backgroundColor: "rgba(210,153,34,0.35)" },
    ".cm-searchMatch-selected": { backgroundColor: "rgba(210,153,34,0.6)" },
    ".cm-panels": {
      backgroundColor: "var(--bg-raised)",
      color: "var(--text)",
      borderTop: "1px solid var(--border)",
    },
    ".cm-panels input, .cm-panels button": {
      backgroundColor: "var(--bg-inset)",
      color: "var(--text)",
      border: "1px solid var(--border)",
      borderRadius: "4px",
      fontSize: "12px",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--bg-raised)",
      border: "1px solid var(--border)",
      color: "var(--text)",
    },
  },
  { dark: true },
);

const rootRayHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword], color: "#ff9d72" },
  { tag: [tags.string, tags.special(tags.string)], color: "#a5d6a7" },
  { tag: [tags.number, tags.bool, tags.null], color: "#79c0ff" },
  { tag: [tags.comment, tags.blockComment], color: "#6b7686", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#d2a8ff" },
  { tag: [tags.typeName, tags.className, tags.tagName], color: "#ffa657" },
  { tag: tags.attributeName, color: "#79c0ff" },
  { tag: tags.propertyName, color: "#7ee787" },
  { tag: tags.operator, color: "#ff9d72" },
  { tag: tags.punctuation, color: "#8b98a9" },
  { tag: tags.variableName, color: "#e6edf3" },
  { tag: [tags.regexp, tags.escape], color: "#7ee787" },
]);

export interface CodeEditorProps {
  /** Desired document content — applied only when it differs from the buffer. */
  value: string;
  relativePath: string;
  /** 1-based line to focus/mark; null clears the marker. */
  focusLine: number | null;
  focusColumn: number | null;
  onChange: (content: string) => void;
  onSave: () => void;
}

export function CodeEditor({
  value,
  relativePath,
  focusLine,
  focusColumn,
  onChange,
  onSave,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Latest callbacks — the view is created once and must not capture
  // stale props.
  const cbRef = useRef({ onChange, onSave });
  cbRef.current = { onChange, onSave };
  const markRef = useRef<number | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const focusRef = useRef({ line: focusLine, column: focusColumn });
  focusRef.current = { line: focusLine, column: focusColumn };

  // Create / recreate the view when the file changes.
  // `value`/`focusLine` are read once per file — external changes are
  // synced by the dedicated effects below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: view is created once per file; value/focus changes are synced by the effects below
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Do not expose line-number chrome until a real document is ready.
    host.dataset.editorReady = "false";
    let disposed = false;
    let view: EditorView | null = null;

    const build = (lang: Extension | null) => {
      if (disposed) return;
      const updateListener = EditorView.updateListener.of((u) => {
        if (u.docChanged) cbRef.current.onChange(u.state.doc.toString());
      });
      const saveKeymap = keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            cbRef.current.onSave();
            return true;
          },
        },
      ]);
      const initialContent = valueRef.current;
      const state = EditorState.create({
        doc: initialContent,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          indentOnInput(),
          bracketMatching(),
          highlightSelectionMatches(),
          search({ top: true }),
          markedLineField,
          lang ?? [],
          rootRayTheme,
          syntaxHighlighting(rootRayHighlight, { fallback: true }),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          saveKeymap,
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          updateListener,
          EditorView.lineWrapping,
        ],
      });
      view = new EditorView({ state, parent: host });
      viewRef.current = view;
      // The language extension resolves asynchronously. Reconcile once more
      // after the view exists so a value change during that gap cannot leave
      // a correctly numbered but empty document behind.
      const latestContent = valueRef.current;
      if (latestContent !== initialContent) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: latestContent },
        });
      }
      host.dataset.editorReady =
        latestContent.trim() || view.state.doc.length === 0 ? "true" : "false";
      applyFocus(view, focusRef.current.line, focusRef.current.column);
    };

    markRef.current = focusLine;
    // Language support loads lazily; plain text renders instantly.
    languageExtension(relativePath)
      .then(build)
      .catch(() => build(null));

    return () => {
      disposed = true;
      viewRef.current = null;
      view?.destroy();
    };
  }, [relativePath]);

  // Sync externally-changed content (discard / reload / revert) into the
  // buffer. Typing already flows the other way via onChange, so a no-op
  // diff here is the common case.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
    if (hostRef.current) {
      hostRef.current.dataset.editorReady =
        value.trim() || view.state.doc.length === 0 ? "true" : "false";
    }
    if (focusRef.current.line !== null) {
      applyFocus(view, focusRef.current.line, focusRef.current.column);
    }
  }, [value]);

  // Focus + mark the inspected line when it changes.
  useEffect(() => {
    markRef.current = focusLine;
    const view = viewRef.current;
    if (view) applyFocus(view, focusLine, focusColumn);
  }, [focusLine, focusColumn]);

  return <div className="qe-cm-host" ref={hostRef} />;
}

function applyFocus(view: EditorView, line: number | null, column: number | null) {
  if (line === null || line < 1 || line > view.state.doc.lines) {
    if (line === null) view.dispatch({ effects: setMarkedLine.of(null) });
    return;
  }
  const info = view.state.doc.line(line);
  const col = Math.max(1, Math.min(column ?? 1, info.length + 1));
  view.dispatch({
    selection: { anchor: info.from + col - 1 },
    effects: [setMarkedLine.of(line), EditorView.scrollIntoView(info.from, { y: "center" })],
  });
}
