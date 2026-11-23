import { adbPath, hdc, agentToolchain, type Target } from './host.js';
import { Harmony } from './harmony.js';
import { WebDriver } from './webdriver.js';
import { pending, withDevice, type Dispatch } from './session.js';
import { observationId } from './steps.js';

export function openDevice(
  target: Target,
  dispatch: Dispatch,
  mode: 'foreground' | 'settings' = 'foreground',
  newCommandTimeoutSeconds?: number,
  waitForIdleTimeoutMs?: number,
) {
  return target.platform === 'harmony'
    ? new Harmony(target.id, dispatch)
    : WebDriver.open(target.platform, target.id, dispatch, mode, newCommandTimeoutSeconds, waitForIdleTimeoutMs);
}
export function diagnose(error: unknown) {
  const msg = String((error as Error)?.message || '');
  if (/^APPIUM_[A-Z_]+$/.test(msg)) return msg;
  if (/DEVICE_BUSY/.test(msg)) return 'DEVICE_BUSY';
  if (/port #?\d+ is occupied|EADDRINUSE|address already in use/i.test(msg)) return 'PORT_IN_USE';
  if (/unknown device or simulator UDID|device not found|device is not connected/i.test(msg))
    return 'DEVICE_UNAVAILABLE';
  if (/unauthorized|not authorized|untrusted|not trusted|not paired|pairing/i.test(msg))
    return 'AUTHORIZATION_REQUIRED';
  if (/\blocked\b|passcode|\bunlock/i.test(msg)) return 'DEVICE_LOCKED';
  if (/provision|signing|certificate|development team|code.?sign/i.test(msg))
    return 'WDA_SIGNING_FAILED';
  if (/xcodebuild|WebDriverAgent/i.test(msg)) return 'WDA_SESSION_FAILED';
  if (/fetch failed|ECONNREFUSED/i.test(msg)) return 'APPIUM_UNREACHABLE';
  if (/ENOENT/.test(msg)) return 'TOOL_NOT_FOUND';
  return 'PROBE_FAILED';
}
const suggestions: Record<string, string> = {
  PORT_IN_USE: 'Choose a free local forwarding port. For iOS set OMU_WDA_PORT.',
  DEVICE_BUSY: 'Wait for the current command to finish on this device.',
  DEVICE_OFFLINE: 'Reconnect the device and check its USB debugging connection.',
  DEVICE_UNAVAILABLE: 'Check the USB cable and confirm the target appears in devices.',
  DEVICE_LOCKED: 'Unlock the phone and keep it connected.',
  AUTHORIZATION_REQUIRED: 'Unlock the device and confirm debugging authorization or trust.',
  WDA_SIGNING_FAILED: 'Check the WDA signing team, provisioning profile and device trust.',
  WDA_SESSION_FAILED: 'Check Developer Mode and the Xcode WebDriverAgent build log.',
  APPIUM_UNREACHABLE: 'Start the Appium service at the configured loopback URL.',
  TOOL_NOT_FOUND: 'Install the platform tool or correct its configured path.',
};
export function connectionError(target?: Target) {
  if (/unauth/i.test(target?.state ?? '')) return 'AUTHORIZATION_REQUIRED';
  if (target?.state === 'offline') return 'DEVICE_OFFLINE';
  return target?.issue ? diagnose(new Error(target.issue)) : 'DEVICE_UNAVAILABLE';
}
export async function doctor(target: Target, runId: string, prepareAppium?: () => Promise<void>) {
  const report = {
    platform: target.platform,
    model: target.model,
    connection: target.connection,
    state: target.state,
    discovered: target.state !== undefined || target.available,
    connected: target.available,
    controllable: false,
    unconfirmed: pending(target),
    bridge: target.platform === 'android' ? adbPath() : target.platform === 'harmony' ? hdc : 'xcrun',
    probes: [] as {
      stage: string;
      ok: boolean;
      error?: string;
      detail?: string;
      next?: string;
      durationMs: number;
    }[],
    toolchain: undefined as Awaited<ReturnType<typeof agentToolchain>> | undefined,
    current: undefined as { app: string; page: string; observationId: string } | undefined,
  };
  let stage = 'connection',
    start = performance.now();
  const record = (ok: boolean, error?: string, detail?: string) => {
    report.probes.push({
      stage,
      ok,
      error,
      detail,
      next: error ? suggestions[error] : undefined,
      durationMs: Math.round(performance.now() - start),
    });
    start = performance.now();
  };
  if (!target.available) {
    record(false, connectionError(target), target.issue);
    return report;
  }
  record(true);
  try {
    stage = 'toolchain';
    report.toolchain = await agentToolchain(target);
    record(true);
    stage = 'session';
    await withDevice(target, runId, async (dispatch) => {
      if (target.platform !== 'harmony' && prepareAppium) {
        stage = 'appium';
        await prepareAppium();
        record(true);
        stage = 'session';
      }
      const device = await openDevice(target, dispatch);
      record(true);
      try {
        stage = 'observation';
        const v = await device.snapshot();
        report.current = {
          app: v.app,
          page: v.screen.page,
          observationId: observationId(target.platform + ':' + target.id, v),
        };
        record(true);
      } finally {
        const original = stage;
        stage = 'cleanup';
        await device.close();
        stage = original;
      }
      report.controllable = true;
    });
  } catch (e) {
    record(
      false,
      diagnose(e),
      String((e as Error).message)
        .split('\n')[0]
        .replaceAll(target.id, '<device>')
        .slice(0, 320),
    );
  }
  return report;
}
