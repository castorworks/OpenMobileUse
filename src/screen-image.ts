import { screenshotSize } from './inspect.js';
import { object } from './script.js';
import {
  executeStep,
  guardObservation,
  screenAvailable,
  type Point,
  type StepDevice,
  type View,
} from './steps.js';

// Store only a small RGB patch around the selected point. All frames use the same working scale.
const side = 480,
  width = 25,
  height = 17,
  bytes = width * height * 3;
export type ImageTarget = { rgb: string; dx: number; dy: number };
type Pixels = { data: Buffer; info: { width: number; height: number } };

export function isImageTarget(value: unknown): value is ImageTarget {
  return (
    object(value) &&
    Object.keys(value).length === 3 &&
    typeof value.rgb === 'string' &&
    value.rgb.length === (bytes / 3) * 4 &&
    /^[A-Za-z0-9+/]+$/.test(value.rgb) &&
    typeof value.dx === 'number' &&
    Number.isInteger(value.dx) &&
    value.dx >= 0 &&
    value.dx < width &&
    typeof value.dy === 'number' &&
    Number.isInteger(value.dy) &&
    value.dy >= 0 &&
    value.dy < height
  );
}

export async function imageFrame(device: StepDevice, identity: string, view: View, signal: AbortSignal) {
  signal.throwIfAborted();
  screenAvailable(view);
  const png = await device.screenshot();
  screenshotSize(png, view);
  const fresh = await device.snapshot();
  signal.throwIfAborted();
  guardObservation(identity, view, { kind: 'check' }, screenAvailable)(fresh);
  return png;
}

function invalidPng(): never {
  throw Error('INVALID_PNG');
}

async function pixels(png: Buffer) {
  const { default: sharp } = await import('sharp');
  return sharp(png, { limitInputPixels: 32000000 })
    .resize({ width: side, height: side, fit: 'inside' })
    .blur(0.7)
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .catch(invalidPng);
}

export async function modelImage(png: Buffer) {
  const { default: sharp } = await import('sharp');
  const jpeg = await sharp(png, { limitInputPixels: 32000000 })
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer()
    .catch(invalidPng);
  return 'data:image/jpeg;base64,' + jpeg.toString('base64');
}

// Compare the content area for repeated scrolling. Ignore status bars, encoding and minor flicker.
export async function swipePreview(png: Buffer) {
  const { default: sharp } = await import('sharp');
  return sharp(png, { limitInputPixels: 32000000 })
    .resize(32, 32, { fit: 'fill' })
    .extract({ left: 0, top: 3, width: 32, height: 26 })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer()
    .catch(invalidPng);
}

export function swipePreviewChanged(before: Buffer | undefined, after: Buffer) {
  if (!before) return true;
  let difference = 0;
  for (let i = 0; i < after.length; i++) difference += Math.abs(before[i] - after[i]);
  return difference > after.length * 3;
}

export async function imageTarget(png: Buffer, point: Point): Promise<ImageTarget> {
  const frame = await pixels(png);
  const w = frame.info.width,
    h = frame.info.height;
  if (w < width || h < height) throw Error('VISUAL_TARGET_UNCLEAR');
  const x = Math.round(point.x * (w - 1)),
    y = Math.round(point.y * (h - 1));
  const left = Math.min(w - width, Math.max(0, x - (width >> 1)));
  const top = Math.min(h - height, Math.max(0, y - (height >> 1)));
  const rgb = Buffer.alloc(bytes);
  for (let row = 0; row < height; row++) {
    const start = ((top + row) * w + left) * 3;
    frame.data.copy(rgb, row * width * 3, start, start + width * 3);
  }
  const target = { rgb: rgb.toString('base64'), dx: x - left, dy: y - top };
  locate(frame, target); // Reject a uniform or repeated patch on the model's own frame first.
  return target;
}

function locate(frame: Pixels, target: ImageTarget): Point {
  const patch = Buffer.from(target.rgb, 'base64');
  const stride = frame.info.width * 3;
  // Use the strongest horizontal colour edge to discard unlikely positions before matching the patch.
  let edge = 0,
    channel = 0,
    strength = 0;
  for (let i = 0; i < bytes - 3; i++) {
    if (Math.floor(i / 3) % width === width - 1) continue;
    const difference = Math.abs(patch[i] - patch[i + 3]);
    if (difference > strength) {
      strength = difference;
      edge = Math.floor(i / 3);
      channel = i % 3;
    }
  }
  if (strength < 30) throw Error('VISUAL_TARGET_UNCLEAR');
  const probe = Math.floor(edge / width) * stride + (edge % width) * 3 + channel;
  const colour = patch[edge * 3 + channel],
    adjacent = patch[edge * 3 + channel + 3];
  let best: Point | undefined,
    near: Point | undefined,
    bestError = Infinity;
  for (let y = 0; y <= frame.info.height - height; y++) {
    for (let x = 0; x <= frame.info.width - width; x++) {
      const start = y * stride + x * 3,
        probeAt = start + probe;
      if (
        Math.abs(frame.data[probeAt] - colour) > 60 ||
        Math.abs(frame.data[probeAt + 3] - adjacent) > 60
      )
        continue;
      let error = 0,
        outliers = 0;
      for (let row = 0; row < height && error <= bytes * 9 && outliers <= bytes * 0.08; row++) {
        const source = start + row * stride;
        for (let k = 0; k < width * 3; k++) {
          const d = Math.abs(frame.data[source + k] - patch[row * width * 3 + k]);
          error += d;
          if (d > 32) outliers++;
        }
      }
      if (error > bytes * 9 || outliers > bytes * 0.08) continue;
      // Even a weaker second match makes the target ambiguous. Allow neighbouring alignments.
      if (near && (Math.abs(near.x - x) > 4 || Math.abs(near.y - y) > 4))
        throw Error('VISUAL_TARGET_UNCLEAR');
      near ??= { x, y };
      if (error > bytes * 5 || outliers > bytes * 0.025) continue;
      if (error < bestError) {
        best = { x, y };
        bestError = error;
      }
    }
  }
  if (!best) throw Error('VISUAL_TARGET_UNCLEAR');
  return {
    x: (best.x + target.dx) / (frame.info.width - 1),
    y: (best.y + target.dy) / (frame.info.height - 1),
  };
}

export async function executeImageTarget(
  device: StepDevice,
  identity: string,
  view: View,
  target: ImageTarget,
  tap: boolean,
  signal: AbortSignal,
) {
  const png = await imageFrame(device, identity, view, signal);
  const point = locate(await pixels(png), target);
  signal.throwIfAborted();
  if (tap) {
    const step = { kind: 'tap' as const, point };
    await executeStep(
      device,
      identity,
      step,
      guardObservation(identity, view, step, screenAvailable),
      signal,
    );
  }
}
