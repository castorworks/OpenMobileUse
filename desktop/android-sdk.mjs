import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { readAndroidSettings } from '../dist/host.js';
import { stateRoot, writeJSON } from './library.mjs';

const exec = promisify(execFile);
const windows = process.platform === 'win32';
const mac = process.platform === 'darwin';
const sdkLicense = 'https://developer.android.com/studio/terms';
// SHA-256 values published by Google for command-line tools revision 15859902.
const sdkTools = {
  win: '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a',
  mac_arm64: '835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e',
  mac_x86_64: 'c5a6378ab5cf7e0d5701921405115befff13e9ff7417fb588389338f8bd050f3',
};
const sdkToolsRevision = '15859902';
const androidSettings = 'tools.json';
const curl = windows ? 'curl.exe' : '/usr/bin/curl';
const tar = windows ? 'tar.exe' : '/usr/bin/tar';
const executable = (name) => name + (windows ? '.exe' : '');
const javaBin = (home, name = 'java') => join(home, 'bin', executable(name));
const adbBin = (sdk) => join(sdk, 'platform-tools', executable('adb'));
const jdkHome = (root) => (windows ? root : join(root, 'Contents', 'Home'));
export const managedAndroid = () => join(stateRoot(), 'android');
export const emulatorImage = () =>
  'system-images;android-35;google_apis;' + (process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64');

function entries(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function sdkRoot(path) {
  return (
    !!path &&
    ['platform-tools', 'cmdline-tools', 'build-tools', 'platforms'].some((name) =>
      existsSync(join(path, name)),
    )
  );
}

function missingComponents(sdk, emulator = false) {
  const platforms = join(sdk, 'platforms');
  const buildTools = join(sdk, 'build-tools');
  const components = [
    ['platform-tools', existsSync(adbBin(sdk))],
    [
      'platforms;android-35',
      emulator
        ? existsSync(join(platforms, 'android-35', 'android.jar'))
        : entries(platforms).some((name) => existsSync(join(platforms, name, 'android.jar'))),
    ],
    [
      'build-tools;35.0.1',
      entries(buildTools).some((name) => {
        const dir = join(buildTools, name);
        return existsSync(join(dir, executable('aapt'))) && existsSync(join(dir, 'lib', 'apksigner.jar'));
      }),
    ],
  ];
  if (emulator)
    components.push(
      ['emulator', existsSync(join(sdk, 'emulator', 'emulator'))],
      [emulatorImage(), existsSync(join(sdk, ...emulatorImage().split(';'), 'package.xml'))],
    );
  return components.filter(([, present]) => !present).map(([name]) => name);
}

function hasJdk(home) {
  return !!home && (!mac || home !== '/usr') &&
    existsSync(javaBin(home)) && existsSync(javaBin(home, 'jarsigner'));
}

function installedJava(base, fromPath) {
  const env = process.env;
  const hostHomes = windows
    ? [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).flatMap((dir) => {
        const studio = join(dir, 'Android', 'Android Studio', 'jbr');
        const vendors = ['Java', 'Eclipse Adoptium', 'Microsoft'];
        return [
          studio,
          ...vendors.flatMap((vendor) => {
            const parent = join(dir, vendor);
            return entries(parent).map((name) => join(parent, name));
          }),
        ];
      })
    : [
        ...[join(homedir(), 'Applications'), '/Applications'].map((dir) =>
          jdkHome(join(dir, 'Android Studio.app', 'Contents', 'jbr')),
        ),
        ...['/Library/Java/JavaVirtualMachines', join(homedir(), 'Library', 'Java', 'JavaVirtualMachines')]
          .flatMap((dir) => entries(dir).map((name) => jdkHome(join(dir, name)))),
      ];
  return [env.JAVA_HOME, fromPath, ...hostHomes, jdkHome(join(base, 'jdk'))].find(hasJdk);
}

function pathExecutable(name) {
  return (process.env.PATH || '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir.replace(/^"(.*)"$/, '$1'), executable(name)))
    .find(existsSync);
}

export function androidToolchain() {
  const env = process.env;
  const base = managedAndroid();
  const settings = readAndroidSettings(base);
  const preferred = typeof settings.sdk === 'string' && sdkRoot(settings.sdk) ? settings.sdk : undefined;
  const adb = env.ADB_PATH || pathExecutable('adb');
  const adbDir = adb && dirname(adb);
  const candidates = [
    preferred,
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    adbDir && basename(adbDir).toLowerCase() === 'platform-tools' && dirname(adbDir),
    windows && env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Android', 'Sdk'),
    mac && join(homedir(), 'Library', 'Android', 'sdk'),
    join(base, 'sdk'),
  ].filter(sdkRoot);
  const sdk = preferred ||
    candidates.find((path) => !missingComponents(path).length) ||
    candidates[0] || join(base, 'sdk');
  const java = pathExecutable('java');
  let javaHome;
  if (java) {
    try {
      javaHome = dirname(dirname(realpathSync(java)));
    } catch {
      javaHome = dirname(dirname(java));
    }
  }
  const installedJdk = installedJava(base, javaHome);
  const managedJdk = jdkHome(join(base, 'jdk'));
  const compatibleJdk =
    installedJdk && installedJdk === settings.incompatibleJava && hasJdk(managedJdk)
      ? managedJdk
      : installedJdk;
  return { sdk, java: compatibleJdk, missing: missingComponents(sdk) };
}

export function androidSetupStatus(toolchain = androidToolchain()) {
  const missing = [];
  if (toolchain.missing.includes('platform-tools')) missing.push('ADB');
  if (toolchain.missing.some((part) => part !== 'platform-tools')) missing.push('Android SDK 组件');
  if (!toolchain.java) missing.push('Java');
  return { supported: windows || mac, missing };
}

export function applyAndroidToolchain({ sdk, java }, env = process.env) {
  if (sdkRoot(sdk)) {
    env.ANDROID_HOME = sdk;
    env.ANDROID_SDK_ROOT = sdk;
    const adbDir = join(sdk, 'platform-tools');
    const pathKey = Object.keys(env).find((key) => windows && key.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = [...new Set([adbDir, ...(env[pathKey] || '').split(delimiter)])].join(delimiter);
  }
  if (java) env.JAVA_HOME = java;
}

export async function chooseAndroidSdk(sdk) {
  if (!sdkRoot(sdk)) throw Error('ANDROID_SDK_FOLDER_INVALID');
  const base = managedAndroid();
  await writeJSON(base, androidSettings, { ...readAndroidSettings(base), sdk });
  const tools = androidToolchain();
  applyAndroidToolchain(tools);
  return androidSetupStatus(tools);
}

async function fetchArchive(url, archive, signal) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]);
  let source = new URL(url);
  for (let hop = 0; hop <= 5; hop++) {
    if (source.protocol !== 'https:') throw Error('Android downloads require HTTPS');
    const response = await fetch(source, { signal: bounded, redirect: 'manual' });
    if (response.status === 200 && response.body) {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(archive), { signal: bounded });
      return;
    }
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (response.status < 300 || response.status >= 400 || !location)
      throw Error('Android download returned HTTP ' + response.status);
    source = new URL(location, source);
  }
  throw Error('Too many Android download redirects');
}

async function transferArchive(url, archive, signal) {
  const env = process.env;
  const proxy = env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY;
  // curl honors the user's proxy configuration and also uses the host's TLS store.
  if (!proxy || (env.no_proxy || env.NO_PROXY)?.trim() === '*') {
    try {
      await fetchArchive(url, archive, signal);
      return;
    } catch {
      signal.throwIfAborted();
    }
  }
  await exec(
    curl,
    [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--retry',
      '2',
      '--connect-timeout',
      '20',
      '--max-time',
      '1800',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      '--output',
      archive,
      url,
    ],
    { signal, windowsHide: true },
  );
}

async function download(url, checksum, staging, signal, report) {
  const archive = join(staging, 'download');
  let downloading = true;
  const timer = setInterval(async () => {
    const size = (await stat(archive).catch(() => null))?.size;
    if (downloading && size) report('已下载 ' + Math.floor(size / (1024 * 1024)) + ' MiB…');
  }, 1000);
  try {
    await transferArchive(url, archive, signal);
  } catch (error) {
    signal.throwIfAborted();
    console.error('Android tool download:', error.stderr || error.message);
    throw Error('ANDROID_DOWNLOAD_FAILED');
  } finally {
    downloading = false;
    clearInterval(timer);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== checksum) throw Error('ANDROID_DOWNLOAD_CHECKSUM');
  await exec(tar, ['-xf', archive, '-C', staging], { signal, windowsHide: true });
}

function toolsBin(sdk, emulator) {
  const dir = join(sdk, 'cmdline-tools');
  return ['latest', ...entries(dir).sort().reverse()]
    .map((v) => join(dir, v))
    .find((home) => {
      if (windows) return existsSync(join(home, 'lib', 'sdkmanager-classpath.jar'));
      return existsSync(join(home, 'bin', 'sdkmanager')) &&
        (!emulator || existsSync(join(home, 'bin', 'avdmanager')));
    });
}

function installPackages(tools, sdk, java, packages, confirm, signal, report) {
  // The Windows launcher is a batch file. Use its Java entry point with native arguments.
  const manager = windows ? javaBin(java) : join(tools, 'bin', 'sdkmanager');
  const args = windows
    ? [
        '-Dcom.android.sdklib.toolsdir=' + tools,
        '-classpath',
        join(tools, 'lib', 'sdkmanager-classpath.jar'),
        'com.android.sdklib.tool.sdkmanager.SdkManagerCli',
      ]
    : [];
  return new Promise((resolve, reject) => {
    const child = spawn(manager, [...args, '--sdk_root=' + sdk, ...packages], {
      env: { ...process.env, JAVA_HOME: java, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
      signal,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let percent,
      output = '',
      asking = false,
      declined = false;
    const handleOutput = async (chunk) => {
      const text = chunk.toString();
      output = (output + text).slice(-120000);
      if (asking) return;
      if (!/Accept\?\s*\(y\/N\)\s*:\s*$/i.test(output)) {
        const progress = [...text.matchAll(/(\d{1,3})%\s/g)].at(-1)?.[1];
        if (progress && progress !== percent) {
          percent = progress;
          report('正在安装 Android SDK 组件 · ' + percent + '%');
        }
        return;
      }
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
      else if (code !== 0) {
        console.error('Android sdkmanager:', output.trim().slice(-4000));
        reject(Error(/UnsupportedClassVersionError|Java (?:version )?\d+ or higher is required/i.test(output)
          ? 'ANDROID_JAVA_INCOMPATIBLE'
          : 'ANDROID_SDK_INSTALL_FAILED'));
      } else resolve();
    });
  });
}

async function installJava(base, signal, report) {
  const target = join(base, 'jdk');
  const home = jdkHome(target);
  if (hasJdk(home)) return home;
  report('正在准备 Java 运行环境…');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(base, '.install-'));
  try {
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
    // Microsoft's JDK 21 release aliases publish the corresponding SHA-256 alongside each archive.
    const release = windows ? 'windows-' + arch + '.zip' : 'macOS-' + arch + '.tar.gz';
    const url = 'https://aka.ms/download-jdk/microsoft-jdk-21-' + release;
    const { stdout } = await exec(
      curl,
      ['-fsSL', '--max-time', '30', '--proto-redir', '=https', url + '.sha256sum.txt'],
      { signal, windowsHide: true },
    ).catch((error) => {
      signal.throwIfAborted();
      console.error('Java package metadata:', error.stderr || error.message);
      throw Error('ANDROID_DOWNLOAD_FAILED');
    });
    const checksum = /^([a-f0-9]{64})(?:\s|$)/i.exec(stdout.trim())?.[1].toLowerCase();
    if (!checksum) throw Error('ANDROID_DOWNLOAD_CHECKSUM');
    await download(url, checksum, staging, signal, (progress) => report('Java · ' + progress));
    const folder = (await readdir(staging)).find((name) => hasJdk(jdkHome(join(staging, name))));
    if (!folder) throw Error('ANDROID_SDK_INSTALL_FAILED');
    if (!hasJdk(home)) {
      if (existsSync(target)) await rename(target, join(staging, 'previous-jdk'));
      await rename(join(staging, folder), target);
    }
    return home;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function installTools(base, sdk, emulator, signal, report) {
  report('正在下载 Android SDK 命令行工具…');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(base, '.install-'));
  try {
    const host = windows ? 'win' : process.arch === 'arm64' ? 'mac_arm64' : 'mac_x86_64';
    await download(
      'https://dl.google.com/android/repository/commandlinetools-' + host + '-' +
        sdkToolsRevision + '_latest.zip',
      sdkTools[host],
      staging,
      signal,
      (progress) => report('Android SDK · ' + progress),
    );
    const commandLineDir = join(sdk, 'cmdline-tools');
    await mkdir(commandLineDir, { recursive: true });
    const target = join(commandLineDir, 'latest');
    if (!toolsBin(sdk, emulator)) {
      if (existsSync(target)) await rename(target, join(staging, 'previous-sdk-tools'));
      await rename(join(staging, 'cmdline-tools'), target);
    }
    const tools = toolsBin(sdk, emulator);
    if (!tools) throw Error('ANDROID_SDK_INSTALL_FAILED');
    return tools;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function ensureAndroid(emulator, confirm, signal, report = () => {}) {
  signal.throwIfAborted();
  if (!mac && (emulator || !windows)) throw Error('ANDROID_STUDIO_REQUIRED');
  const base = managedAndroid();
  const managedSdk = join(base, 'sdk');
  let { sdk, java } = androidToolchain();
  const detectedSdk = sdk;
  let incompatibleJava;
  let missing = missingComponents(sdk, emulator);
  if (missing.length && sdk !== managedSdk) {
    const probe = await mkdtemp(join(sdk, '.omu-write-')).catch((error) => {
      if (['EACCES', 'EPERM', 'EROFS', 'ENOENT'].includes(error.code)) return null;
      throw error;
    });
    if (probe) await rmdir(probe);
    else {
      sdk = managedSdk;
      missing = missingComponents(sdk, emulator);
    }
  }
  let tools = toolsBin(sdk, emulator) || toolsBin(detectedSdk, emulator) || toolsBin(managedSdk, emulator);
  if (
    (missing.length || emulator) &&
    !tools &&
    !(await confirm(
      '准备 Android 工具链',
      '工作台将下载缺少的 SDK 命令行工具。请查看并同意 Android SDK 许可协议。',
      sdkLicense,
    ))
  ) throw Error('SETUP_CANCELLED');
  signal.throwIfAborted();
  java ??= await installJava(base, signal, report);
  if ((missing.length || emulator) && !tools)
    tools = await installTools(base, managedSdk, emulator, signal, report);
  if (missing.length) {
    report('正在安装 ' + missing.join('、') + '…');
    await mkdir(sdk, { recursive: true });
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]);
    try {
      await installPackages(tools, sdk, java, missing, confirm, bounded, report);
    } catch (error) {
      const managedJava = jdkHome(join(base, 'jdk'));
      if (error.message !== 'ANDROID_JAVA_INCOMPATIBLE' || java === managedJava) throw error;
      incompatibleJava = java;
      java = await installJava(base, bounded, report);
      missing = missingComponents(sdk, emulator);
      if (missing.length) await installPackages(tools, sdk, java, missing, confirm, bounded, report);
    }
    if (missingComponents(sdk, emulator).length) throw Error('ANDROID_SDK_INSTALL_FAILED');
  }
  await Promise.all([
    exec(adbBin(sdk), ['version'], { signal, timeout: 6000, windowsHide: true }),
    exec(javaBin(java), ['-version'], { signal, timeout: 6000, windowsHide: true }),
  ]).catch((error) => {
    signal.throwIfAborted();
    console.error('Android tool validation:', error.message);
    throw Error('ANDROID_SDK_INSTALL_FAILED');
  });
  if (sdk !== detectedSdk || incompatibleJava)
    await writeJSON(base, androidSettings, {
      ...readAndroidSettings(base),
      ...(sdk !== detectedSdk ? { sdk } : {}),
      ...(incompatibleJava ? { incompatibleJava } : {}),
    });
  applyAndroidToolchain({ sdk, java });
  return { sdk, bin: tools && join(tools, 'bin') };
}
