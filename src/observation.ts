import { setTimeout as sleep } from 'node:timers/promises';

export function reason(error: unknown) {
  return /^[A-Z][A-Z_0-9]*(?=:|$)/.exec((error as Error)?.message)?.[0] || 'DEVICE_ERROR';
}

export function isTransientObservation(code: string) {
  return [
    'STALE_OBSERVATION',
    'FOREGROUND_WINDOW_AMBIGUOUS',
    'FOREGROUND_APP_UNAVAILABLE',
    'HDC_LAYOUT_UNAVAILABLE',
    'DISPLAY_GEOMETRY_UNAVAILABLE',
    'DISPLAY_ROTATION_UNAVAILABLE',
    'SCREENSHOT_UNAVAILABLE',
    'SCREENSHOT_GEOMETRY_MISMATCH',
    'INVALID_PNG',
  ].includes(code);
}

// These target checks reject the requested gesture or text edit before it is sent.
export function isTargetUnavailable(code: string) {
  return [
    'ELEMENT_NOT_FOUND',
    'AMBIGUOUS_ELEMENT',
    'AMBIGUOUS_OR_MISSING_ELEMENT',
    'ELEMENT_DISABLED',
    'ELEMENT_OUTSIDE_SCREEN',
    'NO_FOCUSED_FIELD',
    'NAVIGATION_BUTTON_REQUIRED',
    'INPUT_TARGET_CHANGED',
    'INPUT_FOCUS_UNCONFIRMED',
    'SCREEN_TEXT_NOT_UNIQUE_OR_MISSING',
    'VISUAL_TARGET_UNCLEAR',
  ].includes(code);
}

// Retry reads only. Callers validate the returned observation before acting on it.
export async function readObservation<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const observation = await read();
      signal?.throwIfAborted();
      return observation;
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt === 3 || !isTransientObservation(reason(error))) throw error;
      await sleep(200, undefined, { signal });
    }
  }
}
