import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type InputHealthPayload = {
  ok: boolean;
  reason?: string;
  platform: string;
};

type PermissionWizardProps = {
  visible: boolean;
  health: InputHealthPayload | null;
  onClose: () => void;
};

export default function PermissionWizard({
  visible,
  health,
  onClose,
}: PermissionWizardProps) {
  const [opening, setOpening] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isMac = useMemo(() => {
    if (health?.platform) {
      return health.platform === "macos";
    }
    return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  }, [health?.platform]);

  const noEventsDetected =
    health?.ok === false && health.reason === "no_events_detected";

  if (!visible) {
    return null;
  }

  const openInputMonitoring = async () => {
    setOpening(true);
    setErrorMessage(null);
    try {
      await invoke("open_input_monitoring_settings");
    } catch (error) {
      setErrorMessage(`打开系统设置失败：${String(error)}`);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="permission-wizard-backdrop">
      <section className="permission-wizard">
        <h2>Permission Wizard</h2>

        <p>
          桌宠需要读取全局键鼠输入，macOS 下通常需要授权{" "}
          <strong>Input Monitoring</strong> 和{" "}
          <strong>Accessibility</strong>。
        </p>

        <p>
          路径：<strong>System Settings → Privacy &amp; Security → Input Monitoring</strong>
        </p>

        <p>
          同时建议检查：<strong>System Settings → Privacy &amp; Security → Accessibility</strong>
        </p>

        {noEventsDetected ? (
          <p className="permission-wizard-warning">
            检测到 3 秒内无输入事件（no_events_detected），通常表示权限未开启或尚未生效。
          </p>
        ) : null}

        <p className="permission-wizard-tip">
          开启权限后请重启应用，以确保监听恢复正常。
        </p>

        <div className="permission-wizard-actions">
          <button
            type="button"
            onClick={openInputMonitoring}
            disabled={opening || !isMac}
          >
            {opening ? "打开中..." : "打开系统设置页面（Input Monitoring）"}
          </button>

          <button type="button" onClick={onClose}>
            我知道了
          </button>
        </div>

        {!isMac ? (
          <p className="permission-wizard-tip">
            当前平台不是 macOS，请按系统对应方式授予全局输入监听权限。
          </p>
        ) : null}

        {errorMessage ? <p className="permission-wizard-error">{errorMessage}</p> : null}
      </section>
    </div>
  );
}
