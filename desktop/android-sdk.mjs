import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { stateRoot } from './library.mjs';

const exec = promisify(execFile);
const sdkLicense = 'https://developer.android.com/studio/terms';
// Google's published SHA-256 values for the Mac command-line tools, revision 15859902.
const macTools = {
  arm64: '835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e',
  x86_64: 'c5a6378ab5cf7e0d5701921405115befff13e9ff7417fb588389338f8bd050f3',
};
export const managedAndroid = () => join(stateRoot(), 'android');
export const emulatorImage = () =>
  'system-images;android-35;google_apis;' + (process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64');

async function download(url, checksum, staging, signal) {
  const archive = join(staging, 'download');
  await exec(
    '/usr/bin/curl',
    [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--retry',
      '2',
      '--max-time',
      '900',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      '--output',
      archive,
      url,
    ],
    { signal },
  );
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== checksum) throw Error('ANDROID_DOWNLOAD_CHECKSUM');
  await exec('/usr/bin/tar', ['-xf', archive, '-C', staging], { signal });
}
async function toolsBin(sdk) {
  const dir = join(sdk, 'cmdline-tools');
  return ['latest', ...(await readdir(dir).catch(() => [])).sort().reverse()]
    .map((v) => join(dir, v, 'bin'))
    .find((b) => existsSync(join(b, 'sdkmanager')) && existsSync(join(b, 'avdmanager')));
}

function installPackages(manager, sdk, packages, confirm, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(manager, ['--sdk_root=' + sdk, ...packages], {
      env: process.env,
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '',
      asking = false,
      declined = false;
    const handleOutput = async (chunk) => {
      output = (output + chunk.toString()).slice(-120000);
      if (asking || !/Accept\?\s*\(y\/N\)\s*:\s*$/i.test(output)) return;
      asking = true;
      try {
        const text = output.slice(Math.max(0, output.lastIndexOf('License '))).trim();
        const agreed = await confirm('Android SDK 许可协议', text, sdkLicense);
        declined = !agreed;
        output = '';
        if (declined) child.kill();
        else child.stdin.write('y\n');
      } catch (e) {
        child.kill();
        reject(e);
      } finally {
        asking = false;
      }
    };
    child.stdin.on('error', () => {});
    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);
    child.on('error', reject);
    child.on('close', (code) => {
      if (declined) reject(Error('SETUP_CANCELLED'));
      else if (code !== 0) reject(Error('ANDROID_SDK_INSTALL_FAILED'));
      else resolve();
    });
  });
}

export async function ensureAndroid(emulator, confirm, signal, report = () => {}) {
  signal.throwIfAborted();
  if (process.platform !== 'darwin') throw Error('ANDROID_STUDIO_REQUIRED');
  const base = managedAndroid();
  let sdk = process.env.ANDROID_HOME || join(base, 'sdk');
  let bin = await toolsBin(sdk);
  const needsJava = !existsSync(join(process.env.JAVA_HOME || base, 'bin/java'));
  if (needsJava || !bin) {
    if (
      !(await confirm(
        '准备 Android 工具链',
        '工作台将从 Google 或 Eclipse Adoptium 下载本机缺少的 SDK 工具和 Java 运行环境。继续下载 Android SDK 表示同意其许可协议。',
        sdkLicense,
      ))
    )
      throw Error('SETUP_CANCELLED');
    await mkdir(base, { recursive: true });
    const staging = await mkdtemp(join(base, '.install-'));
    try {
      if (needsJava) {
        report('正在下载并校验 Java 运行环境…');
        const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
        const url =
          'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=' +
          arch +
          '&image_type=jdk&os=mac&vendor=eclipse';
        const { stdout } = await exec(
          '/usr/bin/curl',
          ['-fsSL', '--max-time', '30', '--proto-redir', '=https', url],
          { signal },
        );
        const pkg = JSON.parse(stdout)[0]?.binary?.package;
        if (
          !pkg?.link?.startsWith('https://github.com/adoptium/temurin21-binaries/releases/download/') ||
          !/^[a-f0-9]{64}$/.test(pkg.checksum)
        )
          throw Error('ANDROID_SDK_INSTALL_FAILED');
        await download(pkg.link, pkg.checksum, staging, signal);
        const folder = (await readdir(staging)).find((f) =>
          existsSync(join(staging, f, 'Contents/Home/bin/java')),
        );
        if (!folder) throw Error('ANDROID_SDK_INSTALL_FAILED');
        await rename(join(staging, folder), join(base, 'jdk'));
        process.env.JAVA_HOME = join(base, 'jdk/Contents/Home');
      }
      if (!bin) {
        // Put a missing toolchain in an app-owned SDK, even if an existing SDK is read-only.
        sdk = join(base, 'sdk');
        bin = await toolsBin(sdk);
        if (!bin) {
          report('正在下载并校验 Android SDK 工具…');
          const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
          await download(
            'https://dl.google.com/android/repository/commandlinetools-mac_' +
              arch +
              '-15859902_latest.zip',
            macTools[arch],
            staging,
            signal,
          );
          await mkdir(join(sdk, 'cmdline-tools'), { recursive: true });
          await rename(join(staging, 'cmdline-tools'), join(sdk, 'cmdline-tools/latest'));
          bin = join(sdk, 'cmdline-tools/latest/bin');
        }
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  process.env.ANDROID_HOME = sdk;
  const adbDir = join(sdk, 'platform-tools');
  process.env.PATH = [...new Set([adbDir, ...(process.env.PATH || '').split(':')])].join(':');
  const components = [
    ['platform-tools', join(adbDir, 'adb')],
    ['platforms;android-35', join(sdk, 'platforms/android-35/android.jar')],
    ['build-tools;35.0.1', join(sdk, 'build-tools/35.0.1/apksigner')],
  ];
  if (emulator)
    components.push(
      ['emulator', join(sdk, 'emulator/emulator')],
      [emulatorImage(), join(sdk, ...emulatorImage().split(';'), 'package.xml')],
    );
  const missing = components.filter(([, path]) => !existsSync(path));
  if (missing.length) {
    report('正在安装 ' + missing.map(([name]) => name).join('、') + '…');
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]);
    await installPackages(
      join(bin, 'sdkmanager'),
      sdk,
      missing.map(([id]) => id),
      confirm,
      bounded,
    );
    if (missing.some(([, path]) => !existsSync(path))) throw Error('ANDROID_SDK_INSTALL_FAILED');
  }
  return { sdk, bin };
}
