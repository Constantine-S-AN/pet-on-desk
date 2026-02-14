# live2d-desktop-pet

A cross-platform desktop pet built with Tauri v2 + React + Vite + TypeScript + `pixi-live2d-display`.

## Features

- Transparent pet window (frameless, always-on-top, fixed size)
- Settings window for model path, scale, position, motion mapping, diagnostics
- Click-through toggle (shortcut and tray integration)
- Global input listener (Rust `rdev`) forwarding events to frontend
- Motion engine with:
  - input -> motion/expression/tween mapping
  - combo rules
  - idle actions with weighted random selection
  - fallback tween so the model always reacts
- Model adapter layer to safely wrap Live2D runtime calls

## Tech stack

- Frontend: React + TypeScript + Vite + PixiJS + pixi-live2d-display
- Backend: Tauri v2 (Rust)
- Storage: Tauri Store plugin
- Runtime extras: system tray, autostart, updater

## Prerequisites

- Node.js 18+
- pnpm 8+
- Rust stable toolchain
- Tauri v2 prerequisites for your OS

For macOS global input capture:
- enable permissions in `System Settings -> Privacy & Security -> Input Monitoring`
- if needed, also enable `Accessibility`
- restart the app after granting permissions

## Install

```bash
pnpm install
```

## Run (development)

```bash
pnpm tauri dev
```

Expected result:
- main transparent desktop pet window launches
- settings window can be opened via tray/menu shortcut

## Build

```bash
pnpm build
pnpm tauri build
```

## Model and motion config

- Default model entry:
  - `public/models/default/model.model3.json`
- Motion config example:
  - `public/motionMap.example.json`
- Motion config schema/types:
  - `src/lib/motion/config.ts`
  - `src/lib/motion/validate.ts`

## Recent motion layer additions

- `src/lib/motion/modelAdapter.ts`
  - `createModelAdapter(model)`
  - safe wrappers:
    - `playMotion(group, index?, priority?)`
    - `setExpression(name)`
    - `applyTween(preset, strength)`
    - `listMotions()`
    - `listExpressions()`
  - never throws; keeps `lastError` for diagnostics
- `src/lib/motion/tweenPresets.ts`
  - preset tweens: `bounce`, `shake`, `nod`
  - transform-only animation (`position/scale/rotation`) via `requestAnimationFrame`

## Key directories

- `src/components` - React UI components (`PetStage`, settings UI)
- `src/lib` - event wiring, settings, motion engine, model adapter
- `src-tauri/src` - Rust commands, listeners, tray/autostart/updater setup
- `src-tauri/capabilities` - Tauri ACL capability files

## Troubleshooting

- No global input events:
  - verify Input Monitoring / Accessibility permissions
  - restart the app
- Live2D model does not react:
  - check model motion group names
  - verify motion config mapping
  - fallback tween should still play even when motion lookup fails
