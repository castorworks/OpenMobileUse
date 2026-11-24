import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { screenshotSize } from './inspect.js';
import { executeStep, guardObservation, screenAvailable, type StepDevice, type View } from './steps.js';

export type ScreenTextLine = { text: string; confidence: number; x: number; y: number };
export type ScreenTextRecognizer = (
  image: Buffer,
  size: { width: number; height: number },
  signal: AbortSignal,
) => Promise<ScreenTextLine[]>;
const helper = fileURLToPath(new URL('./recognize-text', import.meta.url));
const key = (text: string) =>
  text
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/(?<=\p{Script=Han}) (?=\p{Script=Han})/gu, '');

function recognizeAppleText(image: Buffer, signal: AbortSignal): Promise<ScreenTextLine[]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(helper, [], { timeout: 8000, signal, maxBuffer: 1024 * 1024 }, (err, out) => {
      if (err) return reject(Error('SCREEN_TEXT_UNAVAILABLE'));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(Error('SCREEN_TEXT_UNAVAILABLE'));
      }
    });
    child.stdin!.on('error', () => reject(Error('SCREEN_TEXT_UNAVAILABLE')));
    child.stdin!.end(image);
  });
}

export const recognizePortableText: ScreenTextRecognizer = async (image, size, signal) => {
  signal.throwIfAborted();
  // Keep the WASM engine and its worker off the main thread, with explicit cancellation.
  let worker: Worker | undefined;
  try {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
    worker = new Worker(new URL('./screen-text-worker.js', import.meta.url), {
      workerData: { image, ...size },
      execArgv: [],
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    const [lines] = await once(worker, 'message', { signal: deadline });
    return lines;
  } catch {
    signal.throwIfAborted();
    throw Error('SCREEN_TEXT_UNAVAILABLE');
  } finally {
    await worker?.terminate();
  }
};

const recognizeScreenText: ScreenTextRecognizer = async (image, size, signal) => {
  if (process.platform === 'darwin' && existsSync(helper)) {
    try {
      return await recognizeAppleText(image, signal);
    } catch {
      signal.throwIfAborted();
    }
  }
  return recognizePortableText(image, size, signal);
};

export async function readScreenText(
  device: StepDevice,
  identity: string,
  before: View,
  signal: AbortSignal,
  captured?: Buffer,
  recognize: ScreenTextRecognizer = recognizeScreenText,
) {
  screenAvailable(before);
  signal.throwIfAborted();
  const image = captured ?? (await device.screenshot());
  const size = screenshotSize(image, before);
  const lines = await recognize(image, size, signal);
  const fresh = await device.snapshot();
  signal.throwIfAborted();
  guardObservation(identity, before, { kind: 'check' }, screenAvailable)(fresh);
  // Count every occurrence, including low-confidence ones, before offering unique text as a target.
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(key(line.text), (counts.get(key(line.text)) || 0) + 1);
  const targets = lines.filter(
    (line) =>
      key(line.text).length > 0 &&
      line.text.length <= 160 &&
      counts.get(key(line.text)) === 1 &&
      line.confidence >= 0.5 &&
      line.x > 0 &&
      line.x < 1 &&
      line.y > 0 &&
      line.y < 1,
  );
  return { targets, view: fresh, image };
}

export async function executeTextTarget(
  device: StepDevice,
  identity: string,
  before: View,
  text: string,
  action: 'tap' | 'check',
  signal: AbortSignal,
  recognize?: ScreenTextRecognizer,
) {
  const { view, targets } = await readScreenText(device, identity, before, signal, undefined, recognize);
  const hit = targets.find((line) => key(line.text) === key(text));
  if (!hit) throw Error('SCREEN_TEXT_NOT_UNIQUE_OR_MISSING');
  if (action === 'tap') {
    const step = { kind: 'tap' as const, point: { x: hit.x, y: hit.y } };
    const validate = guardObservation(identity, before, step, screenAvailable);
    validate(view);
    await executeStep(device, identity, step, validate, signal);
  }
}
