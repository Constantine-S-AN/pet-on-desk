export type TweenPreset = "bounce" | "shake" | "nod";

type PointLike = {
  x: number;
  y: number;
  set?: (x: number, y?: number) => unknown;
};

export type TweenTarget = {
  position?: PointLike;
  scale?: PointLike;
  rotation?: number;
};

type ActiveTween = {
  rafId: number;
  cancelled: boolean;
  restore: () => void;
};

const activeTweens = new WeakMap<object, ActiveTween>();

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function readPoint(point: PointLike | undefined, fallbackX: number, fallbackY: number) {
  if (!point || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) {
    return { x: fallbackX, y: fallbackY };
  }
  return { x: point.x, y: point.y };
}

function writePoint(point: PointLike | undefined, x: number, y: number) {
  if (!point) {
    return;
  }
  if (typeof point.set === "function") {
    point.set(x, y);
    return;
  }
  point.x = x;
  point.y = y;
}

function cancelActiveTween(target: object) {
  const existing = activeTweens.get(target);
  if (!existing) {
    return;
  }
  existing.cancelled = true;
  cancelAnimationFrame(existing.rafId);
  existing.restore();
  activeTweens.delete(target);
}

function getDuration(preset: TweenPreset) {
  if (preset === "bounce") {
    return 340;
  }
  if (preset === "shake") {
    return 260;
  }
  return 320;
}

function applyFrame(
  preset: TweenPreset,
  t: number,
  strength: number,
  origin: { x: number; y: number; scaleX: number; scaleY: number; rotation: number },
) {
  if (preset === "bounce") {
    const lift = Math.sin(t * Math.PI) * 16 * strength;
    const squash = 1 - Math.sin(t * Math.PI) * 0.08 * strength;
    const stretch = 1 + Math.sin(t * Math.PI) * 0.06 * strength;
    const tilt = Math.sin(t * Math.PI) * 0.03 * strength;

    return {
      x: origin.x,
      y: origin.y - lift,
      scaleX: origin.scaleX * stretch,
      scaleY: origin.scaleY * squash,
      rotation: origin.rotation + tilt,
    };
  }

  if (preset === "shake") {
    const damp = 1 - t;
    const wave = Math.sin(t * Math.PI * 10);
    const waveRot = Math.sin(t * Math.PI * 8);

    return {
      x: origin.x + wave * 14 * strength * damp,
      y: origin.y,
      scaleX: origin.scaleX * (1 + Math.abs(wave) * 0.02 * strength * damp),
      scaleY: origin.scaleY * (1 - Math.abs(wave) * 0.02 * strength * damp),
      rotation: origin.rotation + waveRot * 0.08 * strength * damp,
    };
  }

  const damp = 1 - t;
  const wave = Math.sin(t * Math.PI * 2);
  const lift = Math.max(0, wave) * 7 * strength * damp;

  return {
    x: origin.x,
    y: origin.y + lift,
    scaleX: origin.scaleX,
    scaleY: origin.scaleY,
    rotation: origin.rotation + wave * 0.14 * strength * damp,
  };
}

export function applyTweenPreset(
  target: TweenTarget | null | undefined,
  preset: TweenPreset,
  rawStrength = 1,
  onError?: (error: Error) => void,
) {
  try {
    if (!target || typeof target !== "object") {
      return;
    }

    const strength = isFiniteNumber(rawStrength) ? clamp(rawStrength, 0.05, 3) : 1;
    const host = target as object;
    cancelActiveTween(host);

    const originPosition = readPoint(target.position, 0, 0);
    const originScale = readPoint(target.scale, 1, 1);
    const originRotation = isFiniteNumber(target.rotation) ? target.rotation : 0;
    const origin = {
      x: originPosition.x,
      y: originPosition.y,
      scaleX: originScale.x,
      scaleY: originScale.y,
      rotation: originRotation,
    };
    const duration = getDuration(preset);
    const startedAt = performance.now();

    const restore = () => {
      writePoint(target.position, origin.x, origin.y);
      writePoint(target.scale, origin.scaleX, origin.scaleY);
      if (typeof target.rotation === "number") {
        target.rotation = origin.rotation;
      }
    };

    const active: ActiveTween = {
      rafId: -1,
      cancelled: false,
      restore,
    };
    activeTweens.set(host, active);

    const tick = (now: number) => {
      if (active.cancelled) {
        return;
      }

      try {
        const t = clamp((now - startedAt) / duration, 0, 1);
        const frame = applyFrame(preset, t, strength, origin);

        writePoint(target.position, frame.x, frame.y);
        writePoint(target.scale, frame.scaleX, frame.scaleY);
        if (typeof target.rotation === "number") {
          target.rotation = frame.rotation;
        }

        if (t < 1) {
          active.rafId = requestAnimationFrame(tick);
          return;
        }

        restore();
        activeTweens.delete(host);
      } catch (error) {
        active.cancelled = true;
        restore();
        activeTweens.delete(host);
        onError?.(toError(error));
      }
    };

    active.rafId = requestAnimationFrame(tick);
  } catch (error) {
    onError?.(toError(error));
  }
}
