import type { Monitor, PhysicalSize } from "@tauri-apps/api/window";

export type WindowPosition = {
  x: number;
  y: number;
};

export function monitorKey(monitor: Monitor) {
  const name = monitor.name ?? "monitor";
  return `${name}:${monitor.position.x},${monitor.position.y}:${monitor.size.width}x${monitor.size.height}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function workAreaBounds(monitor: Monitor, windowSize: PhysicalSize) {
  const left = monitor.workArea.position.x;
  const top = monitor.workArea.position.y;
  const right = left + monitor.workArea.size.width - windowSize.width;
  const bottom = top + monitor.workArea.size.height - windowSize.height;
  return { left, top, right, bottom };
}

export function clampPositionToMonitor(
  position: WindowPosition,
  monitor: Monitor,
  windowSize: PhysicalSize,
): WindowPosition {
  const bounds = workAreaBounds(monitor, windowSize);
  return {
    x: Math.round(clamp(position.x, bounds.left, bounds.right)),
    y: Math.round(clamp(position.y, bounds.top, bounds.bottom)),
  };
}

export function snapPositionToEdges(
  position: WindowPosition,
  monitor: Monitor,
  windowSize: PhysicalSize,
  threshold = 16,
) {
  const bounds = workAreaBounds(monitor, windowSize);
  let x = position.x;
  let y = position.y;
  let snapped = false;

  if (Math.abs(position.x - bounds.left) < threshold) {
    x = bounds.left;
    snapped = true;
  } else if (Math.abs(bounds.right - position.x) < threshold) {
    x = bounds.right;
    snapped = true;
  }

  if (Math.abs(position.y - bounds.top) < threshold) {
    y = bounds.top;
    snapped = true;
  } else if (Math.abs(bounds.bottom - position.y) < threshold) {
    y = bounds.bottom;
    snapped = true;
  }

  return {
    snapped,
    position: { x: Math.round(x), y: Math.round(y) },
  };
}

export function positionsEqual(a: WindowPosition, b: WindowPosition) {
  return a.x === b.x && a.y === b.y;
}
