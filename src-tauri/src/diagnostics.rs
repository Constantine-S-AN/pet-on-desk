use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_INPUT_EVENTS: usize = 50;
const MAX_ERROR_EVENTS: usize = 50;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalInputEvent {
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub button: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    pub timestamp: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticErrorRecord {
    pub level: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    pub timestamp: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSnapshot {
    pub input_events: Vec<GlobalInputEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_load_ms: Option<f64>,
    pub recent_errors: Vec<DiagnosticErrorRecord>,
}

#[derive(Default)]
pub struct DiagnosticsState {
    inner: Mutex<DiagnosticsInner>,
}

#[derive(Default)]
struct DiagnosticsInner {
    input_events: VecDeque<GlobalInputEvent>,
    recent_errors: VecDeque<DiagnosticErrorRecord>,
    fps: Option<f64>,
    model_load_ms: Option<f64>,
}

pub type SharedDiagnosticsState = Arc<DiagnosticsState>;

fn now_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn push_bounded<T>(queue: &mut VecDeque<T>, max_len: usize, value: T) {
    queue.push_back(value);
    while queue.len() > max_len {
        let _ = queue.pop_front();
    }
}

fn clamp_metric(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

impl DiagnosticsState {
    pub fn record_input_event(&self, event: GlobalInputEvent) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        push_bounded(&mut inner.input_events, MAX_INPUT_EVENTS, event);
    }

    pub fn record_error(&self, level: String, message: String, context: Option<String>) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let record = DiagnosticErrorRecord {
            level,
            message,
            context,
            timestamp: now_timestamp_ms(),
        };
        push_bounded(&mut inner.recent_errors, MAX_ERROR_EVENTS, record);
    }

    pub fn set_metrics(&self, fps: Option<f64>, model_load_ms: Option<f64>) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };

        if let Some(value) = fps {
            if value.is_finite() {
                inner.fps = Some(clamp_metric(value, 0.0, 1_000.0));
            }
        }

        if let Some(value) = model_load_ms {
            if value.is_finite() {
                inner.model_load_ms = Some(clamp_metric(value, 0.0, 600_000.0));
            }
        }
    }

    pub fn snapshot(&self) -> DiagnosticsSnapshot {
        let Ok(inner) = self.inner.lock() else {
            return DiagnosticsSnapshot {
                input_events: Vec::new(),
                fps: None,
                model_load_ms: None,
                recent_errors: Vec::new(),
            };
        };

        DiagnosticsSnapshot {
            input_events: inner.input_events.iter().cloned().collect(),
            fps: inner.fps,
            model_load_ms: inner.model_load_ms,
            recent_errors: inner.recent_errors.iter().cloned().collect(),
        }
    }
}
