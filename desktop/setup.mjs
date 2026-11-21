import { X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { androidSetupStatus, androidToolchain, applyAndroidToolchain } from './android-sdk.mjs';
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
  const windows = process.platform === 'win32';
  const tools = androidToolchain();
  applyAndroidToolchain(tools);
  const androidSetup = androidSetupStatus(tools);
  const developer =
    process.platform === 'darwin' && first(env.DEVELOPER_DIR, installed('Xcode.app/Contents/Developer'));
  const hdc = first(
    env.HDC_PATH,
    windows &&
      env.ProgramFiles &&
      join(
        env.ProgramFiles,
        'Huawei',
        'DevEco Studio',
        'sdk',
        'default',
        'openharmony',
        'toolchains',
        'hdc.exe',
      ),
    installed('DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc'),
  );
  if (hdc) env.HDC_PATH = hdc;
  if (developer) env.DEVELOPER_DIR = developer;
  const teams = developer ? await signingTeams() : [];
  if (!env.OMU_IOS_TEAM_ID && !env.OMU_IOS_XCCONFIG && teams.length === 1)
    env.OMU_IOS_TEAM_ID = teams[0];
  return {
    teams,
    android: !androidSetup.missing.length,
    androidSetup,
    ios: !!developer,
    harmony: !!hdc,
  };
}
