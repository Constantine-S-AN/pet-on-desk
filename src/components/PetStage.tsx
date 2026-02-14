import { useCallback, useEffect, useMemo, useRef } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display/cubism4";
import { onTauriEvent } from "../lib/events";
import {
  disposeMotionEngine,
  handleInput,
  type MotionEngineInputEvent,
} from "../lib/motionEngine";
import { logFrontendError, reportRuntimeMetrics } from "../lib/diagnostics";
import { DEFAULT_MOTION_MAP, type MotionMap } from "../lib/settings";

type PetStageProps = {
  modelPath: string;
  scale: number;
  pos: {
    x: number;
    y: number;
  };
  motionMap: MotionMap;
};

type GlobalInputPayload = MotionEngineInputEvent;

const FALLBACK_MODEL_PATH =
  "https://raw.githubusercontent.com/guansss/pixi-live2d-display/master/test/assets/haru/haru_greeter_t03.model3.json";
const CUBISM_CORE_URL =
  "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js";

let cubismCorePromise: Promise<void> | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

async function ensureCubismCore() {
  if ((window as Window & { Live2DCubismCore?: unknown }).Live2DCubismCore) {
    return;
  }

  if (!cubismCorePromise) {
    cubismCorePromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        'script[data-live2d-cubism-core="true"]',
      );

      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener(
          "error",
          () => reject(new Error("Failed to load Cubism Core script.")),
          { once: true },
        );
        return;
      }

      const script = document.createElement("script");
      script.src = CUBISM_CORE_URL;
      script.async = true;
      script.dataset.live2dCubismCore = "true";
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error("Failed to load Cubism Core script."));
      document.head.appendChild(script);
    }).catch((error) => {
      cubismCorePromise = null;
      throw error;
    });
  }

  await cubismCorePromise;
}

function resolveModelSource(path: string) {
  if (
    path.startsWith("/models/") ||
    path.startsWith("http://") ||
    path.startsWith("https://") ||
    path.startsWith("asset://")
  ) {
    return path;
  }
  return convertFileSrc(path);
}

export default function PetStage({
  modelPath,
  scale,
  pos,
  motionMap,
}: PetStageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resolvedModelPath = useMemo(() => modelPath, [modelPath]);
  const scaleRef = useRef(scale);
  const posRef = useRef(pos);
  const motionMapRef = useRef(motionMap);
  const appRef = useRef<PIXI.Application | null>(null);
  const modelRef = useRef<Live2DModel | null>(null);
  const pendingDiscreteInputRef = useRef<GlobalInputPayload[]>([]);
  const pendingMouseMoveRef = useRef<GlobalInputPayload | null>(null);
  const inputFrameRef = useRef<number | null>(null);
  const baseLayoutRef = useRef({
    x: 0,
    y: 0,
    scale: 1,
  });

  const applyPlacement = useCallback(() => {
    const model = modelRef.current;
    if (!model) {
      return;
    }

    const base = baseLayoutRef.current;
    const finalScale = base.scale * scaleRef.current;
    model.anchor.set(0.5, 1);
    model.scale.set(finalScale);
    model.position.set(base.x + posRef.current.x, base.y + posRef.current.y);
  }, []);

  useEffect(() => {
    scaleRef.current = scale;
    applyPlacement();
  }, [applyPlacement, scale]);

  useEffect(() => {
    posRef.current = pos;
    applyPlacement();
  }, [applyPlacement, pos]);

  useEffect(() => {
    motionMapRef.current =
      Object.keys(motionMap).length > 0 ? motionMap : DEFAULT_MOTION_MAP;
  }, [motionMap]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }

    let disposed = false;
    let unlistenGlobalInput: UnlistenFn | undefined;
    let detachFpsTicker: (() => void) | undefined;

    const relayoutModel = () => {
      const app = appRef.current;
      const model = modelRef.current;
      if (!app || !model) {
        return;
      }

      const viewportWidth = app.renderer.width;
      const viewportHeight = app.renderer.height;

      model.anchor.set(0.5, 1);
      model.scale.set(1);

      const naturalHeight = Math.max(model.height, 1);
      const baseScale = (viewportHeight * 0.8) / naturalHeight;

      baseLayoutRef.current = {
        scale: baseScale,
        x: viewportWidth - viewportWidth * 0.16,
        y: viewportHeight - viewportHeight * 0.02,
      };

      applyPlacement();
    };

    const handleMouseMove = (x: number, y: number) => {
      const app = appRef.current;
      const model = modelRef.current;
      if (!app || !model) {
        return;
      }

      const viewportWidth = Math.max(app.renderer.width, 1);
      const viewportHeight = Math.max(app.renderer.height, 1);
      const localX = x - window.screenX;
      const localY = y - window.screenY;

      const normalizedX = clamp((localX / viewportWidth) * 2 - 1, -1, 1);
      const normalizedY = clamp((localY / viewportHeight) * 2 - 1, -1, 1);

      try {
        model.focus(
          localX + normalizedX * 20,
          localY + normalizedY * 16,
        );
      } catch (error) {
        console.warn("Failed to focus model by mouse position:", error);
      }
    };

    const flushInputInAnimationFrame = () => {
      inputFrameRef.current = null;

      const model = modelRef.current;
      if (!model) {
        pendingDiscreteInputRef.current = [];
        pendingMouseMoveRef.current = null;
        return;
      }

      const discreteEvents = pendingDiscreteInputRef.current.splice(
        0,
        pendingDiscreteInputRef.current.length,
      );
      for (const payload of discreteEvents) {
        handleInput(payload, model, { motionMap: motionMapRef.current });
      }

      const mousePayload = pendingMouseMoveRef.current;
      pendingMouseMoveRef.current = null;
      if (!mousePayload) {
        return;
      }

      handleInput(mousePayload, model, { motionMap: motionMapRef.current });
      if (
        typeof mousePayload.x === "number" &&
        typeof mousePayload.y === "number"
      ) {
        handleMouseMove(mousePayload.x, mousePayload.y);
      }
    };

    const scheduleInputFrame = () => {
      if (inputFrameRef.current !== null) {
        return;
      }
      inputFrameRef.current = window.requestAnimationFrame(
        flushInputInAnimationFrame,
      );
    };

    const init = async () => {
      try {
        const modelLoadStartedAt = performance.now();
        await ensureCubismCore();

        (window as Window & { PIXI?: typeof PIXI }).PIXI = PIXI;
        Live2DModel.registerTicker(PIXI.Ticker);

        const pixiApp = new PIXI.Application({
          resizeTo: host,
          backgroundAlpha: 0,
          antialias: true,
          autoStart: true,
        });

        if (disposed) {
          pixiApp.destroy(true, true);
          return;
        }

        appRef.current = pixiApp;
        host.appendChild(pixiApp.view);
        const modelSource = resolveModelSource(resolvedModelPath);

        let live2dModel: Live2DModel;
        try {
          live2dModel = await Live2DModel.from(modelSource, {
            autoInteract: false,
            autoUpdate: true,
          });
        } catch (error) {
          console.warn(
            `Failed to load model "${modelSource}", falling back to remote sample.`,
            error,
          );
          live2dModel = await Live2DModel.from(FALLBACK_MODEL_PATH, {
            autoInteract: false,
            autoUpdate: true,
          });
        }

        if (disposed) {
          live2dModel.destroy({
            children: true,
            texture: true,
            baseTexture: true,
          });
          return;
        }

        modelRef.current = live2dModel;
        pixiApp.stage.addChild(live2dModel);
        relayoutModel();
        window.addEventListener("resize", relayoutModel);

        const modelLoadMs = performance.now() - modelLoadStartedAt;
        void reportRuntimeMetrics({ modelLoadMs });

        const fpsCounter = {
          accumulatedMs: 0,
          frames: 0,
        };
        const reportFps = () => {
          fpsCounter.accumulatedMs += pixiApp.ticker.deltaMS;
          fpsCounter.frames += 1;

          if (fpsCounter.accumulatedMs < 1_000) {
            return;
          }

          const fps = (fpsCounter.frames * 1_000) / fpsCounter.accumulatedMs;
          fpsCounter.accumulatedMs = 0;
          fpsCounter.frames = 0;
          void reportRuntimeMetrics({ fps });
        };
        pixiApp.ticker.add(reportFps);
        detachFpsTicker = () => {
          pixiApp.ticker.remove(reportFps);
        };

        // Initialize engine state so idle motions can run even before first input.
        handleInput(
          { type: "Init", timestamp: Date.now() },
          live2dModel,
          { motionMap: motionMapRef.current },
        );

        await invoke("start_listener");
        unlistenGlobalInput = await onTauriEvent<GlobalInputPayload>(
          "global-input",
          (event) => {
            const payload = event.payload;

            if (payload.type === "MouseMove") {
              pendingMouseMoveRef.current = payload;
              scheduleInputFrame();
              return;
            }

            if (pendingDiscreteInputRef.current.length >= 120) {
              pendingDiscreteInputRef.current.shift();
            }
            pendingDiscreteInputRef.current.push(payload);
            scheduleInputFrame();
          },
        );
      } catch (error) {
        console.error("Failed to initialize PetStage:", error);
        void logFrontendError("Failed to initialize PetStage", error, {
          level: "error",
        });
      }
    };

    void init();

    return () => {
      disposed = true;
      window.removeEventListener("resize", relayoutModel);

      if (unlistenGlobalInput) {
        unlistenGlobalInput();
      }

      if (inputFrameRef.current !== null) {
        window.cancelAnimationFrame(inputFrameRef.current);
        inputFrameRef.current = null;
      }

      pendingDiscreteInputRef.current = [];
      pendingMouseMoveRef.current = null;

      detachFpsTicker?.();

      void invoke("stop_listener").catch((error) => {
        console.error("Failed to stop global input listener:", error);
        void logFrontendError("Failed to stop global input listener", error, {
          level: "warn",
        });
      });

      if (modelRef.current) {
        disposeMotionEngine(modelRef.current);
      }
      modelRef.current = null;

      if (appRef.current) {
        appRef.current.destroy(
          true,
          { children: true, texture: true, baseTexture: true },
        );
      }
      appRef.current = null;
      host.innerHTML = "";
    };
  }, [applyPlacement, resolvedModelPath]);

  return <div className="pet-stage" ref={containerRef} />;
}
