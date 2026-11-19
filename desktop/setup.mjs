import { X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { managedAndroid } from './android-sdk.mjs';
const exec = promisify(execFile);
const first = (...paths) => paths.find((p) => p && existsSync(p));
const appDirs = ['/Applications', join(homedir(), 'Applications')];
function installed(relative) {
  return first(...appDirs.map((p) => join(p, relative)));
}

async function signingTeams() {
  try {
    const [identities, certificates] = await Promise.all([
      exec('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { timeout: 4000 }),
      exec('/usr/bin/security', ['find-certificate', '-a', '-c', 'Apple Development', '-p'], {
        timeout: 4000,
      }),
    ]);
    const teams = new Set();
    for (const pem of certificates.stdout.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) || []) {
      const cert = new X509Certificate(pem);
      if (!identities.stdout.includes(cert.fingerprint.replaceAll(':', ''))) continue;
      const team = /^OU=([A-Z0-9]{10})$/m.exec(cert.subject)?.[1];
      if (team) teams.add(team);
    }
    return [...teams];
  } catch {
    return [];
  }
}
export async function configureHost() {
  const env = process.env;
  const localSdk = join(managedAndroid(), 'sdk');
  const sdk = first(
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    existsSync(join(localSdk, 'cmdline-tools/latest/bin/sdkmanager')) && localSdk,
    join(homedir(), 'Library/Android/sdk'),
  );
  const java = first(
    env.JAVA_HOME,
    installed('Android Studio.app/Contents/jbr/Contents/Home'),
    join(managedAndroid(), 'jdk/Contents/Home'),
  );
  const developer = first(env.DEVELOPER_DIR, installed('Xcode.app/Contents/Developer'));
  const hdc = first(
    env.HDC_PATH,
    installed('DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc'),
  );
  if (sdk) {
    env.ANDROID_HOME = sdk;
    env.PATH = [...new Set([join(sdk, 'platform-tools'), ...(env.PATH || '').split(':')])].join(':');
  }
  if (java) env.JAVA_HOME = java;
  if (hdc) env.HDC_PATH = hdc;
  if (developer) env.DEVELOPER_DIR = developer;
  const teams = developer ? await signingTeams() : [];
  if (!env.OMU_IOS_TEAM_ID && !env.OMU_IOS_XCCONFIG && teams.length === 1)
    env.OMU_IOS_TEAM_ID = teams[0];
  return {
    teams,
    android: !!(java && first(env.ADB_PATH, sdk && join(sdk, 'platform-tools/adb'))),
    ios: !!developer,
    harmony: !!hdc,
  };
}
