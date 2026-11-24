import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readObservation } from './observation.js';
import { observationId, visibleCenter, type StepDevice, type View } from './steps.js';

type CaptureDevice = StepDevice & {
  settingsScreen?(view: View): { page: string; marker?: string };
};

function sameWindow(a: View, b: View) {
  return (
    a.app === b.app &&
    a.window === b.window &&
    a.rotation === b.rotation &&
    a.width === b.width &&
    a.height === b.height
  );
}

export function screenshotSize(image: Buffer, view: View) {
  if (
    image.length < 24 ||
    image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    image.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new Error('INVALID_PNG');
  const width = image.readUInt32BE(16),
    height = image.readUInt32BE(20);
  if (!width || !height || Math.abs(width / view.width - height / view.height) > 0.02)
    throw new Error('SCREENSHOT_GEOMETRY_MISMATCH');
  return { width, height };
}

export async function captureView(device: CaptureDevice, identity: string) {
  return readObservation(async () => {
    const before = await device.snapshot();
    const image = await device.screenshot();
    const view = await device.snapshot();
    if (!sameWindow(before, view)) throw Error('STALE_OBSERVATION');
    const { width, height } = screenshotSize(image, view);
    const token = observationId(identity, view);
    // Keep the CLI diagnostics fields without making Settings classification part of every snapshot.
    const settings = device.settingsScreen?.(view);
    const metadata = {
      observationId: token,
      controlsChangedDuringCapture: observationId(identity, before) !== token,
      observedAt: new Date().toISOString(),
      app: view.app,
      rotation: view.rotation,
      width,
      height,
      actionWidth: view.width,
      actionHeight: view.height,
      page: settings?.page ?? 'other',
      marker: settings?.marker,
    };
    const controls = view.controls.map((n) => {
      const center = visibleCenter(view, n.bounds);
      return {
        ...n,
        center: {
          x: center.x / Math.max(1, view.width - 1),
          y: center.y / Math.max(1, view.height - 1),
        },
      };
    });
    return { metadata, controls, image, layout: view.layout, before, view };
  });
}

export async function saveCapture(dir: string, device: CaptureDevice, identity: string) {
  const { metadata, controls, image, layout } = await captureView(device, identity);
  const staging = await mkdtemp(dir + '.');
  try {
    await writeFile(join(staging, 'screen.png'), image, { mode: 0o600 });
    const xml = typeof layout === 'string';
    await writeFile(
      join(staging, xml ? 'layout.xml' : 'layout.json'),
      xml ? (layout as string) : JSON.stringify(layout),
      { mode: 0o600 },
    );
    await writeFile(
      join(staging, 'controls.json'),
      JSON.stringify({ ...metadata, controls }, null, 2) + '\n',
      { mode: 0o600 },
    );
    await rename(staging, dir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { directory: dir, ...metadata };
}
