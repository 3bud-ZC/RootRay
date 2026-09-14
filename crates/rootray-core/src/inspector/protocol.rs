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

/// Project-relative source identity of a rendered element.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceLocation {
    pub relative_path: String,
    pub line: u32,
    pub column: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_name: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementSelection {
    pub element: ElementFacts,
    pub source: SourceLocation,
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
            let source = parse_source_location(obj.get("source"))
                .ok_or(ProtocolError::InvalidSource)?;
            Ok(RuntimeMessage::ElementSelected {
                session_id,
                selection: ElementSelection { element, source },
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
    })
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
