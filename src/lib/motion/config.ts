export type TweenPreset = "bounce" | "shake" | "nod";

export type ActionBase = {
  cooldownMs?: number;
};

export type MotionAction = ActionBase & {
  kind: "motion";
  group: string;
  index?: number;
  priority?: number;
};

export type ExpressionAction = ActionBase & {
  kind: "expression";
  name: string;
};

export type TweenAction = ActionBase & {
  kind: "tween";
  preset: TweenPreset;
  strength?: number;
};

export type ComboAction = ActionBase & {
  kind: "combo";
  ruleId: string;
};

export type InputAction =
  | MotionAction
  | ExpressionAction
  | TweenAction
  | ComboAction;

export type ExecutableInputAction = Exclude<InputAction, ComboAction>;

export type ComboRule = {
  id: string;
  sequence: string[];
  withinMs: number;
  action: ExecutableInputAction;
  cooldownMs?: number;
};

export type IdleEntry = {
  action: ExecutableInputAction;
  weight?: number;
};

export type IdleConfig = {
  enabled: boolean;
  afterMs: number;
  intervalMs?: number;
  actions: IdleEntry[];
};

export type MotionConfig = {
  version: 1;
  keyMap: Record<string, InputAction>;
  comboRules: ComboRule[];
  idle: IdleConfig;
};

function cloneAction(action: InputAction): InputAction {
  switch (action.kind) {
    case "motion":
      return {
        kind: "motion",
        group: action.group,
        index: action.index,
        priority: action.priority,
        cooldownMs: action.cooldownMs,
      };
    case "expression":
      return {
        kind: "expression",
        name: action.name,
        cooldownMs: action.cooldownMs,
      };
    case "tween":
      return {
        kind: "tween",
        preset: action.preset,
        strength: action.strength,
        cooldownMs: action.cooldownMs,
      };
    case "combo":
      return {
        kind: "combo",
        ruleId: action.ruleId,
        cooldownMs: action.cooldownMs,
      };
  }
}

export function cloneMotionConfig(config: MotionConfig): MotionConfig {
  const keyMap: Record<string, InputAction> = {};
  for (const [input, action] of Object.entries(config.keyMap)) {
    keyMap[input] = cloneAction(action);
  }

  return {
    version: 1,
    keyMap,
    comboRules: config.comboRules.map((rule) => ({
      id: rule.id,
      sequence: [...rule.sequence],
      withinMs: rule.withinMs,
      action: cloneAction(rule.action) as ExecutableInputAction,
      cooldownMs: rule.cooldownMs,
    })),
    idle: {
      enabled: config.idle.enabled,
      afterMs: config.idle.afterMs,
      intervalMs: config.idle.intervalMs,
      actions: config.idle.actions.map((entry) => ({
        action: cloneAction(entry.action) as ExecutableInputAction,
        weight: entry.weight,
      })),
    },
  };
}

export const defaultMotionConfig: MotionConfig = {
  version: 1,
  keyMap: {
    KeyA: {
      kind: "motion",
      group: "tap_left",
      index: 0,
      priority: 2,
      cooldownMs: 120,
    },
    KeyD: {
      kind: "motion",
      group: "tap_right",
      index: 0,
      priority: 2,
      cooldownMs: 120,
    },
    MouseLeft: {
      kind: "tween",
      preset: "bounce",
      strength: 0.8,
      cooldownMs: 80,
    },
    KeyS: {
      kind: "expression",
      name: "smile",
      cooldownMs: 800,
    },
    KeyQ: {
      kind: "combo",
      ruleId: "left-right-burst",
      cooldownMs: 200,
    },
  },
  comboRules: [
    {
      id: "left-right-burst",
      sequence: ["KeyA", "KeyD"],
      withinMs: 250,
      action: {
        kind: "motion",
        group: "combo_burst",
        priority: 3,
        cooldownMs: 500,
      },
      cooldownMs: 700,
    },
  ],
  idle: {
    enabled: true,
    afterMs: 8_000,
    intervalMs: 6_000,
    actions: [
      {
        action: { kind: "motion", group: "idle_1" },
        weight: 3,
      },
      {
        action: { kind: "motion", group: "idle_2" },
        weight: 2,
      },
      {
        action: { kind: "expression", name: "blink" },
        weight: 1,
      },
    ],
  },
};
