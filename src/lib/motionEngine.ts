import type { Live2DModel } from "pixi-live2d-display/cubism4";
import type { IdleMotionItem, MotionMap } from "./settings";

export type MotionEngineInputEvent = {
  type: string;
  keyCode?: string;
  button?: string;
  x?: number;
  y?: number;
  timestamp?: number;
};

export type MotionEngineSettings = {
  motionMap: MotionMap;
};

type IdleCandidate = {
  motion: string;
  weight: number;
};

type EngineState = {
  lastInputAt: number;
  lastIdleAt: number;
  idleTimerId: number;
  fallbackRafId: number | null;
  idlePlaying: boolean;
  disposed: boolean;
  settings: MotionEngineSettings;
};

const DEFAULT_IDLE_TIMEOUT_MS = 8_000;
const IDLE_CHECK_INTERVAL_MS = 1_000;
const RESERVED_KEYS = new Set(["idle", "idleTimeoutMs"]);
const engineStateMap = new WeakMap<Live2DModel, EngineState>();

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function lerp(from: number, to: number, t: number) {
  return from + (to - from) * t;
}

function easeOutCubic(t: number) {
  return 1 - (1 - t) ** 3;
}

function easeInOutQuad(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

function keyAliases(key: string): string[] {
  if (key === "ArrowLeft") {
    return ["LeftArrow"];
  }
  if (key === "LeftArrow") {
    return ["ArrowLeft"];
  }
  if (key === "ArrowRight") {
    return ["RightArrow"];
  }
  if (key === "RightArrow") {
    return ["ArrowRight"];
  }
  return [];
}

function normalizeMouseBinding(button?: string): string | null {
  if (!button) {
    return null;
  }
  const normalized = button.toLowerCase();
  if (normalized.includes("left")) {
    return "MouseLeft";
  }
  if (normalized.includes("right")) {
    return "MouseRight";
  }
  if (normalized.includes("middle")) {
    return "MouseMiddle";
  }
  return null;
}

function resolveBindingMotion(motionMap: MotionMap, binding: string): string | null {
  const candidates = [binding, ...keyAliases(binding)];
  for (const key of candidates) {
    const mapped = motionMap[key];
    if (typeof mapped === "string" && mapped.trim().length > 0) {
      return mapped.trim();
    }
  }
  return null;
}

function parseIdleCandidates(motionMap: MotionMap): IdleCandidate[] {
  const raw = motionMap.idle;
  if (!Array.isArray(raw)) {
    return [];
  }

  const idle: IdleCandidate[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim().length > 0) {
      idle.push({ motion: item.trim(), weight: 1 });
      continue;
    }

    if (!item || typeof item !== "object") {
      continue;
    }

    const candidate = item as Record<string, unknown>;
    const motionRaw = candidate.motion ?? candidate.name;
    if (typeof motionRaw !== "string" || motionRaw.trim().length === 0) {
      continue;
    }

    const weight =
      typeof candidate.weight === "number" && Number.isFinite(candidate.weight)
        ? clamp(candidate.weight, 0.01, 100)
        : 1;

    idle.push({ motion: motionRaw.trim(), weight });
  }

  return idle;
}

function resolveIdleTimeout(motionMap: MotionMap) {
  if (
    typeof motionMap.idleTimeoutMs === "number" &&
    Number.isFinite(motionMap.idleTimeoutMs)
  ) {
    return Math.round(clamp(motionMap.idleTimeoutMs, 2_000, 60_000));
  }
  return DEFAULT_IDLE_TIMEOUT_MS;
}

function pickWeightedIdleMotion(candidates: IdleCandidate[]): string | null {
  if (candidates.length === 0) {
    return null;
  }

  const totalWeight = candidates.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    return candidates[Math.floor(Math.random() * candidates.length)]?.motion ?? null;
  }

  let ticket = Math.random() * totalWeight;
  for (const item of candidates) {
    ticket -= item.weight;
    if (ticket <= 0) {
      return item.motion;
    }
  }

  return candidates[candidates.length - 1]?.motion ?? null;
}

function triggerFallbackTween(model: Live2DModel, state: EngineState, reason: string) {
  console.warn(`[motion-engine] fallback tween: ${reason}`);

  if (state.fallbackRafId !== null) {
    cancelAnimationFrame(state.fallbackRafId);
    state.fallbackRafId = null;
  }

  const origin = {
    scaleX: model.scale.x,
    scaleY: model.scale.y,
    rotation: model.rotation,
    x: model.position.x,
    y: model.position.y,
  };

  const direction = Math.random() > 0.5 ? 1 : -1;
  const peak = {
    scaleX: origin.scaleX * (1 + 0.08),
    scaleY: origin.scaleY * (1 - 0.06),
    rotation: origin.rotation + direction * 0.08,
    x: origin.x + direction * 12,
    y: origin.y - 6,
  };

  const upDuration = 160;
  const downDuration = 220;
  const startAt = performance.now();

  const animate = (now: number) => {
    if (state.disposed) {
      return;
    }

    const elapsed = now - startAt;
    if (elapsed <= upDuration) {
      const t = easeOutCubic(clamp(elapsed / upDuration, 0, 1));
      model.scale.set(lerp(origin.scaleX, peak.scaleX, t), lerp(origin.scaleY, peak.scaleY, t));
      model.rotation = lerp(origin.rotation, peak.rotation, t);
      model.position.set(lerp(origin.x, peak.x, t), lerp(origin.y, peak.y, t));
      state.fallbackRafId = requestAnimationFrame(animate);
      return;
    }

    const downElapsed = elapsed - upDuration;
    if (downElapsed <= downDuration) {
      const t = easeInOutQuad(clamp(downElapsed / downDuration, 0, 1));
      model.scale.set(lerp(peak.scaleX, origin.scaleX, t), lerp(peak.scaleY, origin.scaleY, t));
      model.rotation = lerp(peak.rotation, origin.rotation, t);
      model.position.set(lerp(peak.x, origin.x, t), lerp(peak.y, origin.y, t));
      state.fallbackRafId = requestAnimationFrame(animate);
      return;
    }

    model.scale.set(origin.scaleX, origin.scaleY);
    model.rotation = origin.rotation;
    model.position.set(origin.x, origin.y);
    state.fallbackRafId = null;
  };

  state.fallbackRafId = requestAnimationFrame(animate);
}

async function playMotionOrFallback(
  model: Live2DModel,
  state: EngineState,
  motionName: string | null,
  reason: string,
) {
  if (!motionName) {
    triggerFallbackTween(model, state, `${reason} (no mapping)`);
    return;
  }

  try {
    const started = await model.motion(motionName);
    if (!started) {
      console.warn(`[motion-engine] motion returned false: ${motionName}`);
      triggerFallbackTween(model, state, `${reason} (${motionName} not started)`);
    }
  } catch (error) {
    console.error(`[motion-engine] motion failed: ${motionName}`, error);
    triggerFallbackTween(model, state, `${reason} (${motionName} failed)`);
  }
}

async function maybePlayIdle(model: Live2DModel, state: EngineState) {
  if (state.disposed || state.idlePlaying) {
    return;
  }

  const motionMap = state.settings.motionMap;
  const idleTimeout = resolveIdleTimeout(motionMap);
  const now = Date.now();

  if (now - state.lastInputAt < idleTimeout) {
    return;
  }
  if (now - state.lastIdleAt < idleTimeout) {
    return;
  }

  state.idlePlaying = true;
  state.lastIdleAt = now;

  const idleMotion = pickWeightedIdleMotion(parseIdleCandidates(motionMap));
  await playMotionOrFallback(model, state, idleMotion, "idle");

  state.idlePlaying = false;
}

function ensureEngineState(model: Live2DModel, settings: MotionEngineSettings): EngineState {
  const existing = engineStateMap.get(model);
  if (existing) {
    existing.settings = settings;
    return existing;
  }

  const state: EngineState = {
    lastInputAt: Date.now(),
    lastIdleAt: 0,
    idleTimerId: -1,
    fallbackRafId: null,
    idlePlaying: false,
    disposed: false,
    settings,
  };

  state.idleTimerId = window.setInterval(() => {
    void maybePlayIdle(model, state);
  }, IDLE_CHECK_INTERVAL_MS);

  engineStateMap.set(model, state);
  return state;
}

function isUserInputEvent(eventType: string) {
  return (
    eventType === "KeyPress" ||
    eventType === "KeyRelease" ||
    eventType === "MouseMove" ||
    eventType === "ButtonPress" ||
    eventType === "ButtonRelease"
  );
}

export function handleInput(
  event: MotionEngineInputEvent,
  model: Live2DModel,
  settings: MotionEngineSettings,
) {
  const state = ensureEngineState(model, settings);
  state.settings = settings;

  const now =
    typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
      ? event.timestamp
      : Date.now();

  if (isUserInputEvent(event.type)) {
    state.lastInputAt = now;
  }

  if (event.type === "KeyPress") {
    const keyCode = event.keyCode?.trim();
    if (!keyCode) {
      triggerFallbackTween(model, state, "keypress missing keyCode");
      return;
    }

    const motionName = resolveBindingMotion(settings.motionMap, keyCode);
    void playMotionOrFallback(model, state, motionName, `keypress:${keyCode}`);
    return;
  }

  if (event.type === "ButtonPress") {
    const mouseBinding = normalizeMouseBinding(event.button);
    const motionName = mouseBinding
      ? resolveBindingMotion(settings.motionMap, mouseBinding)
      : null;
    void playMotionOrFallback(
      model,
      state,
      motionName,
      `mouse:${mouseBinding ?? event.button ?? "unknown"}`,
    );
    return;
  }
}

export function disposeMotionEngine(model: Live2DModel) {
  const state = engineStateMap.get(model);
  if (!state) {
    return;
  }

  state.disposed = true;

  if (state.idleTimerId >= 0) {
    window.clearInterval(state.idleTimerId);
  }
  if (state.fallbackRafId !== null) {
    cancelAnimationFrame(state.fallbackRafId);
  }

  engineStateMap.delete(model);
}

export function motionMapBindings(motionMap: MotionMap) {
  return Object.entries(motionMap)
    .filter(([key]) => !RESERVED_KEYS.has(key))
    .reduce<Record<string, string>>((acc, [key, value]) => {
      if (typeof value === "string") {
        acc[key] = value;
      }
      return acc;
    }, {});
}

export function idleMotions(motionMap: MotionMap): IdleCandidate[] {
  return parseIdleCandidates(motionMap);
}

export function toIdleMotionItem(item: IdleCandidate): IdleMotionItem {
  if (item.weight === 1) {
    return item.motion;
  }
  return { motion: item.motion, weight: item.weight };
}
