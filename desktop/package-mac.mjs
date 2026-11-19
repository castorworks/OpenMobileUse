import { execFileSync } from 'node:child_process';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

if (process.platform !== 'darwin') throw Error('Build the Mac desktop app on macOS.');
const project = fileURLToPath(new URL('../', import.meta.url));
const out = join(project, 'desktop/dist');
await mkdir(out, { recursive: true });
const staging = await mkdtemp(join(out, '.package-'));
const bundle = join(staging, 'Open Mobile Use.app');
const contents = join(bundle, 'Contents');
const appDir = join(contents, 'Resources/app');
const run = (bin, args) => execFileSync(bin, args, { stdio: 'inherit' });
try {
  run('/usr/bin/ditto', [join(project, 'desktop/node_modules/electron/dist/Electron.app'), bundle]);
  for (const [key, value] of Object.entries({
    CFBundleName: 'Open Mobile Use',
    CFBundleDisplayName: 'Open Mobile Use',
    CFBundleIdentifier: 'com.castorworks.openmobileuse',
    CFBundleIconFile: 'OpenMobileUse.icns',
  })) {
    run('/usr/bin/plutil', ['-replace', key, '-string', value, join(contents, 'Info.plist')]);
  }
  const desktop = join(appDir, 'desktop');
  await mkdir(desktop, { recursive: true });
  const mark = join(project, 'desktop/brand.png');
  await copyFile(mark, join(desktop, 'brand.png'));
  const iconset = join(staging, 'OpenMobileUse.iconset');
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = size * scale;
      const inset = Math.round(pixels * 0.09);
      await sharp(mark)
        .resize(pixels - inset * 2)
        .extend({
          top: inset,
          bottom: inset,
          left: inset,
          right: inset,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toFile(join(iconset, 'icon_' + size + 'x' + size + (scale === 2 ? '@2x' : '') + '.png'));
    }
  }
  run('/usr/bin/iconutil', [
    '-c',
    'icns',
    iconset,
    '-o',
    join(contents, 'Resources/OpenMobileUse.icns'),
  ]);
  const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ ...pkg, main: 'desktop/main.cjs' }));
  await copyFile(join(project, 'package-lock.json'), join(appDir, 'package-lock.json'));
  run('npm', ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', appDir]);
  for (const name of ['dist', 'examples', 'LICENSE']) {
    await cp(join(project, name), join(appDir, name), { recursive: true });
  }
  for (const name of await readdir(join(project, 'desktop'))) {
    if (name !== 'package-mac.mjs' && /\.(?:cjs|mjs|js|html|css)$/.test(name))
      await copyFile(join(project, 'desktop', name), join(desktop, name));
  }
  const bin = join(appDir, 'bin/node');
  await mkdir(dirname(bin), { recursive: true });
  await writeFile(bin, '#!/bin/sh\nexec "$OMU_NODE_BINARY" "$@"\n', { mode: 0o755 });
  await rm(join(contents, 'Resources/default_app.asar'));
  // Produce an ad hoc signed local build, including the Electron helpers and frameworks.
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const target = join(out, 'Open Mobile Use.app');
  const previous = join(staging, 'previous.app');
  try {
    await rename(target, previous);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  try {
    await rename(bundle, target);
  } catch (e) {
    await rename(previous, target).catch(() => {});
    throw e;
  }
  console.log(target);
} finally {
  await rm(staging, { recursive: true, force: true });
}
