import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Screen } from './navigation.js';

export interface Capture {
  image: Buffer;
  layout: unknown;
  screen: Screen;
}
export async function saveCapture(dir: string, capture: Capture) {
  const { image, layout, screen } = capture;
  if (
    image.length < 24 ||
    image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    image.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new Error('Invalid PNG screenshot');
  const width = image.readUInt32BE(16),
    height = image.readUInt32BE(20);
  if (!width || !height) throw new Error('Empty screenshot');
  await mkdir(dir, { mode: 0o700 });
  await writeFile(join(dir, 'screen.png'), image, { mode: 0o600 });
  const xml = typeof layout === 'string';
  await writeFile(join(dir, xml ? 'layout.xml' : 'layout.json'), xml ? layout : JSON.stringify(layout), {
    mode: 0o600,
  });
  return { directory: dir, width, height, page: screen.page, marker: screen.marker };
}
