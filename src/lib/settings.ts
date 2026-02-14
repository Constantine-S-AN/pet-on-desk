import { load, type Store } from "@tauri-apps/plugin-store";

export type WeightedMotion = {
  motion: string;
  weight?: number;
};

export type IdleMotionItem = string | WeightedMotion;

export type MotionMap = {
  idle?: IdleMotionItem[];
  idleTimeoutMs?: number;
  [binding: string]: string | IdleMotionItem[] | number | undefined;
};

export type PetSettings = {
  modelPath: string;
  scale: number;
  pos: {
    x: number;
    y: number;
  };
  motionMap: MotionMap;
};

export type DisplayProfile = {
  windowX: number;
  windowY: number;
  scale: number;
};

export type DisplayProfiles = Record<string, DisplayProfile>;

export type WindowInteractionPrefs = {
  locked: boolean;
  snapEnabled: boolean;
  displayProfiles: DisplayProfiles;
};

const STORE_FILE = "pet-settings.json";
const PERMISSION_WIZARD_SEEN_KEY = "permissionWizardSeen";
const WINDOW_LOCKED_KEY = "windowLocked";
const SNAP_ENABLED_KEY = "snapEnabled";
const DISPLAY_PROFILES_KEY = "displayProfiles";
const DEFAULT_IDLE_TIMEOUT_MS = 8_000;
const RESERVED_MOTION_KEYS = new Set(["idle", "idleTimeoutMs"]);

export const DEFAULT_MOTION_MAP: MotionMap = {
  KeyA: "tap_left",
  LeftArrow: "tap_left",
  ArrowLeft: "tap_left",
  KeyD: "tap_right",
  RightArrow: "tap_right",
  ArrowRight: "tap_right",
  MouseLeft: "tap",
  idle: ["idle_1", "idle_2"],
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
};

export const DEFAULT_PET_SETTINGS: PetSettings = {
  modelPath: "/models/default/model.model3.json",
  scale: 1,
  pos: { x: 0, y: 0 },
  motionMap: DEFAULT_MOTION_MAP,
};

export const DEFAULT_WINDOW_INTERACTION_PREFS: WindowInteractionPrefs = {
  locked: true,
  snapEnabled: true,
  displayProfiles: {},
};

let storePromise: Promise<Store> | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function cloneIdleMotionItem(item: IdleMotionItem): IdleMotionItem {
  if (typeof item === "string") {
    return item;
  }
  return { ...item };
}

function cloneMotionMap(map: MotionMap): MotionMap {
  const cloned: MotionMap = {};
  for (const [key, value] of Object.entries(map)) {
    if (Array.isArray(value)) {
      cloned[key] = value.map((item) => cloneIdleMotionItem(item));
      continue;
    }
    cloned[key] = value;
  }
  return cloned;
}

function defaultBindingEntries() {
  return Object.entries(DEFAULT_MOTION_MAP).filter(
    ([key, value]) => !RESERVED_MOTION_KEYS.has(key) && typeof value === "string",
  );
}

function normalizeBindingMotion(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  // Backward compatibility: old format { group, index?, direction? }
  if (value && typeof value === "object") {
    const legacy = value as Record<string, unknown>;
    if (typeof legacy.group === "string" && legacy.group.trim().length > 0) {
      return legacy.group.trim();
    }
  }

  return null;
}

function normalizeIdleList(raw: unknown): IdleMotionItem[] {
  const fallback = Array.isArray(DEFAULT_MOTION_MAP.idle)
    ? DEFAULT_MOTION_MAP.idle.map((item) => cloneIdleMotionItem(item))
    : [];

  if (!Array.isArray(raw)) {
    return fallback;
  }

  const idle: IdleMotionItem[] = [];

  for (const item of raw) {
    if (typeof item === "string" && item.trim().length > 0) {
      idle.push(item.trim());
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

    const motion = motionRaw.trim();
    const weight =
      typeof candidate.weight === "number" && Number.isFinite(candidate.weight)
        ? clamp(candidate.weight, 0.01, 100)
        : undefined;

    idle.push(weight ? { motion, weight } : { motion });
  }

  if (idle.length === 0) {
    return fallback;
  }

  return idle;
}

function normalizeMotionMap(raw: unknown): MotionMap {
  if (!raw || typeof raw !== "object") {
    return cloneMotionMap(DEFAULT_MOTION_MAP);
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  const map: MotionMap = {};

  let hasBinding = false;
  let idleTimeoutMs: number | undefined;
  for (const [key, value] of entries) {
    const binding = key.trim();
    if (binding.length === 0) {
      continue;
    }

    if (binding === "idle") {
      map.idle = normalizeIdleList(value);
      continue;
    }

    if (binding === "idleTimeoutMs") {
      if (typeof value === "number" && Number.isFinite(value)) {
        idleTimeoutMs = Math.round(clamp(value, 2_000, 60_000));
      }
      continue;
    }

    const motion = normalizeBindingMotion(value);
    if (!motion) {
      continue;
    }
    map[binding] = motion;
    hasBinding = true;
  }

  if (!hasBinding) {
    for (const [binding, motion] of defaultBindingEntries()) {
      map[binding] = motion;
    }
  }

  map.idle = normalizeIdleList(map.idle ?? (raw as Record<string, unknown>).idle);

  if (typeof idleTimeoutMs === "number") {
    map.idleTimeoutMs = idleTimeoutMs;
  } else if (
    typeof (raw as Record<string, unknown>).idleTimeoutMs === "number" &&
    Number.isFinite((raw as Record<string, unknown>).idleTimeoutMs)
  ) {
    map.idleTimeoutMs = Math.round(
      clamp((raw as Record<string, unknown>).idleTimeoutMs as number, 2_000, 60_000),
    );
  } else {
    map.idleTimeoutMs =
      typeof DEFAULT_MOTION_MAP.idleTimeoutMs === "number"
        ? DEFAULT_MOTION_MAP.idleTimeoutMs
        : DEFAULT_IDLE_TIMEOUT_MS;
  }

  return map;
}

function normalizeDisplayProfiles(raw: unknown): DisplayProfiles {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const profiles: DisplayProfiles = {};
  for (const [monitorKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.windowX !== "number" ||
      !Number.isFinite(candidate.windowX) ||
      typeof candidate.windowY !== "number" ||
      !Number.isFinite(candidate.windowY)
    ) {
      continue;
    }

    const scale =
      typeof candidate.scale === "number" && Number.isFinite(candidate.scale)
        ? clamp(candidate.scale, 0.2, 3)
        : DEFAULT_PET_SETTINGS.scale;

    profiles[monitorKey] = {
      windowX: Math.round(candidate.windowX),
      windowY: Math.round(candidate.windowY),
      scale,
    };
  }

  return profiles;
}

export function normalizePetSettings(raw: Partial<PetSettings> | null | undefined): PetSettings {
  const modelPath =
    typeof raw?.modelPath === "string" && raw.modelPath.trim().length > 0
      ? raw.modelPath.trim()
      : DEFAULT_PET_SETTINGS.modelPath;

  const scale =
    typeof raw?.scale === "number" && Number.isFinite(raw.scale)
      ? clamp(raw.scale, 0.2, 3)
      : DEFAULT_PET_SETTINGS.scale;

  const x =
    typeof raw?.pos?.x === "number" && Number.isFinite(raw.pos.x)
      ? clamp(raw.pos.x, -600, 600)
      : DEFAULT_PET_SETTINGS.pos.x;

  const y =
    typeof raw?.pos?.y === "number" && Number.isFinite(raw.pos.y)
      ? clamp(raw.pos.y, -600, 600)
      : DEFAULT_PET_SETTINGS.pos.y;

  return {
    modelPath,
    scale,
    pos: { x, y },
    motionMap: normalizeMotionMap(raw?.motionMap),
  };
}

async function getStore() {
  if (!storePromise) {
    storePromise = load(STORE_FILE, {
      defaults: DEFAULT_PET_SETTINGS,
      autoSave: false,
    });
  }
  return storePromise;
}

export async function loadPetSettings() {
  const store = await getStore();

  const [modelPath, scale, pos, motionMap] = await Promise.all([
    store.get<string>("modelPath"),
    store.get<number>("scale"),
    store.get<{ x: number; y: number }>("pos"),
    store.get<MotionMap>("motionMap"),
  ]);

  return normalizePetSettings({
    modelPath,
    scale,
    pos,
    motionMap,
  });
}

export async function savePetSettings(settings: PetSettings) {
  const store = await getStore();
  const normalized = normalizePetSettings(settings);

  await store.set("modelPath", normalized.modelPath);
  await store.set("scale", normalized.scale);
  await store.set("pos", normalized.pos);
  await store.set("motionMap", normalized.motionMap);
  await store.save();

  return normalized;
}

export async function loadPermissionWizardSeen() {
  const store = await getStore();
  const seen = await store.get<boolean>(PERMISSION_WIZARD_SEEN_KEY);
  return seen === true;
}

export async function savePermissionWizardSeen(seen: boolean) {
  const store = await getStore();
  await store.set(PERMISSION_WIZARD_SEEN_KEY, seen);
  await store.save();
}

function normalizeWindowInteractionPrefs(
  raw: Partial<WindowInteractionPrefs> | null | undefined,
): WindowInteractionPrefs {
  return {
    locked:
      typeof raw?.locked === "boolean"
        ? raw.locked
        : DEFAULT_WINDOW_INTERACTION_PREFS.locked,
    snapEnabled:
      typeof raw?.snapEnabled === "boolean"
        ? raw.snapEnabled
        : DEFAULT_WINDOW_INTERACTION_PREFS.snapEnabled,
    displayProfiles: normalizeDisplayProfiles(raw?.displayProfiles),
  };
}

export async function loadWindowInteractionPrefs() {
  const store = await getStore();
  const [locked, snapEnabled, displayProfiles] = await Promise.all([
    store.get<boolean>(WINDOW_LOCKED_KEY),
    store.get<boolean>(SNAP_ENABLED_KEY),
    store.get<DisplayProfiles>(DISPLAY_PROFILES_KEY),
  ]);

  return normalizeWindowInteractionPrefs({
    locked,
    snapEnabled,
    displayProfiles,
  });
}

export async function saveWindowInteractionPrefs(prefs: WindowInteractionPrefs) {
  const store = await getStore();
  const normalized = normalizeWindowInteractionPrefs(prefs);
  await store.set(WINDOW_LOCKED_KEY, normalized.locked);
  await store.set(SNAP_ENABLED_KEY, normalized.snapEnabled);
  await store.set(DISPLAY_PROFILES_KEY, normalized.displayProfiles);
  await store.save();
  return normalized;
}
