mod diagnostics;
mod input_listener;
mod model_scan;

use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use diagnostics::{DiagnosticsSnapshot, DiagnosticsState, SharedDiagnosticsState};
use input_listener::{start_listener, stop_listener, InputListenerState};
use model_scan::find_model3_json;
use once_cell::sync::OnceCell;
use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tracing_subscriber::EnvFilter;

const MENU_SHOW_HIDE: &str = "tray_show_hide";
const MENU_OPEN_SETTINGS: &str = "tray_open_settings";
const MENU_TOGGLE_CLICK_THROUGH: &str = "tray_toggle_click_through";
const MENU_TOGGLE_LOCK: &str = "tray_toggle_lock";
const MENU_TOGGLE_SNAP: &str = "tray_toggle_snap";
const MENU_QUIT: &str = "tray_quit";

static LOG_GUARD: OnceCell<tracing_appender::non_blocking::WorkerGuard> = OnceCell::new();

struct UiState {
    click_through: AtomicBool,
    locked: AtomicBool,
    snap_enabled: AtomicBool,
    quitting: AtomicBool,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            click_through: AtomicBool::new(false),
            locked: AtomicBool::new(true),
            snap_enabled: AtomicBool::new(true),
            quitting: AtomicBool::new(false),
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClickThroughPayload {
    enabled: bool,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct LockPayload {
    locked: bool,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapPayload {
    enabled: bool,
}

fn init_logging(app: &tauri::App) -> Result<(), String> {
    if LOG_GUARD.get().is_some() {
        return Ok(());
    }

    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("failed to resolve app log dir: {error}"))?;

    std::fs::create_dir_all(&log_dir)
        .map_err(|error| format!("failed to create log dir {}: {error}", log_dir.display()))?;

    let file_appender = tracing_appender::rolling::daily(log_dir, "live2d-desktop-pet.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let env_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_target(true)
        .with_env_filter(env_filter)
        .with_writer(non_blocking)
        .finish();

    tracing::subscriber::set_global_default(subscriber)
        .map_err(|error| format!("failed to initialize tracing subscriber: {error}"))?;

    let _ = LOG_GUARD.set(guard);
    Ok(())
}

fn record_backend_error(app: &AppHandle, message: String) {
    let diagnostics = app.state::<SharedDiagnosticsState>();
    diagnostics.record_error("error".to_string(), message, None);
}

fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())
}

fn settings_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("settings")
        .ok_or_else(|| "settings window not found".to_string())
}

fn set_click_through_internal(
    app: &AppHandle,
    state: &UiState,
    enabled: bool,
) -> Result<bool, String> {
    let window = main_window(app)?;
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|error| error.to_string())?;

    state.click_through.store(enabled, Ordering::SeqCst);
    let _ = app.emit("click-through-changed", ClickThroughPayload { enabled });
    Ok(enabled)
}

fn set_locked_internal(app: &AppHandle, state: &UiState, locked: bool) -> Result<bool, String> {
    state.locked.store(locked, Ordering::SeqCst);
    let _ = app.emit("lock-changed", LockPayload { locked });
    Ok(locked)
}

fn set_snap_internal(app: &AppHandle, state: &UiState, enabled: bool) -> Result<bool, String> {
    state.snap_enabled.store(enabled, Ordering::SeqCst);
    let _ = app.emit("snap-changed", SnapPayload { enabled });
    Ok(enabled)
}

fn toggle_main_window_visibility(app: &AppHandle) -> Result<bool, String> {
    let window = main_window(app)?;
    let visible = window.is_visible().map_err(|error| error.to_string())?;
    if visible {
        window.hide().map_err(|error| error.to_string())?;
        return Ok(false);
    }

    window.show().map_err(|error| error.to_string())?;
    let _ = window.set_focus();
    Ok(true)
}

fn open_settings_window(app: &AppHandle) -> Result<(), String> {
    let window = settings_window(app)?;
    window.show().map_err(|error| error.to_string())?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(())
}

fn init_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_hide = MenuItem::with_id(app, MENU_SHOW_HIDE, "Show/Hide", true, None::<&str>)?;
    let open_settings = MenuItem::with_id(
        app,
        MENU_OPEN_SETTINGS,
        "Open Settings",
        true,
        None::<&str>,
    )?;
    let toggle_click_through = MenuItem::with_id(
        app,
        MENU_TOGGLE_CLICK_THROUGH,
        "Toggle Click-through",
        true,
        None::<&str>,
    )?;
    let toggle_lock =
        MenuItem::with_id(app, MENU_TOGGLE_LOCK, "Lock / Unlock", true, None::<&str>)?;
    let toggle_snap =
        MenuItem::with_id(app, MENU_TOGGLE_SNAP, "Snap Toggle", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_hide,
            &open_settings,
            &toggle_click_through,
            &toggle_lock,
            &toggle_snap,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("pet-tray").menu(&menu);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder
        .on_menu_event(|app_handle, event| match event.id().as_ref() {
            MENU_SHOW_HIDE => {
                if let Err(error) = toggle_main_window_visibility(app_handle) {
                    tracing::error!("failed to toggle main window visibility: {error}");
                    record_backend_error(app_handle, format!("toggle visibility failed: {error}"));
                }
            }
            MENU_OPEN_SETTINGS => {
                if let Err(error) = open_settings_window(app_handle) {
                    tracing::error!("failed to open settings window: {error}");
                    record_backend_error(app_handle, format!("open settings failed: {error}"));
                }
            }
            MENU_TOGGLE_CLICK_THROUGH => {
                let state = app_handle.state::<UiState>();
                let next = !state.click_through.load(Ordering::SeqCst);
                if let Err(error) = set_click_through_internal(app_handle, &state, next) {
                    tracing::error!("failed to toggle click-through from tray: {error}");
                    record_backend_error(app_handle, format!("toggle click-through failed: {error}"));
                }
            }
            MENU_TOGGLE_LOCK => {
                let state = app_handle.state::<UiState>();
                let next = !state.locked.load(Ordering::SeqCst);
                if let Err(error) = set_locked_internal(app_handle, &state, next) {
                    tracing::error!("failed to toggle lock from tray: {error}");
                    record_backend_error(app_handle, format!("toggle lock failed: {error}"));
                }
            }
            MENU_TOGGLE_SNAP => {
                let state = app_handle.state::<UiState>();
                let next = !state.snap_enabled.load(Ordering::SeqCst);
                if let Err(error) = set_snap_internal(app_handle, &state, next) {
                    tracing::error!("failed to toggle snap from tray: {error}");
                    record_backend_error(app_handle, format!("toggle snap failed: {error}"));
                }
            }
            MENU_QUIT => {
                let state = app_handle.state::<UiState>();
                state.quitting.store(true, Ordering::SeqCst);
                app_handle.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn get_click_through(state: State<'_, UiState>) -> bool {
    state.click_through.load(Ordering::SeqCst)
}

#[tauri::command]
fn set_click_through(
    app: AppHandle,
    state: State<'_, UiState>,
    enabled: bool,
) -> Result<bool, String> {
    set_click_through_internal(&app, &state, enabled)
}

#[tauri::command]
fn toggle_click_through(app: AppHandle, state: State<'_, UiState>) -> Result<bool, String> {
    let next = !state.click_through.load(Ordering::SeqCst);
    set_click_through_internal(&app, &state, next)
}

#[tauri::command]
fn get_locked(state: State<'_, UiState>) -> bool {
    state.locked.load(Ordering::SeqCst)
}

#[tauri::command]
fn set_locked(app: AppHandle, state: State<'_, UiState>, locked: bool) -> Result<bool, String> {
    set_locked_internal(&app, &state, locked)
}

#[tauri::command]
fn toggle_locked(app: AppHandle, state: State<'_, UiState>) -> Result<bool, String> {
    let next = !state.locked.load(Ordering::SeqCst);
    set_locked_internal(&app, &state, next)
}

#[tauri::command]
fn get_snap_enabled(state: State<'_, UiState>) -> bool {
    state.snap_enabled.load(Ordering::SeqCst)
}

#[tauri::command]
fn set_snap_enabled(
    app: AppHandle,
    state: State<'_, UiState>,
    enabled: bool,
) -> Result<bool, String> {
    set_snap_internal(&app, &state, enabled)
}

#[tauri::command]
fn toggle_snap_enabled(app: AppHandle, state: State<'_, UiState>) -> Result<bool, String> {
    let next = !state.snap_enabled.load(Ordering::SeqCst);
    set_snap_internal(&app, &state, next)
}

#[tauri::command]
fn log_frontend_error(
    diagnostics: State<'_, SharedDiagnosticsState>,
    level: Option<String>,
    message: String,
    context: Option<String>,
) -> Result<(), String> {
    let normalized_level = level
        .as_deref()
        .map(|value| value.to_lowercase())
        .unwrap_or_else(|| "error".to_string());

    match normalized_level.as_str() {
        "debug" => tracing::debug!(context = ?context, "frontend: {message}"),
        "info" => tracing::info!(context = ?context, "frontend: {message}"),
        "warn" | "warning" => tracing::warn!(context = ?context, "frontend: {message}"),
        _ => tracing::error!(context = ?context, "frontend: {message}"),
    }

    diagnostics.record_error(normalized_level, message, context);
    Ok(())
}

#[tauri::command]
fn report_runtime_metrics(
    diagnostics: State<'_, SharedDiagnosticsState>,
    fps: Option<f64>,
    model_load_ms: Option<f64>,
) {
    diagnostics.set_metrics(fps, model_load_ms);
}

#[tauri::command]
fn get_diagnostics_snapshot(
    diagnostics: State<'_, SharedDiagnosticsState>,
) -> DiagnosticsSnapshot {
    diagnostics.snapshot()
}

#[tauri::command]
fn open_input_monitoring_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
            .status()
            .map_err(|error| format!("failed to open System Settings: {error}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("open_input_monitoring_settings is only available on macOS.".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(UiState::default())
        .manage(Arc::new(InputListenerState::default()))
        .manage(Arc::new(DiagnosticsState::default()))
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if let Err(error) = init_logging(app) {
                eprintln!("failed to initialize logging: {error}");
            } else {
                tracing::info!("logging initialized");
            }

            init_tray(app)?;

            let state = app.state::<UiState>();
            if let Err(error) = set_click_through_internal(app.handle(), &state, false) {
                tracing::error!("failed to initialize click-through state: {error}");
                record_backend_error(app.handle(), format!("init click-through failed: {error}"));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let state = app.state::<UiState>();
                if !state.quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        tracing::error!("failed to hide window on close request: {error}");
                        record_backend_error(&app, format!("hide window on close failed: {error}"));
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            start_listener,
            stop_listener,
            find_model3_json,
            get_click_through,
            set_click_through,
            toggle_click_through,
            get_locked,
            set_locked,
            toggle_locked,
            get_snap_enabled,
            set_snap_enabled,
            toggle_snap_enabled,
            log_frontend_error,
            report_runtime_metrics,
            get_diagnostics_snapshot,
            open_input_monitoring_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
