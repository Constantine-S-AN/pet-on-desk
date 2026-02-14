import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";

export type TauriEventHandler<T = unknown> = (event: Event<T>) => void;

export function onTauriEvent<T = unknown>(
  eventName: string,
  handler: TauriEventHandler<T>,
): Promise<UnlistenFn> {
  return listen<T>(eventName, handler);
}
