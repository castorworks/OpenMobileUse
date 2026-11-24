import { screenshotSize } from './inspect.js';
import { object } from './script.js';
import {
  executeStep,
  guardObservation,
  pointInView,
  screenAvailable,
  type Bounds,
  type Point,
  type StepDevice,
  type View,
} from './steps.js';

// Target and optional same-row landmark patches use the same working scale on every host.
const side = 480,
  width = 25,
  height = 17,
  bytes = width * height * 3;
type RowLandmark = { rgb: string; offsetX: number };
export type ImageTarget = { rgb: string; dx: number; dy: number; match?: 'contour'; row?: RowLandmark };
type Pixels = { data: Buffer; info: { width: number; height: number } };

function isPatch(value: unknown): value is string {
  return typeof value === 'string' && value.length === (bytes / 3) * 4 &&
    /^[A-Za-z0-9+/]+$/.test(value);
}

function isRowLandmark(value: unknown): value is RowLandmark {
  return (
    object(value) &&
    Object.keys(value).every((key) => ['rgb', 'offsetX'].includes(key)) &&
    isPatch(value.rgb) &&
    typeof value.offsetX === 'number' &&
    Number.isInteger(value.offsetX) &&
    Math.abs(value.offsetX) >= width &&
    Math.abs(value.offsetX) <= side - width
  );
}

export function isImageTarget(value: unknown): value is ImageTarget {
  return (
    object(value) &&
    Object.keys(value).every((key) => ['rgb', 'dx', 'dy', 'match', 'row'].includes(key)) &&
    (value.match === undefined || value.match === 'contour') &&
    isPatch(value.rgb) &&
    (value.row === undefined || (value.match === undefined && isRowLandmark(value.row))) &&
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

function patchAt(frame: Pixels, left: number, top: number) {
  const rgb = Buffer.alloc(bytes);
  for (let row = 0; row < height; row++) {
    const start = ((top + row) * frame.info.width + left) * 3;
    frame.data.copy(rgb, row * width * 3, start, start + width * 3);
  }
  return rgb.toString('base64');
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
  const target = { rgb: patchAt(frame, left, top), dx: x - left, dy: y - top };
  // Select a matcher only if it uniquely identifies this point on the original screen.
  // Replay must use that same evidence, even if another matcher happens to find a candidate.
  const contour = locateContour(frame, target);
  if (contour && contour !== 'ambiguous') return { ...target, match: 'contour' };
  if (locateRgb(frame, target.rgb)) return target;
  // A repeated button can be identified by a different title on its row. First require
  // the button itself to have visible detail, then look for a non-overlapping landmark.
  if (locateRgb(frame, target.rgb, { x: left, y: top })) {
    for (let distance = width; distance <= w - width; distance += width >> 1) {
      for (const offsetX of [-distance, distance]) {
        const contextLeft = left + offsetX;
        if (contextLeft < 0 || contextLeft + width > w) continue;
        const rgb = patchAt(frame, contextLeft, top);
        if (locateRgb(frame, rgb)) return { ...target, row: { rgb, offsetX } };
      }
    }
  }
  throw Error('VISUAL_TARGET_UNCLEAR');
}

// The signed high-pass response keeps a thin icon's strokes when the video under it
// changes colour or brightness. Applying it to both images avoids depending on a fixed theme.
function contours(rgb: Buffer, w: number, h: number) {
  const light = new Uint8Array(w * h);
  for (let i = 0; i < light.length; i++) {
    const at = i * 3;
    light[i] = (rgb[at] + 2 * rgb[at + 1] + rgb[at + 2]) >> 2;
  }
  const result = new Int16Array(w * h);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const edge = 4 * light[i] - light[i - 2] - light[i + 2] - light[i - 2 * w] - light[i + 2 * w];
      // Compress large responses so that one sharp video edge cannot dominate the entire icon.
      result[i] = Math.sign(edge) * Math.round(16 * Math.sqrt(Math.abs(edge)));
    }
  }
  return result;
}

function locateContour(frame: Pixels, target: ImageTarget): Point | 'ambiguous' | undefined {
  const { width: w, height: h } = frame.info;
  const patch = contours(Buffer.from(target.rgb, 'base64'), width, height);
  // Match the neighbourhood of the requested point. The rest of a patch may be moving video.
  const left = Math.max(2, target.dx - 6);
  const right = Math.min(width - 3, target.dx + 6);
  const top = Math.max(2, target.dy - 6);
  const bottom = Math.min(height - 3, target.dy + 6);
  const samples = (right - left + 1) * (bottom - top + 1);
  if (samples < 64) return;
  const weights = new Uint8Array(width * height);
  const weightedPatch = new Int32Array(width * height);
  const parts = new Uint8Array(width * height);
  const partEnergy = [0, 0, 0, 0];
  let weightSum = 0;
  let patchEnergy = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const i = y * width + x;
      // The model points to the centre of the icon. Give its strokes more weight than the periphery.
      const weight = (7 - Math.abs(x - target.dx)) * (7 - Math.abs(y - target.dy));
      weights[i] = weight;
      weightedPatch[i] = weight * patch[i];
      parts[i] = Number(x >= target.dx) + 2 * Number(y >= target.dy);
      partEnergy[parts[i]] += weightedPatch[i] * patch[i];
      patchEnergy += weightedPatch[i] * patch[i];
      weightSum += weight;
    }
  }
  // Squaring the encoded response recovers its original magnitude times 16².
  const minEnergy = weightSum * 8 * 16 ** 2;
  if (patchEnergy < minEnergy) return;

  const screen = contours(frame.data, w, h);
  // The complete ring of a search icon can outscore a missing handle. Verify each
  // quadrant carrying appreciable detail before accepting even a strong overall match.
  function matchesParts(x: number, y: number) {
    const dots = [0, 0, 0, 0];
    const energies = [0, 0, 0, 0];
    for (let row = top; row <= bottom; row++) {
      for (let col = left; col <= right; col++) {
        const i = row * width + col;
        const pixel = screen[(y + row) * w + x + col];
        const part = parts[i];
        dots[part] += pixel * weightedPatch[i];
        energies[part] += pixel * pixel * weights[i];
      }
    }
    return partEnergy.every(
      (energy, part) =>
        energy < 0.1 * patchEnergy || dots[part] > 0.8 * Math.sqrt(energies[part] * energy),
    );
  }
  let near: Point | undefined;
  let best: Point | undefined;
  let bestScore = 0.9 ** 2;
  for (let y = 0; y <= h - height; y++) {
    for (let x = 0; x <= w - width; x++) {
      let dot = 0;
      let energy = 0;
      for (let row = top; row <= bottom; row++) {
        const start = (y + row) * w + x;
        for (let col = left; col <= right; col++) {
          const pixel = screen[start + col];
          const i = row * width + col;
          dot += pixel * weightedPatch[i];
          energy += pixel * pixel * weights[i];
        }
      }
      if (energy < minEnergy || dot <= 0) continue;
      const score = dot * dot / (energy * patchEnergy);
      if (score < 0.8 ** 2) continue;
      // A plausible second copy anywhere on the screen makes a tap unsafe.
      if (near && (Math.abs(near.x - x) > 4 || Math.abs(near.y - y) > 4)) return 'ambiguous';
      near ??= { x, y };
      if (score >= bestScore && matchesParts(x, y)) {
        best = { x, y };
        bestScore = score;
      }
    }
  }
  if (best) return { x: (best.x + target.dx) / (w - 1), y: (best.y + target.dy) / (h - 1) };
}

// Returns the top-left pixel of the unique match. With an origin, verify only that placement.
function locateRgb(frame: Pixels, rgb: string, origin?: Point): Point | undefined {
  const patch = Buffer.from(rgb, 'base64');
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
  if (strength < 30) return;
  const probe = Math.floor(edge / width) * stride + (edge % width) * 3 + channel;
  const colour = patch[edge * 3 + channel],
    adjacent = patch[edge * 3 + channel + 3];
  let best: Point | undefined,
    near: Point | undefined,
    bestError = Infinity;
  const maxX = frame.info.width - width;
  const maxY = frame.info.height - height;
  if (origin && (origin.x < 0 || origin.x > maxX || origin.y < 0 || origin.y > maxY)) return;
  for (let y = origin?.y ?? 0; y <= (origin?.y ?? maxY); y++) {
    for (let x = origin?.x ?? 0; x <= (origin?.x ?? maxX); x++) {
      const start = y * stride + x * 3,
        probeAt = start + probe;
      if (
        Math.abs(frame.data[probeAt] - colour) > 60 ||
        Math.abs(frame.data[probeAt + 3] - adjacent) > 60
      )
        continue;
      // A landmark fixes the expected position, but a missing faint button can still
      // match a mostly white patch. Require its strongest stroke to remain there.
      if (origin) {
        const edgeDelta = frame.data[probeAt] - frame.data[probeAt + 3];
        if (edgeDelta * (colour - adjacent) < strength ** 2 * 0.5) continue;
      }
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
      if (near && (Math.abs(near.x - x) > 4 || Math.abs(near.y - y) > 4)) return;
      near ??= { x, y };
      if (error > bytes * 5 || outliers > bytes * 0.025) continue;
      if (error < bestError) {
        best = { x, y };
        bestError = error;
      }
    }
  }
  return best;
}

function locateImage(frame: Pixels, target: ImageTarget) {
  if (target.match === 'contour') return locateContour(frame, target);
  let origin: Point | undefined;
  if (target.row) {
    const landmark = locateRgb(frame, target.row.rgb);
    if (!landmark) return;
    origin = { x: landmark.x - target.row.offsetX, y: landmark.y };
  }
  const hit = locateRgb(frame, target.rgb, origin);
  if (hit) return {
    x: (hit.x + target.dx) / (frame.info.width - 1),
    y: (hit.y + target.dy) / (frame.info.height - 1),
  };
}

export async function executeImageTarget(
  device: StepDevice,
  identity: string,
  view: View,
  target: ImageTarget,
  tap: boolean,
  signal: AbortSignal,
  livePoint?: Point & { bounds?: Bounds },
) {
  const png = await imageFrame(device, identity, view, signal);
  const frame = await pixels(png);
  let point = locateImage(frame, target);
  // Video can temporarily hide the strokes of a toolbar icon. A live tap has an
  // observed position, so one more frame can verify that very icon, before any dispatch.
  // A second plausible copy is ambiguous immediately. Playback owns its own read retries.
  if (!point && tap && livePoint && target.match === 'contour') {
    const next = await imageFrame(device, identity, view, signal);
    if (!next.equals(png)) {
      const retryFrame = await pixels(next);
      const retry = locateContour(retryFrame, target);
      if (retry && retry !== 'ambiguous' &&
        Math.abs(retry.x - livePoint.x) * (retryFrame.info.width - 1) <= 4 &&
        Math.abs(retry.y - livePoint.y) * (retryFrame.info.height - 1) <= 4)
        point = retry;
    }
  }
  if (!point || point === 'ambiguous') throw Error('VISUAL_TARGET_UNCLEAR');
  if (livePoint?.bounds) {
    const { x, y } = pointInView(view, point);
    const b = livePoint.bounds;
    if (x < b.x || x >= b.x + b.width || y < b.y || y >= b.y + b.height)
      throw Error('VISUAL_TARGET_UNCLEAR');
  }
  signal.throwIfAborted();
  if (tap) {
    const step = { kind: 'tap' as const, point };
    const scope = target.match === 'contour' ? { kind: 'visualTap' as const, point } : step;
    await executeStep(
      device,
      identity,
      step,
      guardObservation(identity, view, scope, screenAvailable),
      signal,
    );
  }
}
