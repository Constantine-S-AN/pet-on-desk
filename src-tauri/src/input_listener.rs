use crate::diagnostics::{GlobalInputEvent, SharedDiagnosticsState};
use crossbeam_channel::{bounded, Receiver, Sender, TrySendError};
use rdev::{Button, Event, EventType, Key};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const INPUT_CHANNEL_CAPACITY: usize = 512;
const MOUSE_MOVE_THROTTLE_MS: u64 = 16;
const FORWARDER_POLL_MS: u64 = 4;
const FORWARDER_IDLE_POLL_MS: u64 = 80;

#[derive(Default)]
pub struct InputListenerState {
    running: AtomicBool,
    forwarding: AtomicBool,
    health_token: AtomicU64,
    events_seen_since_start: AtomicU64,
}

pub type SharedInputListenerState = Arc<InputListenerState>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InputHealthPayload {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    platform: String,
}

fn platform_name() -> String {
    std::env::consts::OS.to_string()
}

fn emit_input_health(app: &AppHandle, payload: InputHealthPayload) {
    if let Err(err) = app.emit("input-health", payload) {
        tracing::warn!("failed to emit input-health event: {err}");
    }
}

fn emit_global_input(
    app: &AppHandle,
    diagnostics: &SharedDiagnosticsState,
    payload: GlobalInputEvent,
) {
    diagnostics.record_input_event(payload.clone());

    if let Err(err) = app.emit("global-input", payload) {
        tracing::warn!("failed to emit global-input event: {err}");
    }
}

fn maybe_emit_pending_mouse_move(
    app: &AppHandle,
    diagnostics: &SharedDiagnosticsState,
    pending_mouse_move: &mut Option<GlobalInputEvent>,
    last_mouse_emit: &mut Instant,
    force: bool,
) {
    if pending_mouse_move.is_none() {
        return;
    }

    if !force && last_mouse_emit.elapsed() < Duration::from_millis(MOUSE_MOVE_THROTTLE_MS) {
        return;
    }

    if let Some(payload) = pending_mouse_move.take() {
        emit_global_input(app, diagnostics, payload);
        *last_mouse_emit = Instant::now();
    }
}

fn enqueue_with_drop_old(
    sender: &Sender<GlobalInputEvent>,
    receiver_for_drop: &Receiver<GlobalInputEvent>,
    payload: GlobalInputEvent,
) {
    match sender.try_send(payload) {
        Ok(_) => {}
        Err(TrySendError::Full(latest_payload)) => {
            // Keep the newest snapshot when queue is overloaded.
            while receiver_for_drop.try_recv().is_ok() {}
            if sender.try_send(latest_payload).is_err() {
                tracing::warn!("dropping global input event: queue still full after drain");
            }
        }
        Err(TrySendError::Disconnected(_)) => {
            tracing::debug!("dropping global input event: channel disconnected");
        }
    }
}

fn forward_events_loop(
    app: AppHandle,
    listener_state: SharedInputListenerState,
    diagnostics: SharedDiagnosticsState,
    receiver: Receiver<GlobalInputEvent>,
) {
    let mut pending_mouse_move: Option<GlobalInputEvent> = None;
    let mut last_mouse_emit = Instant::now()
        .checked_sub(Duration::from_millis(MOUSE_MOVE_THROTTLE_MS))
        .unwrap_or_else(Instant::now);

    while listener_state.running.load(Ordering::Relaxed) || !receiver.is_empty() {
        let poll_ms = if listener_state.forwarding.load(Ordering::Relaxed) {
            FORWARDER_POLL_MS
        } else {
            FORWARDER_IDLE_POLL_MS
        };

        match receiver.recv_timeout(Duration::from_millis(poll_ms)) {
            Ok(payload) => {
                if payload.r#type == "MouseMove" {
                    pending_mouse_move = Some(payload);
                    maybe_emit_pending_mouse_move(
                        &app,
                        &diagnostics,
                        &mut pending_mouse_move,
                        &mut last_mouse_emit,
                        false,
                    );
                    continue;
                }

                maybe_emit_pending_mouse_move(
                    &app,
                    &diagnostics,
                    &mut pending_mouse_move,
                    &mut last_mouse_emit,
                    false,
                );
                emit_global_input(&app, &diagnostics, payload);
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                maybe_emit_pending_mouse_move(
                    &app,
                    &diagnostics,
                    &mut pending_mouse_move,
                    &mut last_mouse_emit,
                    false,
                );
            }
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                break;
            }
        }
    }

    maybe_emit_pending_mouse_move(
        &app,
        &diagnostics,
        &mut pending_mouse_move,
        &mut last_mouse_emit,
        true,
    );
}

fn spawn_health_check(app: AppHandle, state: SharedInputListenerState, token: u64) {
    let _ = std::thread::Builder::new()
        .name("global-input-health-check".to_string())
        .spawn(move || {
            std::thread::sleep(Duration::from_secs(3));

            if state.health_token.load(Ordering::SeqCst) != token {
                return;
            }

            let events_seen = state.events_seen_since_start.load(Ordering::SeqCst);
            if events_seen == 0 {
                emit_input_health(
                    &app,
                    InputHealthPayload {
                        ok: false,
                        reason: Some("no_events_detected".to_string()),
                        platform: platform_name(),
                    },
                );
                return;
            }

            emit_input_health(
                &app,
                InputHealthPayload {
                    ok: true,
                    reason: None,
                    platform: platform_name(),
                },
            );
        });
}

#[tauri::command]
pub fn start_listener(
    app: AppHandle,
    state: State<'_, SharedInputListenerState>,
    diagnostics: State<'_, SharedDiagnosticsState>,
) -> Result<String, String> {
    let health_token = state.health_token.fetch_add(1, Ordering::SeqCst) + 1;
    state.events_seen_since_start.store(0, Ordering::SeqCst);
    spawn_health_check(app.clone(), Arc::clone(state.inner()), health_token);

    if state.running.load(Ordering::SeqCst) {
        state.forwarding.store(true, Ordering::SeqCst);
        return Ok("listener already running".to_string());
    }

    state.forwarding.store(true, Ordering::SeqCst);
    state.running.store(true, Ordering::SeqCst);

    let listener_state = Arc::clone(state.inner());
    let diagnostics_state = Arc::clone(diagnostics.inner());

    let (sender, receiver) = bounded::<GlobalInputEvent>(INPUT_CHANNEL_CAPACITY);
    let receiver_for_drop = receiver.clone();

    std::thread::Builder::new()
        .name("global-input-forwarder".to_string())
        .spawn({
            let app_for_forwarder = app.clone();
            let state_for_forwarder = Arc::clone(&listener_state);
            let diagnostics_for_forwarder = Arc::clone(&diagnostics_state);
            move || {
                forward_events_loop(
                    app_for_forwarder,
                    state_for_forwarder,
                    diagnostics_for_forwarder,
                    receiver,
                );
            }
        })
        .map_err(|err| {
            state.forwarding.store(false, Ordering::SeqCst);
            state.running.store(false, Ordering::SeqCst);
            format!("failed to start forwarder thread: {err}")
        })?;

    std::thread::Builder::new()
        .name("global-input-listener".to_string())
        .spawn(move || {
            // Note: macOS requires Accessibility permission for global input capture.
            let state_for_callback = Arc::clone(&listener_state);
            let sender_for_callback = sender;
            let receiver_for_drop_callback = receiver_for_drop;

            let listen_result = rdev::listen(move |event| {
                if !state_for_callback.forwarding.load(Ordering::Relaxed) {
                    return;
                }

                if let Some(payload) = normalize_event(&event) {
                    state_for_callback
                        .events_seen_since_start
                        .fetch_add(1, Ordering::SeqCst);
                    enqueue_with_drop_old(
                        &sender_for_callback,
                        &receiver_for_drop_callback,
                        payload,
                    );
                }
            });

            if let Err(err) = listen_result {
                tracing::error!("global input listener exited with error: {err:?}");
                diagnostics_state.record_error(
                    "error".to_string(),
                    format!("global input listener exited: {err:?}"),
                    None,
                );
            }

            listener_state.forwarding.store(false, Ordering::SeqCst);
            listener_state.running.store(false, Ordering::SeqCst);
        })
        .map_err(|err| {
            state.forwarding.store(false, Ordering::SeqCst);
            state.running.store(false, Ordering::SeqCst);
            format!("failed to start listener thread: {err}")
        })?;

    Ok("listener started".to_string())
}

#[tauri::command]
pub fn stop_listener(state: State<'_, SharedInputListenerState>) -> String {
    state.forwarding.store(false, Ordering::SeqCst);
    state.health_token.fetch_add(1, Ordering::SeqCst);
    if state.running.load(Ordering::SeqCst) {
        "listener stopped".to_string()
    } else {
        "listener not running".to_string()
    }
}

fn normalize_event(event: &Event) -> Option<GlobalInputEvent> {
    let timestamp = event
        .time
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);

    match &event.event_type {
        EventType::KeyPress(key) => Some(GlobalInputEvent {
            r#type: "KeyPress".to_string(),
            key_code: Some(key_to_string(key)),
            button: None,
            x: None,
            y: None,
            timestamp,
        }),
        EventType::KeyRelease(key) => Some(GlobalInputEvent {
            r#type: "KeyRelease".to_string(),
            key_code: Some(key_to_string(key)),
            button: None,
            x: None,
            y: None,
            timestamp,
        }),
        EventType::MouseMove { x, y } => Some(GlobalInputEvent {
            r#type: "MouseMove".to_string(),
            key_code: None,
            button: None,
            x: Some(*x),
            y: Some(*y),
            timestamp,
        }),
        EventType::ButtonPress(button) => Some(GlobalInputEvent {
            r#type: "ButtonPress".to_string(),
            key_code: None,
            button: Some(button_to_string(button)),
            x: None,
            y: None,
            timestamp,
        }),
        EventType::ButtonRelease(button) => Some(GlobalInputEvent {
            r#type: "ButtonRelease".to_string(),
            key_code: None,
            button: Some(button_to_string(button)),
            x: None,
            y: None,
            timestamp,
        }),
        _ => None,
    }
}

fn key_to_string(key: &Key) -> String {
    format!("{key:?}")
}

fn button_to_string(button: &Button) -> String {
    format!("{button:?}")
}
