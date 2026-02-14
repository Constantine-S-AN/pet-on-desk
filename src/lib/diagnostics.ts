import { invoke } from "@tauri-apps/api/core";

export type DiagnosticInputEvent = {
  type: string;
  keyCode?: string;
  button?: string;
  x?: number;
  y?: number;
  timestamp: number;
};

export type DiagnosticErrorRecord = {
  level: string;
  message: string;
  context?: string;
  timestamp: number;
};

export type DiagnosticsSnapshot = {
  inputEvents: DiagnosticInputEvent[];
  fps?: number;
  modelLoadMs?: number;
  recentErrors: DiagnosticErrorRecord[];
};

function stringifyUnknown(error: unknown) {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function logFrontendError(
  message: string,
  error?: unknown,
  options?: { level?: "debug" | "info" | "warn" | "error"; context?: string },
) {
  const details = error ? stringifyUnknown(error) : undefined;
  const context = [options?.context, details].filter(Boolean).join(" | ");

  try {
    await invoke("log_frontend_error", {
      level: options?.level ?? "error",
      message,
      context: context.length > 0 ? context : undefined,
    });
  } catch (invokeError) {
    console.error("Failed to forward frontend error to Rust logger:", invokeError);
  }
}

export async function reportRuntimeMetrics(payload: {
  fps?: number;
  modelLoadMs?: number;
}) {
  try {
    await invoke("report_runtime_metrics", payload);
  } catch (error) {
    console.error("Failed to report runtime metrics:", error);
  }
}

export async function getDiagnosticsSnapshot() {
  const snapshot = await invoke<DiagnosticsSnapshot>("get_diagnostics_snapshot");

  return {
    inputEvents: Array.isArray(snapshot.inputEvents) ? snapshot.inputEvents : [],
    fps: snapshot.fps,
    modelLoadMs: snapshot.modelLoadMs,
    recentErrors: Array.isArray(snapshot.recentErrors)
      ? snapshot.recentErrors
      : [],
  };
}
