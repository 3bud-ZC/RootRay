//! Wire protocol between the RootRay bridge and the browser runtime.
//!
//! Mirror of `packages/source-protocol` — the JSON shapes there are the
//! contract. Every message crossing the boundary is validated field by
//! field; nothing is blindly deserialized into a privileged action.

use serde::Serialize;
use serde_json::Value;

pub const PROTOCOL_VERSION: u64 = 1;
pub const BRIDGE_PATH: &str = "/rootray";

const MAX_STRING: usize = 4096;
const MAX_TAG: usize = 64;
const MAX_TEXT_PREVIEW: usize = 200;
const MAX_STYLE_CLASSES: usize = 32;
const MAX_STYLE_RULES: usize = 24;
const MAX_STYLE_DECLS: usize = 32;
const MAX_STYLE_COMPUTED: usize = 24;
const MAX_STYLE_STRING: usize = 512;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxEdges {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxModel {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub margin: BoxEdges,
    pub padding: BoxEdges,
    pub border: BoxEdges,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CssDeclaration {
    pub property: String,
    pub value: String,
    pub important: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedCssRule {
    pub selector: String,
    pub declarations: Vec<CssDeclaration>,
    /// Project-relative stylesheet path — present only when the runtime
    /// resolved it reliably. Absolute paths are rejected at parse time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
}

/// Bounded style snapshot the browser runtime attaches to a selection.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleDetails {
    pub classes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element_id: Option<String>,
    #[serde(rename = "box")]
    pub box_model: BoxModel,
    pub computed: std::collections::BTreeMap<String, String>,
    pub matched_rules: Vec<MatchedCssRule>,
}

/// Project-relative source identity of a rendered element.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceLocation {
    pub relative_path: String,
    pub line: u32,
    pub column: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_name: Option<String>,
    /// "exact" | "approximate" | "component" — how trustworthy the mapping is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementFacts {
    pub tag_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementSelection {
    pub element: ElementFacts,
    /// Authored source identity — `None` when the selected DOM element
    /// has no trustworthy mapping (e.g. dynamically created by plain
    /// JavaScript). A *present* source is always fully validated; absent
    /// is a normal state, never a protocol failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceLocation>,
    /// Style snapshot — optional; malformed styles degrade to `None`,
    /// never to a rejected selection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub styles: Option<StyleDetails>,
}

/// Validated runtime → bridge messages.
#[derive(Debug, Clone, PartialEq)]
pub enum RuntimeMessage {
    Hello {
        session_id: String,
        token: String,
        page_url: String,
    },
    Ready {
        session_id: String,
    },
    ElementSelected {
        session_id: String,
        selection: ElementSelection,
    },
    /// Runtime requests an inspection change (e.g. user pressed Escape).
    InspectSet {
        enabled: bool,
    },
}

/// Bridge → runtime messages.
#[derive(Debug, Clone)]
pub enum BridgeMessage {
    SessionAccepted { session_id: String },
    SessionRejected { reason: String },
    InspectSet { enabled: bool },
}

impl BridgeMessage {
    pub fn to_json(&self) -> String {
        match self {
            Self::SessionAccepted { session_id } => serde_json::json!({
                "version": PROTOCOL_VERSION,
                "type": "session:accepted",
                "sessionId": session_id,
            }),
            Self::SessionRejected { reason } => serde_json::json!({
                "version": PROTOCOL_VERSION,
                "type": "session:rejected",
                "reason": reason,
            }),
            Self::InspectSet { enabled } => serde_json::json!({
                "version": PROTOCOL_VERSION,
                "type": "inspect:set",
                "enabled": enabled,
            }),
        }
        .to_string()
    }
}

/// Reason a runtime message was refused. Static — carries no payload data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolError {
    InvalidJson,
    NotAnObject,
    UnsupportedVersion,
    UnknownType,
    MissingFields,
    InvalidElement,
    InvalidSource,
}

/// Parses and validates a runtime → bridge message.
pub fn parse_runtime_message(raw: &str) -> Result<RuntimeMessage, ProtocolError> {
    let value: Value = serde_json::from_str(raw).map_err(|_| ProtocolError::InvalidJson)?;
    let obj = value.as_object().ok_or(ProtocolError::NotAnObject)?;

    if obj.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(ProtocolError::UnsupportedVersion);
    }
    let msg_type = obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or(ProtocolError::MissingFields)?;

    match msg_type {
        "runtime:hello" => {
            let session_id = required_str(obj, "sessionId")?;
            let token = required_str(obj, "token")?;
            let page_url = required_str(obj, "pageUrl")?;
            Ok(RuntimeMessage::Hello { session_id, token, page_url })
        }
        "runtime:ready" => Ok(RuntimeMessage::Ready {
            session_id: required_str(obj, "sessionId")?,
        }),
        "inspect:set" => Ok(RuntimeMessage::InspectSet {
            enabled: obj
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or(ProtocolError::MissingFields)?,
        }),
        "element:selected" => {
            let session_id = required_str(obj, "sessionId")?;
            let element = parse_element_facts(obj.get("element"))
                .ok_or(ProtocolError::InvalidElement)?;
            // `source` is optional — but when the key is present it must
            // validate completely (a malformed source, `null` included,
            // rejects the message rather than degrading to trusted data).
            let source = match obj.get("source") {
                None => None,
                Some(v) => {
                    Some(parse_source_location(Some(v)).ok_or(ProtocolError::InvalidSource)?)
                }
            };
            let styles = parse_style_details(obj.get("styles"));
            Ok(RuntimeMessage::ElementSelected {
                session_id,
                selection: ElementSelection { element, source, styles },
            })
        }
        _ => Err(ProtocolError::UnknownType),
    }
}

fn required_str(
    obj: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, ProtocolError> {
    match obj.get(key).and_then(Value::as_str) {
        Some(s) if !s.is_empty() && s.len() <= MAX_STRING => Ok(s.to_string()),
        _ => Err(ProtocolError::MissingFields),
    }
}

fn optional_str(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= MAX_STRING)
        .map(str::to_string)
}

fn parse_element_facts(v: Option<&Value>) -> Option<ElementFacts> {
    let obj = v?.as_object()?;
    let tag = obj.get("tagName")?.as_str()?;
    if tag.is_empty() || tag.len() > MAX_TAG {
        return None;
    }
    let text_preview = optional_str(obj.get("textPreview"))
        .map(|s| s.chars().take(MAX_TEXT_PREVIEW).collect());
    Some(ElementFacts {
        tag_name: tag.to_string(),
        id: optional_str(obj.get("id")),
        class_name: optional_str(obj.get("className")),
        text_preview,
    })
}

fn parse_source_location(v: Option<&Value>) -> Option<SourceLocation> {
    let obj = v?.as_object()?;
    let rel = obj.get("relativePath")?.as_str()?;
    if !is_safe_relative_path(rel) {
        return None;
    }
    let line = obj.get("line")?.as_u64()?;
    let column = obj.get("column")?.as_u64()?;
    if line < 1 || column < 1 {
        return None;
    }
    Some(SourceLocation {
        relative_path: rel.to_string(),
        line: line as u32,
        column: column as u32,
        component_name: optional_str(obj.get("componentName")),
        confidence: parse_confidence(obj.get("confidence"))?,
    })
}

/// `confidence` is an optional, additive v1 extension: absent is fine, a
/// known value is kept, any other present value (including `null`)
/// invalidates the location — the TypeScript mirror does the same.
fn parse_confidence(v: Option<&Value>) -> Option<Option<String>> {
    match v {
        None => Some(None),
        Some(Value::String(s))
            if matches!(s.as_str(), "exact" | "approximate" | "component") =>
        {
            Some(Some(s.clone()))
        }
        Some(_) => None,
    }
}

fn finite_f64(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn parse_edges(v: Option<&Value>) -> Option<BoxEdges> {
    let obj = v?.as_object()?;
    Some(BoxEdges {
        top: finite_f64(obj.get("top"))?,
        right: finite_f64(obj.get("right"))?,
        bottom: finite_f64(obj.get("bottom"))?,
        left: finite_f64(obj.get("left"))?,
    })
}

fn bounded_str(v: Option<&Value>, max: usize) -> Option<String> {
    let s = v?.as_str()?;
    if s.len() > max {
        return None;
    }
    Some(s.to_string())
}

/// Validates a style snapshot. Any malformed field → `None`; the caller
/// keeps the selection itself.
fn parse_style_details(v: Option<&Value>) -> Option<StyleDetails> {
    let obj = v?.as_object()?;

    let classes_v = obj.get("classes")?.as_array()?;
    if classes_v.len() > MAX_STYLE_CLASSES {
        return None;
    }
    let mut classes = Vec::with_capacity(classes_v.len());
    for c in classes_v {
        let s = c.as_str()?;
        if s.is_empty() || s.len() > MAX_STYLE_STRING {
            return None;
        }
        classes.push(s.to_string());
    }
    let element_id = match obj.get("elementId") {
        Some(v) => Some(bounded_str(Some(v), MAX_STYLE_STRING)?),
        None => None,
    };

    let b = obj.get("box")?.as_object()?;
    let box_model = BoxModel {
        x: finite_f64(b.get("x"))?,
        y: finite_f64(b.get("y"))?,
        width: finite_f64(b.get("width"))?,
        height: finite_f64(b.get("height"))?,
        margin: parse_edges(b.get("margin"))?,
        padding: parse_edges(b.get("padding"))?,
        border: parse_edges(b.get("border"))?,
    };

    let computed_v = obj.get("computed")?.as_object()?;
    if computed_v.len() > MAX_STYLE_COMPUTED {
        return None;
    }
    let mut computed = std::collections::BTreeMap::new();
    for (k, val) in computed_v {
        if k.len() > MAX_STYLE_STRING {
            return None;
        }
        computed.insert(k.clone(), bounded_str(Some(val), MAX_STYLE_STRING)?);
    }

    let rules_v = obj.get("matchedRules")?.as_array()?;
    if rules_v.len() > MAX_STYLE_RULES {
        return None;
    }
    let mut matched_rules = Vec::with_capacity(rules_v.len());
    for r in rules_v {
        let ro = r.as_object()?;
        let selector = bounded_str(ro.get("selector"), MAX_STYLE_STRING)?;
        let decls_v = ro.get("declarations")?.as_array()?;
        if decls_v.len() > MAX_STYLE_DECLS {
            return None;
        }
        let mut declarations = Vec::with_capacity(decls_v.len());
        for d in decls_v {
            let d_obj = d.as_object()?;
            declarations.push(CssDeclaration {
                property: bounded_str(d_obj.get("property"), MAX_STYLE_STRING)?,
                value: bounded_str(d_obj.get("value"), MAX_STYLE_STRING)?,
                important: d_obj.get("important").and_then(Value::as_bool).unwrap_or(false),
            });
        }
        let source_path = match ro.get("sourcePath") {
            Some(v) => {
                let p = v.as_str()?;
                if !is_safe_relative_path(p) {
                    return None;
                }
                Some(p.to_string())
            }
            None => None,
        };
        matched_rules.push(MatchedCssRule { selector, declarations, source_path });
    }

    Some(StyleDetails { classes, element_id, box_model, computed, matched_rules })
}

/// Project-relative path contract: forward slashes, no escapes, no drive
/// letters or leading separators — mirrors the TS validator.
pub fn is_safe_relative_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= MAX_STRING
        && !p.contains("..")
        && !p.contains('\\')
        && !p.starts_with('/')
        && !p.starts_with("//")
        && !p.as_bytes().get(1).is_some_and(|b| *b == b':')
}
