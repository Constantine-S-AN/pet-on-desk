import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import PetStage from "./components/PetStage";
import PermissionWizard, {
  type InputHealthPayload,
} from "./components/PermissionWizard";
import SettingsPanel from "./components/SettingsPanel";
import { onTauriEvent } from "./lib/events";
import {
  DEFAULT_PET_SETTINGS,
  DEFAULT_WINDOW_INTERACTION_PREFS,
  loadPermissionWizardSeen,
  loadPetSettings,
  loadWindowInteractionPrefs,
  normalizePetSettings,
  savePermissionWizardSeen,
  saveWindowInteractionPrefs,
  type WindowInteractionPrefs,
  type PetSettings,
} from "./lib/settings";
import {
  clampPositionToMonitor,
  monitorKey,
  positionsEqual,
  snapPositionToEdges,
  type WindowPosition,
} from "./lib/windowInteraction";
import "./App.css";

type ClickThroughChangedPayload = {
  enabled: boolean;
};

type LockChangedPayload = {
  locked: boolean;
};

type SnapChangedPayload = {
  enabled: boolean;
};

function App() {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const windowLabel = useMemo(() => appWindow.label, [appWindow]);
  const isSettingsWindow = windowLabel === "settings";

  const [clickThrough, setClickThrough] = useState(false);
  const [locked, setLocked] = useState(DEFAULT_WINDOW_INTERACTION_PREFS.locked);
  const [snapEnabled, setSnapEnabled] = useState(
    DEFAULT_WINDOW_INTERACTION_PREFS.snapEnabled,
  );
  const [settings, setSettings] = useState<PetSettings>(DEFAULT_PET_SETTINGS);
  const [permissionWizardSeen, setPermissionWizardSeen] = useState(true);
  const [showFirstRunWizard, setShowFirstRunWizard] = useState(false);
  const [showHealthWizard, setShowHealthWizard] = useState(false);
  const [inputHealth, setInputHealth] = useState<InputHealthPayload | null>(null);

  const settingsRef = useRef(settings);
  const snapEnabledRef = useRef(snapEnabled);
  const interactionPrefsRef = useRef<WindowInteractionPrefs>(
    DEFAULT_WINDOW_INTERACTION_PREFS,
  );
  const monitorKeyRef = useRef<string | null>(null);
  const persistInteractionTimerRef = useRef<number | null>(null);
  const suppressMovedEventsUntilRef = useRef(0);
  const pendingMoveRef = useRef<WindowPosition | null>(null);
  const processingMoveRef = useRef(false);

  const shortcutMeta = useMemo(() => {
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    const meta = isMac ? "Cmd" : "Ctrl";
    return {
      clickThrough: `${meta}+Shift+P`,
      lock: `${meta}+Shift+L`,
      snap: `${meta}+Shift+S`,
    };
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    snapEnabledRef.current = snapEnabled;
  }, [snapEnabled]);

  const persistInteractionPrefs = useCallback((next: WindowInteractionPrefs) => {
    interactionPrefsRef.current = next;

    if (persistInteractionTimerRef.current !== null) {
      window.clearTimeout(persistInteractionTimerRef.current);
    }

    persistInteractionTimerRef.current = window.setTimeout(() => {
      const snapshot = interactionPrefsRef.current;
      void saveWindowInteractionPrefs(snapshot).catch((error) => {
        console.error("Failed to save window interaction prefs:", error);
      });
      persistInteractionTimerRef.current = null;
    }, 200);
  }, []);

  const setLockedAndPersist = useCallback(
    (value: boolean) => {
      setLocked(value);
      persistInteractionPrefs({
        ...interactionPrefsRef.current,
        locked: value,
      });
    },
    [persistInteractionPrefs],
  );

  const setSnapAndPersist = useCallback(
    (value: boolean) => {
      setSnapEnabled(value);
      persistInteractionPrefs({
        ...interactionPrefsRef.current,
        snapEnabled: value,
      });
    },
    [persistInteractionPrefs],
  );

  const upsertDisplayProfile = useCallback(
    (displayId: string, position: WindowPosition, scale: number) => {
      persistInteractionPrefs({
        ...interactionPrefsRef.current,
        displayProfiles: {
          ...interactionPrefsRef.current.displayProfiles,
          [displayId]: {
            windowX: Math.round(position.x),
            windowY: Math.round(position.y),
            scale,
          },
        },
      });
    },
    [persistInteractionPrefs],
  );

  const toggleClickThrough = useCallback(async () => {
    try {
      const next = await invoke<boolean>("toggle_click_through");
      setClickThrough(next);
    } catch (error) {
      console.error("Failed to toggle click-through:", error);
    }
  }, []);

  const toggleLocked = useCallback(async () => {
    try {
      const next = await invoke<boolean>("toggle_locked");
      setLockedAndPersist(next);
    } catch (error) {
      console.error("Failed to toggle lock state:", error);
    }
  }, [setLockedAndPersist]);

  const toggleSnapEnabled = useCallback(async () => {
    try {
      const next = await invoke<boolean>("toggle_snap_enabled");
      setSnapAndPersist(next);
    } catch (error) {
      console.error("Failed to toggle snap state:", error);
    }
  }, [setSnapAndPersist]);

  useEffect(() => {
    if (isSettingsWindow) {
      return;
    }

    let disposed = false;
    let unlistenSettingsUpdate: (() => void) | undefined;

    const load = async () => {
      try {
        const loaded = await loadPetSettings();
        if (!disposed) {
          setSettings(loaded);
        }
      } catch (error) {
        if (!disposed) {
          console.error("Failed to load pet settings:", error);
        }
      }

      unlistenSettingsUpdate = await onTauriEvent<PetSettings>(
        "pet-settings-updated",
        (event) => {
          setSettings(normalizePetSettings(event.payload));
        },
      );
    };

    void load();

    return () => {
      disposed = true;
      unlistenSettingsUpdate?.();
    };
  }, [isSettingsWindow]);

  useEffect(() => {
    if (isSettingsWindow) {
      return;
    }

    let disposed = false;

    const loadWizardState = async () => {
      try {
        const seen = await loadPermissionWizardSeen();
        if (disposed) {
          return;
        }
        setPermissionWizardSeen(seen);
        setShowFirstRunWizard(!seen);
      } catch (error) {
        if (!disposed) {
          console.error("Failed to load permission wizard state:", error);
          setPermissionWizardSeen(false);
          setShowFirstRunWizard(true);
        }
      }
    };

    void loadWizardState();

    return () => {
      disposed = true;
    };
  }, [isSettingsWindow]);

  useEffect(() => {
    if (isSettingsWindow) {
      return;
    }

    let disposed = false;
    let unlistenClickThroughChanged: (() => void) | undefined;

    const init = async () => {
      try {
        const enabled = await invoke<boolean>("get_click_through");
        if (!disposed) {
          setClickThrough(enabled);
        }
      } catch (error) {
        if (!disposed) {
          console.error("Failed to get click-through status:", error);
        }
      }

      unlistenClickThroughChanged = await onTauriEvent<ClickThroughChangedPayload>(
        "click-through-changed",
        (event) => {
          setClickThrough(Boolean(event.payload?.enabled));
        },
      );
    };

    void init();

    return () => {
      disposed = true;
      unlistenClickThroughChanged?.();
    };
  }, [isSettingsWindow]);

  useEffect(() => {
    if (isSettingsWindow) {
      return;
    }

    let disposed = false;
    let unlistenLockChanged: (() => void) | undefined;
    let unlistenSnapChanged: (() => void) | undefined;

    const init = async () => {
      try {
        const stored = await loadWindowInteractionPrefs();
        if (disposed) {
          return;
        }
        interactionPrefsRef.current = stored;

        setLocked(stored.locked);
        setSnapEnabled(stored.snapEnabled);

        await invoke<boolean>("set_locked", { locked: stored.locked });
        await invoke<boolean>("set_snap_enabled", { enabled: stored.snapEnabled });
      } catch (error) {
        if (!disposed) {
          console.error("Failed to initialize window interaction prefs:", error);
        }
      }

      try {
        const rustLocked = await invoke<boolean>("get_locked");
        if (!disposed) {
          setLockedAndPersist(rustLocked);
        }
      } catch (error) {
        if (!disposed) {
          console.error("Failed to get lock state:", error);
        }
      }

      try {
        const rustSnapEnabled = await invoke<boolean>("get_snap_enabled");
        if (!disposed) {
          setSnapAndPersist(rustSnapEnabled);
        }
      } catch (error) {
        if (!disposed) {
          console.error("Failed to get snap state:", error);
        }
      }

      unlistenLockChanged = await onTauriEvent<LockChangedPayload>(
        "lock-changed",
        (event) => {
          setLockedAndPersist(Boolean(event.payload?.locked));
        },
      );

      unlistenSnapChanged = await onTauriEvent<SnapChangedPayload>(
        "snap-changed",
        (event) => {
          setSnapAndPersist(Boolean(event.payload?.enabled));
        },
      );
    };

    void init();

    return () => {
      disposed = true;
      unlistenLockChanged?.();
      unlistenSnapChanged?.();
    };
  }, [isSettingsWindow, setLockedAndPersist, setSnapAndPersist]);

  useEffect(() => {
    if (isSettingsWindow) {
      return;
    }

    let unlistenInputHealth: (() => void) | undefined;

    const listenInputHealth = async () => {
      unlistenInputHealth = await onTauriEvent<InputHealthPayload>(
        "input-health",
        (event) => {
          const payload = event.payload;
          setInputHealth(payload);
          if (payload.ok) {
            setShowHealthWizard(false);
          } else {
            setShowHealthWizard(true);
          }
        },
      );
    };

    void listenInputHealth();

    return () => {
      unlistenInputHealth?.();
    };
  }, [isSettingsWindow]);

  useEffect(() => {
    if (isSettingsWindow) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const withModifier = event.metaKey || event.ctrlKey;
      const withShift = event.shiftKey;
      if (!withModifier || !withShift) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "p") {
        event.preventDefault();
        void toggleClickThrough();
        return;
      }

      if (key === "l") {
        event.preventDefault();
        void toggleLocked();
        return;
      }

      if (key === "s") {
        event.preventDefault();
        void toggleSnapEnabled();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSettingsWindow, toggleClickThrough, toggleLocked, toggleSnapEnabled]);

  useEffect(() => {
    if (isSettingsWindow) {
      return;
    }

    let disposed = false;
    let unlistenMoved: (() => void) | undefined;

    const applyWindowPosition = async (position: WindowPosition) => {
      suppressMovedEventsUntilRef.current = Date.now() + 180;
      await appWindow.setPosition(
        new PhysicalPosition(Math.round(position.x), Math.round(position.y)),
      );
    };

    const processMoveQueue = async () => {
      if (processingMoveRef.current || disposed) {
        return;
      }

      processingMoveRef.current = true;
      try {
        while (pendingMoveRef.current && !disposed) {
          const pending = pendingMoveRef.current;
          pendingMoveRef.current = null;

          if (Date.now() < suppressMovedEventsUntilRef.current) {
            continue;
          }

          const [monitor, windowSize] = await Promise.all([
            currentMonitor(),
            appWindow.outerSize(),
          ]);
          if (!monitor) {
            continue;
          }

          let position: WindowPosition = {
            x: Math.round(pending.x),
            y: Math.round(pending.y),
          };

          const clamped = clampPositionToMonitor(position, monitor, windowSize);
          if (!positionsEqual(clamped, position)) {
            await applyWindowPosition(clamped);
            position = clamped;
          }

          if (snapEnabledRef.current) {
            const snapped = snapPositionToEdges(position, monitor, windowSize, 16);
            if (snapped.snapped && !positionsEqual(snapped.position, position)) {
              await applyWindowPosition(snapped.position);
              position = snapped.position;
            }
          }

          const displayId = monitorKey(monitor);
          const switchedDisplay = monitorKeyRef.current !== displayId;
          monitorKeyRef.current = displayId;

          const profile = interactionPrefsRef.current.displayProfiles[displayId];
          if (switchedDisplay && profile) {
            const targetPosition = clampPositionToMonitor(
              {
                x: profile.windowX,
                y: profile.windowY,
              },
              monitor,
              windowSize,
            );

            if (!positionsEqual(targetPosition, position)) {
              await applyWindowPosition(targetPosition);
              position = targetPosition;
            }

            if (Math.abs(settingsRef.current.scale - profile.scale) > 0.001) {
              setSettings((previous) => ({ ...previous, scale: profile.scale }));
            }
          }

          const scaleForProfile =
            switchedDisplay && profile ? profile.scale : settingsRef.current.scale;
          upsertDisplayProfile(displayId, position, scaleForProfile);
        }
      } catch (error) {
        console.error("Failed while processing moved events:", error);
      } finally {
        processingMoveRef.current = false;
      }
    };

    const initDisplayPlacement = async () => {
      try {
        const [monitor, position, windowSize] = await Promise.all([
          currentMonitor(),
          appWindow.outerPosition(),
          appWindow.outerSize(),
        ]);
        if (!monitor || disposed) {
          return;
        }

        const displayId = monitorKey(monitor);
        monitorKeyRef.current = displayId;

        let initialPosition: WindowPosition = {
          x: Math.round(position.x),
          y: Math.round(position.y),
        };

        const profile = interactionPrefsRef.current.displayProfiles[displayId];
        if (profile) {
          const target = clampPositionToMonitor(
            { x: profile.windowX, y: profile.windowY },
            monitor,
            windowSize,
          );
          if (!positionsEqual(target, initialPosition)) {
            await applyWindowPosition(target);
            initialPosition = target;
          }

          if (Math.abs(settingsRef.current.scale - profile.scale) > 0.001) {
            setSettings((previous) => ({ ...previous, scale: profile.scale }));
          }
        } else {
          const clamped = clampPositionToMonitor(initialPosition, monitor, windowSize);
          if (!positionsEqual(clamped, initialPosition)) {
            await applyWindowPosition(clamped);
            initialPosition = clamped;
          }
        }

        upsertDisplayProfile(
          displayId,
          initialPosition,
          profile?.scale ?? settingsRef.current.scale,
        );
      } catch (error) {
        console.error("Failed to initialize display placement:", error);
      }
    };

    const init = async () => {
      await initDisplayPlacement();
      if (disposed) {
        return;
      }

      unlistenMoved = await appWindow.onMoved(({ payload }) => {
        pendingMoveRef.current = { x: payload.x, y: payload.y };
        void processMoveQueue();
      });
    };

    void init();

    return () => {
      disposed = true;
      unlistenMoved?.();
    };
  }, [appWindow, isSettingsWindow, upsertDisplayProfile]);

  useEffect(() => {
    if (isSettingsWindow) {
      return;
    }

    const displayId = monitorKeyRef.current;
    if (!displayId) {
      return;
    }

    let cancelled = false;
    const persistScaleForDisplay = async () => {
      try {
        const position = await appWindow.outerPosition();
        if (cancelled) {
          return;
        }
        upsertDisplayProfile(
          displayId,
          { x: Math.round(position.x), y: Math.round(position.y) },
          settings.scale,
        );
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to persist display scale profile:", error);
        }
      }
    };

    void persistScaleForDisplay();

    return () => {
      cancelled = true;
    };
  }, [appWindow, isSettingsWindow, settings.scale, upsertDisplayProfile]);

  useEffect(() => {
    return () => {
      if (persistInteractionTimerRef.current !== null) {
        window.clearTimeout(persistInteractionTimerRef.current);
      }

      void saveWindowInteractionPrefs(interactionPrefsRef.current).catch((error) => {
        console.error("Failed to flush window interaction prefs:", error);
      });
    };
  }, []);

  const closePermissionWizard = useCallback(async () => {
    if (!permissionWizardSeen) {
      try {
        await savePermissionWizardSeen(true);
      } catch (error) {
        console.error("Failed to persist permission wizard state:", error);
      }
      setPermissionWizardSeen(true);
    }
    setShowFirstRunWizard(false);
    setShowHealthWizard(false);
  }, [permissionWizardSeen]);

  const showPermissionWizard = showFirstRunWizard || showHealthWizard;

  const startWindowDrag = useCallback(
    async (event: ReactPointerEvent<HTMLElement>) => {
      if (isSettingsWindow || showPermissionWizard || clickThrough || locked) {
        return;
      }
      if (event.button !== 0) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target?.closest(".permission-wizard")) {
        return;
      }

      try {
        await appWindow.startDragging();
      } catch (error) {
        console.error("Failed to start window dragging:", error);
      }
    },
    [appWindow, clickThrough, isSettingsWindow, locked, showPermissionWizard],
  );

  if (isSettingsWindow) {
    return <SettingsPanel />;
  }

  return (
    <main className="container" onPointerDown={startWindowDrag}>
      <PetStage
        modelPath={settings.modelPath}
        scale={settings.scale}
        pos={settings.pos}
        motionMap={settings.motionMap}
      />

      <section className="hud">
        <h1>live2d-desktop-pet</h1>
        <p className="status">
          Click: <strong>{clickThrough ? "Click-through" : "Locked"}</strong>
        </p>
        <p className="status">
          Move: <strong>{locked ? "Locked" : "Unlocked"}</strong>
        </p>
        <p className="status">
          Snap: <strong>{snapEnabled ? "On" : "Off"}</strong>
        </p>
        <p className="hint">Click-through: {shortcutMeta.clickThrough}</p>
        <p className="hint">Lock/Unlock: {shortcutMeta.lock}</p>
        <p className="hint">Snap Toggle: {shortcutMeta.snap}</p>
      </section>

      <PermissionWizard
        visible={showPermissionWizard}
        health={inputHealth}
        onClose={() => {
          void closePermissionWizard();
        }}
      />
    </main>
  );
}

export default App;
