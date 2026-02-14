import { applyTweenPreset, type TweenPreset } from "./tweenPresets";

type LooseRecord = Record<string, unknown>;

type MotionCallable = (
  group: string,
  index?: number,
  priority?: number,
) => boolean | Promise<boolean>;

type ExpressionCallable = (name?: string) => boolean | Promise<boolean>;

export type ModelAdapterError = {
  method:
    | "playMotion"
    | "setExpression"
    | "applyTween"
    | "listMotions"
    | "listExpressions";
  message: string;
  cause?: unknown;
  timestamp: number;
};

export type ModelAdapter = {
  readonly lastError: ModelAdapterError | null;
  playMotion(
    group: string,
    index?: number,
    priority?: number,
  ): Promise<boolean>;
  setExpression(name: string): Promise<boolean>;
  applyTween(preset: TweenPreset, strength?: number): void;
  listMotions(): string[];
  listExpressions(): string[];
};

function isObject(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function readPath(root: unknown, path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (!isObject(cursor) || !(key in cursor)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return cursor;
}

function addName(target: Set<string>, value: unknown) {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length > 0) {
    target.add(trimmed);
  }
}

function addNameFromEntry(target: Set<string>, entry: unknown) {
  if (!isObject(entry)) {
    return;
  }

  addName(target, entry.name);
  addName(target, entry.Name);
  addName(target, entry.id);
  addName(target, entry.Id);
  addName(target, entry.group);
  addName(target, entry.Group);
}

function collectRecordKeys(target: Set<string>, value: unknown) {
  if (!isObject(value) || Array.isArray(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (/^\d+$/.test(trimmed)) {
      continue;
    }
    target.add(trimmed);
  }
}

function collectMotionsFromCandidate(target: Set<string>, candidate: unknown) {
  if (candidate === undefined) {
    return;
  }

  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      addNameFromEntry(target, item);
    }
    return;
  }

  if (isObject(candidate)) {
    // Runtime probe rule:
    // 1) Most Cubism settings store motions as Record<group, MotionDefinition[]>, so keys are group names.
    // 2) Some runtimes expose arrays/records with "name/Name/group/Group", so we also try these fields.
    collectRecordKeys(target, candidate);
    for (const value of Object.values(candidate)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          addNameFromEntry(target, item);
        }
      }
    }
  }
}

function collectExpressionsFromCandidate(target: Set<string>, candidate: unknown) {
  if (candidate === undefined) {
    return;
  }

  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      if (typeof item === "string") {
        addName(target, item);
        continue;
      }
      addNameFromEntry(target, item);
    }
    return;
  }

  if (isObject(candidate)) {
    // Runtime probe rule:
    // 1) Cubism2/4 commonly expose expressions as arrays under settings.expressions/settings.Expressions.
    // 2) Some wrappers expose expression definitions as a record keyed by expression id/name.
    // We check both record keys and known string fields ("name/Name/id/Id") defensively.
    collectRecordKeys(target, candidate);
    for (const value of Object.values(candidate)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          addNameFromEntry(target, item);
        }
      } else if (isObject(value)) {
        addNameFromEntry(target, value);
      }
    }
  }
}

function uniqueSorted(names: Set<string>) {
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function createModelAdapter(model: unknown): ModelAdapter {
  let lastError: ModelAdapterError | null = null;

  const setError = (
    method: ModelAdapterError["method"],
    message: string,
    cause?: unknown,
  ) => {
    lastError = {
      method,
      message,
      cause,
      timestamp: Date.now(),
    };
  };

  const clearError = () => {
    lastError = null;
  };

  const playMotion = async (
    group: string,
    index?: number,
    priority?: number,
  ): Promise<boolean> => {
    const motionGroup = group.trim();
    if (motionGroup.length === 0) {
      setError("playMotion", "group must be a non-empty string.");
      return false;
    }

    try {
      const candidate = isObject(model) ? model.motion : undefined;
      if (typeof candidate !== "function") {
        setError("playMotion", "model.motion is not available.");
        return false;
      }

      const motionFn = candidate as MotionCallable;
      const started = await Promise.resolve(
        motionFn.call(model, motionGroup, index, priority),
      );
      if (!started) {
        setError("playMotion", `motion did not start: ${motionGroup}`);
        return false;
      }

      clearError();
      return true;
    } catch (error) {
      setError("playMotion", `motion failed: ${motionGroup}`, error);
      return false;
    }
  };

  const setExpression = async (name: string): Promise<boolean> => {
    const expressionName = name.trim();
    if (expressionName.length === 0) {
      setError("setExpression", "name must be a non-empty string.");
      return false;
    }

    try {
      const candidate = isObject(model) ? model.expression : undefined;
      if (typeof candidate !== "function") {
        setError("setExpression", "model.expression is not available.");
        return false;
      }

      const expressionFn = candidate as ExpressionCallable;
      const applied = await Promise.resolve(
        expressionFn.call(model, expressionName),
      );
      if (!applied) {
        setError("setExpression", `expression did not apply: ${expressionName}`);
        return false;
      }

      clearError();
      return true;
    } catch (error) {
      setError("setExpression", `expression failed: ${expressionName}`, error);
      return false;
    }
  };

  const applyTween = (preset: TweenPreset, strength = 1) => {
    try {
      applyTweenPreset(
        model as {
          position?: { x: number; y: number; set?: (x: number, y?: number) => unknown };
          scale?: { x: number; y: number; set?: (x: number, y?: number) => unknown };
          rotation?: number;
        },
        preset,
        strength,
        (error) => {
          setError("applyTween", `tween failed: ${preset} (${error.message})`, error);
        },
      );
    } catch (error) {
      setError("applyTween", `tween failed: ${preset} (${toErrorMessage(error)})`, error);
    }
  };

  const listMotions = (): string[] => {
    try {
      const names = new Set<string>();
      const candidates = [
        readPath(model, ["internalModel", "settings", "motions"]),
        readPath(model, ["internalModel", "settings", "Motions"]),
        readPath(model, ["internalModel", "settings", "json", "motions"]),
        readPath(model, ["internalModel", "motionManager", "definitions"]),
        readPath(model, ["internalModel", "motionManager", "_definitions"]),
      ];

      for (const candidate of candidates) {
        collectMotionsFromCandidate(names, candidate);
      }

      return uniqueSorted(names);
    } catch (error) {
      setError("listMotions", `failed to list motions: ${toErrorMessage(error)}`, error);
      return [];
    }
  };

  const listExpressions = (): string[] => {
    try {
      const names = new Set<string>();
      const candidates = [
        readPath(model, ["internalModel", "settings", "expressions"]),
        readPath(model, ["internalModel", "settings", "Expressions"]),
        readPath(model, ["internalModel", "settings", "json", "expressions"]),
        readPath(model, [
          "internalModel",
          "motionManager",
          "expressionManager",
          "definitions",
        ]),
        readPath(model, [
          "internalModel",
          "motionManager",
          "expressionManager",
          "settings",
          "expressions",
        ]),
      ];

      for (const candidate of candidates) {
        collectExpressionsFromCandidate(names, candidate);
      }

      return uniqueSorted(names);
    } catch (error) {
      setError(
        "listExpressions",
        `failed to list expressions: ${toErrorMessage(error)}`,
        error,
      );
      return [];
    }
  };

  return {
    get lastError() {
      return lastError;
    },
    playMotion,
    setExpression,
    applyTween,
    listMotions,
    listExpressions,
  };
}
