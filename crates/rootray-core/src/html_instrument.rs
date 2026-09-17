//! Parser-based HTML instrumentation — native twin of
//! `@rootray/html-instrument` (packages/html-instrument).
//!
//! Stamps `data-rootray-file` / `-line` / `-column` onto authored HTML
//! elements using lol_html's real HTML5 tokenizer — never regex. Element
//! positions come from the parser's source-location byte ranges, mapped
//! back to line/column on the original input.
//!
//! Security contract (identical on both sides):
//! - Instrumentation happens at serve time, never inside the page.
//! - Any authored `data-rootray-*` attribute is stripped BEFORE stamping,
//!   so markup can never spoof a source identity.
//! - `html`/`body` and non-renderable tags are never stamped — a
//!   document-level catch-all would turn source-less dynamic nodes into
//!   falsely "mapped" ones.
//! - On any parser bail-out the caller serves the original bytes —
//!   instrumentation degrades, it never corrupts.

use lol_html::html_content::{ContentType, Element};
use lol_html::{element, end, rewrite_str, RewriteStrSettings};

/// Tags never stamped — mirrors `SKIP_TAGS` in packages/html-instrument.
const SKIP_TAGS: &[&str] = &[
    "html", "head", "body", "meta", "title", "base", "link", "script", "style", "noscript",
    "template", "frameset", "frame",
];

/// Reserved metadata prefix — the page must never author these.
const RESERVED_PREFIX: &str = "data-rootray";

pub struct HtmlInstrumented {
    pub code: String,
    /// Elements stamped with a fresh trusted identity.
    pub stamped: usize,
    /// Authored `data-rootray-*` attributes removed (spoof attempts).
    pub removed_reserved: usize,
}

/// Byte offsets of every line start in `src` (offset 0 = line 1).
fn line_starts(src: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (i, b) in src.bytes().enumerate() {
        if b == b'\n' {
            starts.push(i + 1);
        }
    }
    starts
}

/// 1-based (line, column) for a byte offset. Columns count UTF-16 code
/// units — the same unit parse5 (the TS twin) and most editors use.
fn offset_to_line_col(starts: &[usize], src: &str, offset: usize) -> (u32, u32) {
    let idx = starts.partition_point(|&s| s <= offset).max(1);
    let line = idx as u32;
    let col = src[starts[idx - 1]..offset]
        .chars()
        .map(|c| c.len_utf16() as u32)
        .sum::<u32>()
        + 1;
    (line, col)
}

/// Stamps every authored, stampable element in `input` and appends
/// `inject` markup at the end of the document. `file` is the
/// forward-slash path written into `data-rootray-file` — the caller
/// chooses its root convention (the static server uses workspace-relative
/// paths so nested targets resolve correctly without rebasing).
///
/// `Err` = the parser refused to rewrite (ambiguous markup) — serve the
/// original bytes instead.
pub fn instrument_html(
    input: &str,
    file: &str,
    inject: &str,
) -> Result<HtmlInstrumented, lol_html::errors::RewritingError> {
    let starts = line_starts(input);
    let stamped = std::cell::Cell::new(0usize);
    let removed = std::cell::Cell::new(0usize);

    let settings = RewriteStrSettings::new()
        .append_element_content_handler(element!("*", |el: &mut Element| {
            // Strip authored reserved attributes first — spoof attempts
            // are deleted, never trusted.
            let reserved: Vec<String> = el
                .attributes()
                .iter()
                .filter(|a| a.name().to_ascii_lowercase().starts_with(RESERVED_PREFIX))
                .map(|a| a.name())
                .collect();
            for name in &reserved {
                el.remove_attribute(name);
                removed.set(removed.get() + 1);
            }
            let tag = el.tag_name().to_ascii_lowercase();
            if !SKIP_TAGS.contains(&tag.as_str()) {
                let (line, col) =
                    offset_to_line_col(&starts, input, el.source_location().bytes().start);
                el.set_attribute("data-rootray-file", file)?;
                el.set_attribute("data-rootray-line", &line.to_string())?;
                el.set_attribute("data-rootray-column", &col.to_string())?;
                stamped.set(stamped.get() + 1);
            }
            Ok(())
        }))
        .append_document_content_handler(end!(|doc_end| {
            if !inject.is_empty() {
                doc_end.append(inject, ContentType::Html);
            }
            Ok(())
        }));

    let code = rewrite_str(input, settings)?;
    Ok(HtmlInstrumented {
        code,
        stamped: stamped.get(),
        removed_reserved: removed.get(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_exact_line_and_column() {
        let html = "<!doctype html>\n<html>\n<head><title>t</title></head>\n<body>\n  <div id=\"app\"><button>Go</button></div>\n</body>\n</html>";
        let out = instrument_html(html, "index.html", "").unwrap();
        assert_eq!(out.stamped, 2);
        assert!(
            out.code.contains(
                "<div id=\"app\" data-rootray-file=\"index.html\" data-rootray-line=\"5\" data-rootray-column=\"3\""
            ),
            "{}",
            out.code
        );
        assert!(
            out.code.contains(
                "<button data-rootray-file=\"index.html\" data-rootray-line=\"5\" data-rootray-column=\"17\""
            ),
            "{}",
            out.code
        );
        // html/head/body/title are never stamped.
        assert!(!out.code.contains("<html data-rootray"));
        assert!(!out.code.contains("<head data-rootray"));
        assert!(!out.code.contains("<body data-rootray"));
        assert!(!out.code.contains("<title data-rootray"));
    }

    #[test]
    fn strips_authored_reserved_attributes() {
        let html = "<body><div data-rootray-file=\"etc/passwd\" data-rootray-line=\"1\" data-rootray-column=\"1\">x</div></body>";
        let out = instrument_html(html, "index.html", "").unwrap();
        assert_eq!(out.removed_reserved, 3);
        assert!(!out.code.contains("etc/passwd"));
        // Fresh trusted stamp on the real line/column.
        assert!(out.code.contains("data-rootray-file=\"index.html\""));
        assert!(out.code.contains("data-rootray-line=\"1\""));
    }

    #[test]
    fn strips_case_insensitive_reserved_names() {
        let html = "<body><div DATA-ROOTRAY-FILE=\"spoof.ts\">x</div></body>";
        let out = instrument_html(html, "index.html", "").unwrap();
        assert!(!out.code.to_lowercase().contains("spoof.ts"));
        assert_eq!(out.removed_reserved, 1);
    }

    #[test]
    fn stamps_canvas_and_void_elements() {
        let html = "<body><canvas id=\"arena\"></canvas><br><img src=\"a.png\"></body>";
        let out = instrument_html(html, "index.html", "").unwrap();
        assert_eq!(out.stamped, 3);
        assert!(out.code.contains("<canvas id=\"arena\" data-rootray-file=\"index.html\""), "{}", out.code);
    }

    #[test]
    fn leaves_script_and_comment_bytes_untouched() {
        let html = "<body><!-- <div>x</div> --><script>const s = \"<div>\";</script><p>ok</p></body>";
        let out = instrument_html(html, "index.html", "").unwrap();
        assert_eq!(out.stamped, 1); // only the real <p>
        assert!(out.code.contains("<!-- <div>x</div> -->"));
        assert!(out.code.contains("\"<div>\""));
    }

    #[test]
    fn injects_bootstrap_at_document_end() {
        let html = "<html><body><p>x</p></body></html>";
        let out = instrument_html(html, "index.html", "<script>window.__ROOTRAY__={};</script>")
            .unwrap();
        assert!(out.code.ends_with("<script>window.__ROOTRAY__={};</script>"));
        assert!(out.code.contains("</html>"));
    }

    #[test]
    fn self_closing_foreign_elements_are_stampable() {
        let html = "<body><svg><path d=\"M0 0\"/></svg></body>";
        let out = instrument_html(html, "index.html", "").unwrap();
        assert!(out.code.contains("data-rootray-file=\"index.html\""));
    }
}
