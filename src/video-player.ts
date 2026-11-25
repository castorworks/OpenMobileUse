import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DOMParser } from '@xmldom/xmldom';
import { screenshotSize } from './inspect.js';
import { bounds } from './native-layout.js';
import { containsPoint, guardObservation, screenAvailable, visibleCenter, type StepDevice, type View } from './steps.js';

function playbackState(label: string) {
  const action = label.trim().replace(/[，,]\s*(?:按钮|button)$/i, '').trim();
  if (/^(?:暂停视频|pause video)$/i.test(action)) return 'playing';
  if (/^(?:播放视频|继续播放(?:视频)?|play video|resume video)$/i.test(action)) return 'paused';
}

export function readVideoDetails(view: View) {
  if (typeof view.layout !== 'string' || !view.controls.some(c => c.labels.some(playbackState))) return;
  const document = new DOMParser().parseFromString(view.layout, 'application/xml');
  const nodes = Array.from(document.getElementsByTagName('*')).flatMap(el => {
    const app = el.getAttribute('package');
    if (!app || el.getAttribute('displayed') === 'false') return [];
    const box = bounds(el.getAttribute('bounds'));
    if (!box || box.width <= 0 || box.height <= 0 || box.x >= view.width || box.y >= view.height ||
      box.x + box.width <= 0 || box.y + box.height <= 0) return [];
    return [{ el, app, box, role: el.getAttribute('class') || '',
      label: el.getAttribute('content-desc') || el.getAttribute('text') || '' }];
  });
  const surfaces = nodes.filter(n => n.app === view.app && /\.(?:SurfaceView|TextureView|VideoView)$/.test(n.role));
  if (surfaces.length !== 1) return;
  const surface = surfaces[0];
  const center = visibleCenter(view, surface.box);
  const hits = nodes.filter(n => containsPoint(n.box, center));
  const toggles = hits.filter(n => n.app === view.app && playbackState(n.label) && n.el.getAttribute('clickable') === 'true' &&
    n.el.getAttribute('enabled') !== 'false');
  if (toggles.length !== 1) return;
  const toggle = toggles[0];
  // Accessibility can still expose the player underneath a sheet in the same Android activity.
  if (hits.some(({ el, app, label, role }) => !el.contains(toggle.el) && el !== surface.el &&
    (app !== view.app || label || /Button|EditText|Dialog/.test(role) ||
      ['clickable', 'long-clickable', 'scrollable', 'focusable'].some(a => el.getAttribute(a) === 'true')))) return;

  let owner = toggle.el.parentElement;
  while (owner && !owner.contains(surface.el)) owner = owner.parentElement;
  if (!owner || owner.getAttribute('package') !== view.app) return;
  const titles = new Set<string>(), authors = new Set<string>();
  for (const { el, app, role, label } of nodes) {
    if (app !== view.app || !owner.contains(el) || !role.endsWith('.TextView') || !label.trim() || el.getAttribute('password') === 'true') continue;
    const id = el.getAttribute('resource-id')?.split('/').at(-1) || '';
    if (/^(?:desc|caption|video_(?:title|caption|description)|media_title)$/.test(id)) titles.add(label.trim());
    if (/^(?:author|user_name|title)$/.test(id) && label.startsWith('@')) authors.add(label.trim());
  }
  if ((!titles.size && !authors.size) || titles.size > 1 || authors.size > 1) return;
  const title = titles.values().next().value;
  const author = authors.values().next().value;
  return { title, author, state: playbackState(toggle.label)!, evidence: toggle.label, center };
}

export function readVideoPlayer(view: View) {
  const details = readVideoDetails(view);
  if (!details?.title) return;
  const key = createHash('sha256').update(JSON.stringify([
    view.app, details.title, ...(details.author ? [details.author] : []),
  ])).digest('hex');
  return { ...details, title: details.title, key };
}

export async function pauseVideoCenter(device: StepDevice, identity: string, view: View, item: string, signal: AbortSignal) {
  signal.throwIfAborted();
  screenAvailable(view);
  if (readVideoPlayer(view)?.key !== item) throw Error('STALE_OBSERVATION');
  const sameWindow = guardObservation(identity, view, { kind: 'check' }, screenAvailable);
  async function observe() {
    const fresh = await device.snapshot();
    signal.throwIfAborted();
    sameWindow(fresh);
    const player = readVideoPlayer(fresh);
    if (!player || player.key !== item) throw Error('STALE_OBSERVATION');
    return { fresh, player };
  }
  // Capture the actual frame, then recheck the work and the centre's hit targets before dispatch.
  screenshotSize(await device.screenshot(), view);
  const { fresh, player } = await observe();
  if (player.state === 'paused') return { tapped: false, evidence: player.evidence };
  const point = { x: player.center.x / (fresh.width - 1), y: player.center.y / (fresh.height - 1) };
  await device.perform({ kind: 'tap', point }, fresh);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const after = (await observe()).player;
      if (after.state === 'paused') return { tapped: true, evidence: after.evidence };
    } catch {
      signal.throwIfAborted();
    }
    if (attempt < 2) await sleep(250, undefined, { signal });
  }
  throw Error('VIDEO_PAUSE_UNCONFIRMED');
}
