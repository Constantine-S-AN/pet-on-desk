import {
  cloneMotionConfig,
  defaultMotionConfig,
  type ComboRule,
  type ExecutableInputAction,
  type IdleConfig,
  type IdleEntry,
  type InputAction,
  type MotionAction,
  type MotionConfig,
  type TweenAction,
  type TweenPreset,
} from "./config";

export type MotionConfigValidationResult = {
  ok: boolean;
  errors: string[];
  value?: MotionConfig;
};

const VALID_TWEEN_PRESETS: TweenPreset[] = ["bounce", "shake", "nod"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asIntegerInRange(
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

function asNumberInRange(
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value < min || value > max) {
    return null;
  }
  return value;
}

function parseCooldown(
  value: unknown,
  path: string,
  errors: string[],
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const cooldownMs = asIntegerInRange(value, 0, 60_000);
  if (cooldownMs === null) {
    errors.push(`${path}.cooldownMs must be an integer between 0 and 60000.`);
    return undefined;
  }
  return cooldownMs;
}

function parseMotionAction(
  raw: Record<string, unknown>,
  path: string,
  errors: string[],
): MotionAction | null {
  const group = asNonEmptyString(raw.group);
  if (!group) {
    errors.push(`${path}.group must be a non-empty string.`);
    return null;
  }

  let index: number | undefined;
  if (raw.index !== undefined) {
    const value = asIntegerInRange(raw.index, 0, 1024);
    if (value === null) {
      errors.push(`${path}.index must be an integer between 0 and 1024.`);
    } else {
      index = value;
    }
  }

  let priority: number | undefined;
  if (raw.priority !== undefined) {
    const value = asIntegerInRange(raw.priority, 0, 10);
    if (value === null) {
      errors.push(`${path}.priority must be an integer between 0 and 10.`);
    } else {
      priority = value;
    }
  }

  return {
    kind: "motion",
    group,
    index,
    priority,
    cooldownMs: parseCooldown(raw.cooldownMs, path, errors),
  };
}

function parseTweenAction(
  raw: Record<string, unknown>,
  path: string,
  errors: string[],
): TweenAction | null {
  if (
    typeof raw.preset !== "string" ||
    !VALID_TWEEN_PRESETS.includes(raw.preset as TweenPreset)
  ) {
    errors.push(`${path}.preset must be one of: ${VALID_TWEEN_PRESETS.join(", ")}.`);
    return null;
  }
  const preset = raw.preset as TweenPreset;

  let strength: number | undefined;
  if (raw.strength !== undefined) {
    const value = asNumberInRange(raw.strength, 0.05, 3);
    if (value === null) {
      errors.push(`${path}.strength must be a number between 0.05 and 3.`);
    } else {
      strength = value;
    }
  }

  return {
    kind: "tween",
    preset,
    strength,
    cooldownMs: parseCooldown(raw.cooldownMs, path, errors),
  };
}

function parseAction(
  raw: unknown,
  path: string,
  errors: string[],
  allowCombo: boolean,
): InputAction | null {
  if (!isObject(raw)) {
    errors.push(`${path} must be an object.`);
    return null;
  }

  const kind = asNonEmptyString(raw.kind);
  if (!kind) {
    errors.push(`${path}.kind must be a non-empty string.`);
    return null;
  }

  if (kind === "motion") {
    return parseMotionAction(raw, path, errors);
  }

  if (kind === "expression") {
    const name = asNonEmptyString(raw.name);
    if (!name) {
      errors.push(`${path}.name must be a non-empty string.`);
      return null;
    }

    return {
      kind: "expression",
      name,
      cooldownMs: parseCooldown(raw.cooldownMs, path, errors),
    };
  }

  if (kind === "tween") {
    return parseTweenAction(raw, path, errors);
  }

  if (kind === "combo") {
    if (!allowCombo) {
      errors.push(`${path}.kind=combo is not allowed in this context.`);
      return null;
    }

    const ruleId = asNonEmptyString(raw.ruleId);
    if (!ruleId) {
      errors.push(`${path}.ruleId must be a non-empty string.`);
      return null;
    }

    return {
      kind: "combo",
      ruleId,
      cooldownMs: parseCooldown(raw.cooldownMs, path, errors),
    };
  }

  errors.push(`${path}.kind must be one of: motion, expression, tween, combo.`);
  return null;
}

function parseKeyMap(
  raw: unknown,
  errors: string[],
): Record<string, InputAction> {
  const fallback = cloneMotionConfig(defaultMotionConfig).keyMap;
  if (!isObject(raw)) {
    errors.push("keyMap must be an object.");
    return fallback;
  }

  const keyMap: Record<string, InputAction> = {};
  for (const [input, actionRaw] of Object.entries(raw)) {
    const inputKey = input.trim();
    if (!inputKey) {
      errors.push("keyMap contains an empty input key.");
      continue;
    }

    const parsed = parseAction(actionRaw, `keyMap.${inputKey}`, errors, true);
    if (!parsed) {
      continue;
    }

    keyMap[inputKey] = parsed;
  }

  if (Object.keys(keyMap).length === 0) {
    errors.push("keyMap must contain at least one valid input action.");
    return fallback;
  }

  return keyMap;
}

function parseComboRules(raw: unknown, errors: string[]): ComboRule[] {
  const fallback = cloneMotionConfig(defaultMotionConfig).comboRules;
  if (raw === undefined) {
    return fallback;
  }

  if (!Array.isArray(raw)) {
    errors.push("comboRules must be an array.");
    return fallback;
  }

  const comboRules: ComboRule[] = [];
  const idSet = new Set<string>();

  raw.forEach((item, index) => {
    const path = `comboRules[${index}]`;
    if (!isObject(item)) {
      errors.push(`${path} must be an object.`);
      return;
    }

    const id = asNonEmptyString(item.id);
    if (!id) {
      errors.push(`${path}.id must be a non-empty string.`);
      return;
    }

    if (idSet.has(id)) {
      errors.push(`${path}.id must be unique, duplicate: ${id}.`);
      return;
    }

    if (!Array.isArray(item.sequence) || item.sequence.length < 2) {
      errors.push(`${path}.sequence must be an array with at least 2 inputs.`);
      return;
    }

    const sequence = item.sequence
      .map((part) => asNonEmptyString(part))
      .filter((part): part is string => Boolean(part));

    if (sequence.length !== item.sequence.length) {
      errors.push(`${path}.sequence must contain only non-empty strings.`);
      return;
    }

    const withinMs = asIntegerInRange(item.withinMs, 1, 10_000);
    if (withinMs === null) {
      errors.push(`${path}.withinMs must be an integer between 1 and 10000.`);
      return;
    }

    const action = parseAction(item.action, `${path}.action`, errors, false);
    if (!action || action.kind === "combo") {
      errors.push(`${path}.action must be motion/expression/tween.`);
      return;
    }

    comboRules.push({
      id,
      sequence,
      withinMs,
      action: action as ExecutableInputAction,
      cooldownMs: parseCooldown(item.cooldownMs, path, errors),
    });
    idSet.add(id);
  });

  return comboRules;
}

function parseIdleActions(raw: unknown, errors: string[]): IdleEntry[] {
  const fallback = cloneMotionConfig(defaultMotionConfig).idle.actions;

  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push("idle.actions must be a non-empty array.");
    return fallback;
  }

  const actions: IdleEntry[] = [];
  raw.forEach((item, index) => {
    const path = `idle.actions[${index}]`;
    if (!isObject(item)) {
      errors.push(`${path} must be an object.`);
      return;
    }

    const action = parseAction(item.action, `${path}.action`, errors, false);
    if (!action || action.kind === "combo") {
      errors.push(`${path}.action must be motion/expression/tween.`);
      return;
    }

    let weight: number | undefined;
    if (item.weight !== undefined) {
      const value = asNumberInRange(item.weight, 0.01, 100);
      if (value === null) {
        errors.push(`${path}.weight must be a number between 0.01 and 100.`);
      } else {
        weight = value;
      }
    }

    actions.push({ action: action as ExecutableInputAction, weight });
  });

  if (actions.length === 0) {
    errors.push("idle.actions has no valid entries.");
    return fallback;
  }

  return actions;
}

function parseIdleConfig(raw: unknown, errors: string[]): IdleConfig {
  const fallback = cloneMotionConfig(defaultMotionConfig).idle;
  if (!isObject(raw)) {
    errors.push("idle must be an object.");
    return fallback;
  }

  let enabled = true;
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") {
      errors.push("idle.enabled must be a boolean.");
    } else {
      enabled = raw.enabled;
    }
  }

  const afterMs = asIntegerInRange(raw.afterMs, 500, 600_000);
  if (afterMs === null) {
    errors.push("idle.afterMs must be an integer between 500 and 600000.");
  }

  let intervalMs: number | undefined;
  if (raw.intervalMs !== undefined) {
    const value = asIntegerInRange(raw.intervalMs, 100, 600_000);
    if (value === null) {
      errors.push("idle.intervalMs must be an integer between 100 and 600000.");
    } else {
      intervalMs = value;
    }
  }

  return {
    enabled,
    afterMs: afterMs ?? fallback.afterMs,
    intervalMs,
    actions: parseIdleActions(raw.actions, errors),
  };
}

export function validateMotionConfig(raw: any): MotionConfigValidationResult {
  const errors: string[] = [];

  if (!isObject(raw)) {
    errors.push("Motion config root must be an object.");
    return { ok: false, errors };
  }

  if (raw.version !== undefined && raw.version !== 1) {
    errors.push("version must be 1.");
  }

  const value: MotionConfig = {
    version: 1,
    keyMap: parseKeyMap(raw.keyMap, errors),
    comboRules: parseComboRules(raw.comboRules, errors),
    idle: parseIdleConfig(raw.idle, errors),
  };

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors,
    value,
  };
}

export function resolveMotionConfig(raw: unknown): MotionConfig {
  const result = validateMotionConfig(raw);
  if (result.ok && result.value) {
    return result.value;
  }

  console.error(
    "[motion-config] Invalid config, fallback to defaultMotionConfig.",
    result.errors,
  );
  return cloneMotionConfig(defaultMotionConfig);
}

export async function loadMotionConfigFromUrl(url: string): Promise<MotionConfig> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const raw = (await response.json()) as unknown;
    return resolveMotionConfig(raw);
  } catch (error) {
    console.error(
      `[motion-config] Failed to load config from ${url}, fallback to defaultMotionConfig.`,
      error,
    );
    return cloneMotionConfig(defaultMotionConfig);
  }
}

export async function loadExampleMotionConfig() {
  return loadMotionConfigFromUrl("/motionMap.example.json");
}
