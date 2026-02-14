import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { check as checkUpdater } from "@tauri-apps/plugin-updater";
import {
  getDiagnosticsSnapshot,
  logFrontendError,
  type DiagnosticInputEvent,
  type DiagnosticsSnapshot,
} from "../lib/diagnostics";
import {
  DEFAULT_PET_SETTINGS,
  loadPetSettings,
  normalizePetSettings,
  savePetSettings,
  type MotionMap,
  type PetSettings,
} from "../lib/settings";

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function dirname(path: string) {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex > 0 ? path.slice(0, separatorIndex) : path;
}

function toClockTime(timestamp?: number) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return "--:--:--";
  }

  const date = new Date(timestamp);
  return date.toLocaleTimeString();
}

function formatInputEvent(event: DiagnosticInputEvent) {
  const segments = [event.type];
  if (event.keyCode) {
    segments.push(`key=${event.keyCode}`);
  }
  if (event.button) {
    segments.push(`button=${event.button}`);
  }
  if (typeof event.x === "number" && typeof event.y === "number") {
    segments.push(`x=${event.x.toFixed(1)}`);
    segments.push(`y=${event.y.toFixed(1)}`);
  }
  return segments.join(" | ");
}

const EMPTY_DIAGNOSTICS: DiagnosticsSnapshot = {
  inputEvents: [],
  recentErrors: [],
};

export default function SettingsPanel() {
  const [draft, setDraft] = useState<PetSettings>(DEFAULT_PET_SETTINGS);
  const [motionMapText, setMotionMapText] = useState(formatJson(DEFAULT_PET_SETTINGS.motionMap));
  const [message, setMessage] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot>(EMPTY_DIAGNOSTICS);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const modelRoot = useMemo(() => dirname(draft.modelPath), [draft.modelPath]);
  const recentInputEvents = useMemo(
    () => diagnostics.inputEvents.slice(-50).reverse(),
    [diagnostics.inputEvents],
  );
  const recentErrors = useMemo(
    () => diagnostics.recentErrors.slice(-50).reverse(),
    [diagnostics.recentErrors],
  );

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const settings = await loadPetSettings();
        if (disposed) {
          return;
        }
        setDraft(settings);
        setMotionMapText(formatJson(settings.motionMap));
        const enabled = await isAutostartEnabled();
        if (!disposed) {
          setAutostartEnabled(enabled);
        }
      } catch (error) {
        if (!disposed) {
          setMessage(`加载设置失败: ${String(error)}`);
          void logFrontendError("Settings: load initial state failed", error, {
            level: "error",
          });
        }
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    const pollDiagnostics = async () => {
      try {
        const snapshot = await getDiagnosticsSnapshot();
        if (!disposed) {
          setDiagnostics(snapshot);
        }
      } catch (error) {
        if (!disposed) {
          console.error("Failed to fetch diagnostics snapshot:", error);
        }
      }
    };

    void pollDiagnostics();
    const timer = window.setInterval(() => {
      void pollDiagnostics();
    }, 1_000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const toggleAutostart = async () => {
    const next = !autostartEnabled;
    setAutostartBusy(true);
    try {
      if (next) {
        await enableAutostart();
      } else {
        await disableAutostart();
      }
      const enabled = await isAutostartEnabled();
      setAutostartEnabled(enabled);
      setMessage(enabled ? "已启用开机自启。" : "已关闭开机自启。");
    } catch (error) {
      setMessage(`切换开机自启失败: ${String(error)}`);
      void logFrontendError("Settings: toggle autostart failed", error, {
        level: "error",
      });
    } finally {
      setAutostartBusy(false);
    }
  };

  const checkForUpdates = async () => {
    setCheckingUpdate(true);
    setUpdateStatus("正在检查更新...");
    try {
      const update = await checkUpdater();
      if (!update) {
        setUpdateStatus("当前已是最新版本。");
        return;
      }

      const parts = [`发现新版本 ${update.version}`];
      if (update.date) {
        parts.push(new Date(update.date).toLocaleString());
      }
      if (typeof update.body === "string" && update.body.trim().length > 0) {
        parts.push(update.body.trim());
      }
      setUpdateStatus(parts.join(" | "));
    } catch (error) {
      setUpdateStatus(`检查更新失败: ${String(error)}`);
      void logFrontendError("Settings: check updater failed", error, {
        level: "error",
      });
    } finally {
      setCheckingUpdate(false);
    }
  };

  const pickModelDirectory = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择 Live2D 模型根目录",
        defaultPath: modelRoot,
      });

      if (typeof selected !== "string") {
        return;
      }

      const modelFile = await invoke<string>("find_model3_json", {
        directory: selected,
      });

      setDraft((previous) => ({ ...previous, modelPath: modelFile }));
      setMessage(`已选择模型: ${modelFile}`);
    } catch (error) {
      setMessage(`目录无效：${String(error)}`);
      void logFrontendError("Settings: pick model directory failed", error, {
        level: "warn",
      });
    }
  };

  const triggerImportMotionMap = () => {
    importInputRef.current?.click();
  };

  const handleImportMotionMap = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      setMotionMapText(formatJson(parsed));
      setMessage(`已导入 motionMap: ${file.name}`);
    } catch (error) {
      setMessage(`导入失败（请确认是合法 JSON）: ${String(error)}`);
      void logFrontendError("Settings: import motion map failed", error, {
        level: "warn",
      });
    }
  };

  const exportMotionMap = () => {
    try {
      const parsed = JSON.parse(motionMapText) as MotionMap;
      const normalizedMotionMap = normalizePetSettings({
        ...draft,
        motionMap: parsed,
      }).motionMap;

      const blob = new Blob([formatJson(normalizedMotionMap)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "motionMap.json";
      link.click();
      URL.revokeObjectURL(url);
      setMessage("已导出 motionMap.json");
    } catch (error) {
      setMessage(`导出失败（动作映射 JSON 无效）: ${String(error)}`);
      void logFrontendError("Settings: export motion map failed", error, {
        level: "warn",
      });
    }
  };

  const save = async () => {
    let parsedMotionMap: MotionMap;
    try {
      parsedMotionMap = JSON.parse(motionMapText) as MotionMap;
    } catch (error) {
      setMessage(`动作映射 JSON 解析失败: ${String(error)}`);
      return;
    }

    const normalized = normalizePetSettings({
      ...draft,
      motionMap: parsedMotionMap,
    });

    setSaving(true);
    try {
      const saved = await savePetSettings(normalized);
      setDraft(saved);
      setMotionMapText(formatJson(saved.motionMap));
      await emitTo("main", "pet-settings-updated", saved);
      setMessage("设置已保存，并已通知主窗口刷新。");
    } catch (error) {
      setMessage(`保存失败: ${String(error)}`);
      void logFrontendError("Settings: save settings failed", error, {
        level: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setDraft(DEFAULT_PET_SETTINGS);
    setMotionMapText(formatJson(DEFAULT_PET_SETTINGS.motionMap));
    setMessage("已恢复到默认值，点击保存后生效。");
  };

  return (
    <main className="settings-page">
      <h1>桌宠设置</h1>

      <section className="settings-group">
        <label className="settings-label">模型根目录</label>
        <div className="settings-inline">
          <button type="button" onClick={pickModelDirectory}>
            选择目录
          </button>
          <code className="settings-code">{modelRoot}</code>
        </div>
        <p className="settings-help">当前模型文件：{draft.modelPath}</p>
      </section>

      <section className="settings-group">
        <label className="settings-label">缩放 ({draft.scale.toFixed(2)})</label>
        <input
          type="range"
          min={0.2}
          max={3}
          step={0.05}
          value={draft.scale}
          onChange={(event) =>
            setDraft((previous) => ({
              ...previous,
              scale: Number(event.currentTarget.value),
            }))
          }
        />
      </section>

      <section className="settings-group">
        <label className="settings-label">位置微调</label>
        <div className="settings-grid">
          <label>
            X
            <input
              type="number"
              step={1}
              value={draft.pos.x}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  pos: { ...previous.pos, x: Number(event.currentTarget.value) },
                }))
              }
            />
          </label>
          <label>
            Y
            <input
              type="number"
              step={1}
              value={draft.pos.y}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  pos: { ...previous.pos, y: Number(event.currentTarget.value) },
                }))
              }
            />
          </label>
        </div>
      </section>

      <section className="settings-group">
        <label className="settings-label">动作映射表 motionMap.json</label>
        <div className="settings-inline settings-inline-wrap">
          <button type="button" onClick={triggerImportMotionMap}>
            导入 JSON
          </button>
          <button type="button" onClick={exportMotionMap}>
            导出 JSON
          </button>
        </div>
        <textarea
          value={motionMapText}
          onChange={(event) => setMotionMapText(event.currentTarget.value)}
          rows={12}
          spellCheck={false}
        />
        <p className="settings-help">
          示例: {"{ \"KeyA\":\"tap_left\", \"KeyD\":\"tap_right\", \"MouseLeft\":\"tap\", \"idle\":[\"idle_1\",\"idle_2\"] }"}
        </p>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          onChange={handleImportMotionMap}
        />
      </section>

      <section className="settings-group">
        <label className="settings-label">开机自启</label>
        <div className="settings-inline">
          <span>{autostartEnabled ? "Enabled" : "Disabled"}</span>
          <button type="button" onClick={toggleAutostart} disabled={autostartBusy}>
            {autostartBusy
              ? "切换中..."
              : autostartEnabled
                ? "关闭自启"
                : "启用自启"}
          </button>
        </div>
      </section>

      <section className="settings-group">
        <label className="settings-label">应用更新</label>
        <div className="settings-inline">
          <button
            type="button"
            onClick={checkForUpdates}
            disabled={checkingUpdate}
          >
            {checkingUpdate ? "检查中..." : "检查更新"}
          </button>
        </div>
        <p className="settings-help">
          更新源（占位）: https://example.com/live2d-desktop-pet/latest.json
        </p>
        {updateStatus ? <p className="settings-help">{updateStatus}</p> : null}
      </section>

      <section className="settings-group">
        <label className="settings-label">诊断面板</label>
        <div className="settings-diagnostics-meta">
          <span>
            FPS:{" "}
            {typeof diagnostics.fps === "number"
              ? diagnostics.fps.toFixed(1)
              : "--"}
          </span>
          <span>
            模型加载耗时:{" "}
            {typeof diagnostics.modelLoadMs === "number"
              ? `${diagnostics.modelLoadMs.toFixed(0)} ms`
              : "--"}
          </span>
        </div>

        <div className="settings-diagnostics-grid">
          <article className="settings-diagnostics-block">
            <h2>最近 50 条输入事件</h2>
            <ul className="settings-diagnostics-list">
              {recentInputEvents.length === 0 ? (
                <li className="settings-diagnostics-empty">暂无输入事件</li>
              ) : (
                recentInputEvents.map((event) => (
                  <li
                    key={`${event.timestamp}-${event.type}-${event.keyCode ?? ""}-${event.button ?? ""}`}
                  >
                    <time>{toClockTime(event.timestamp)}</time>
                    <code>{formatInputEvent(event)}</code>
                  </li>
                ))
              )}
            </ul>
          </article>

          <article className="settings-diagnostics-block">
            <h2>最近错误</h2>
            <ul className="settings-diagnostics-list">
              {recentErrors.length === 0 ? (
                <li className="settings-diagnostics-empty">暂无错误</li>
              ) : (
                recentErrors.map((record, index) => (
                  <li key={`${record.timestamp}-${record.level}-${index}`}>
                    <time>{toClockTime(record.timestamp)}</time>
                    <code>
                      [{record.level}] {record.message}
                      {record.context ? ` | ${record.context}` : ""}
                    </code>
                  </li>
                ))
              )}
            </ul>
          </article>
        </div>
      </section>

      <section className="settings-actions">
        <button type="button" onClick={reset}>
          恢复默认
        </button>
        <button type="button" onClick={save} disabled={saving}>
          {saving ? "保存中..." : "保存并应用"}
        </button>
      </section>

      {message ? <p className="settings-message">{message}</p> : null}
    </main>
  );
}
