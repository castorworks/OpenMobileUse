import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { observationId, visibleCenter, type StepDevice, type View } from './steps.js';

function sameWindow(a: View, b: View) {
  return (
    a.app === b.app &&
    a.window === b.window &&
    a.rotation === b.rotation &&
    a.width === b.width &&
    a.height === b.height
  );
}

export async function captureView(device: StepDevice, identity: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let before: View, view: View, image: Buffer;
    try {
      before = await device.snapshot();
      image = await device.screenshot();
      view = await device.snapshot();
    } catch (error) {
      if ((error as Error).message === 'STALE_OBSERVATION' && attempt === 0) continue;
      throw error;
    }
    if (
      image.length < 24 ||
      image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      image.toString('ascii', 12, 16) !== 'IHDR'
    )
      throw new Error('INVALID_PNG');
    const width = image.readUInt32BE(16),
      height = image.readUInt32BE(20);
    if (!sameWindow(before, view)) continue;
    if (!width || !height || Math.abs(width / view.width - height / view.height) > 0.02)
      throw new Error('SCREENSHOT_GEOMETRY_MISMATCH');
    const token = observationId(identity, view);
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
      page: view.screen.page,
      marker: view.screen.marker,
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
    return { metadata, controls, image, layout: view.layout };
  }
  throw new Error('STALE_OBSERVATION');
}

export async function saveCapture(dir: string, device: StepDevice, identity: string) {
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
