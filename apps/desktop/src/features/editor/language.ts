/**
 * Extension → editor language. The CodeMirror support package is loaded
 * lazily per language so the initial bundle carries none of them.
 */

export type LanguageId =
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "css"
  | "scss"
  | "html"
  | "json"
  | "markdown"
  | "text";

/** Pure mapping — unit-tested without CodeMirror imports. */
export function languageIdFor(relativePath: string): LanguageId {
  const name = relativePath.split("/").pop()?.toLowerCase() ?? "";
  const ext = name.includes(".") ? name.split(".").pop() : undefined;
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "jsx";
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "css":
      return "css";
    case "scss":
    case "less":
      return "scss";
    case "html":
    case "htm":
    case "svg":
    case "xml":
      return "html";
    case "json":
    case "jsonc":
    case "json5":
      return "json";
    case "md":
      return "markdown";
    default:
      return "text";
  }
}

/** Lazy CodeMirror `LanguageSupport` for the given path, if any. */
export async function languageExtension(relativePath: string) {
  switch (languageIdFor(relativePath)) {
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: true,
        jsx: true,
      });
    case "css":
    case "scss":
      // SCSS parses fine through the CSS parser for lightweight editing.
      return (await import("@codemirror/lang-css")).css();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "markdown":
    case "text":
      return null;
  }
}
