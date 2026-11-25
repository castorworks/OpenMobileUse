import { setTimeout as sleep } from 'node:timers/promises';
import { bounds } from './native-layout.js';
import {
  containsPoint, pointInView, screenAvailable, visibleCenter,
  type Bounds, type Control, type Point, type Step, type View,
} from './steps.js';
import { readVideoPlayer } from './video-player.js';

const douyin = 'com.ss.android.ugc.aweme';
const heading = /^(?:[\d.,万千亿]+\s*条评论|评论\s*[\d.,万千亿]+|全部评论|热门评论)$/;
const dismiss = /^(?:关闭|关闭评论区|收起评论)(?:[，,]\s*按钮)?$/;
const entry = /^评论[\s\d.０-９万千亿wWkK,，+、]*按钮$/;
const labelled = (c: Control, re: RegExp) => !c.secret && c.labels.some(l => re.test(l.trim()));

export type CommentVideo = { window: string; key: string };
export function commentVideo(view: View, previous?: CommentVideo): CommentVideo | undefined {
  if (view.app !== douyin) return;
  if (view.controls.some(c => labelled(c, heading)))
    return previous?.window === view.window ? previous : undefined;
  if (!view.controls.some(c => c.enabled && labelled(c, entry))) return;
  const player = readVideoPlayer(view);
  if (player) return { window: view.window, key: player.key };
}

export function commentCloseTarget(view: View, step: Step, node?: Control) {
  if (view.app !== douyin || step.kind !== 'tap') return;
  const point = 'point' in step ? pointInView(view, step.point) : undefined;
  const close = view.controls.filter(c => c.enabled && c.clickable !== false && labelled(c, dismiss) &&
    (point ? containsPoint(c.bounds, point) : c === node));
  if (!close.length) return;
  const titles = view.controls.filter(c => labelled(c, heading));
  const matches = close.filter(c => {
    const center = visibleCenter(view, c.bounds);
    return titles.some(({ bounds: b }) => center.x >= b.x + b.width &&
      center.y >= b.y && center.y < b.y + b.height);
  });
  if (matches.length > 1) throw Error('AMBIGUOUS_ELEMENT');
  return matches[0];
}

// Read the active display's OS insets. Coordinates in other displays or rotations
// cannot be used with this accessibility tree.
export function commentTapPoint(view: View, button: Bounds, dump: string) {
  const display = dump.split(/^\s*Display:\s*mDisplayId=/m).slice(1).find(s => /^0\b/.test(s));
  const geometry = display?.match(/DisplayFrames\s+w=(\d+)\s+h=(\d+)\s+r=(\d+)/);
  if (!display || !geometry || +geometry[1] !== view.width || +geometry[2] !== view.height ||
      +geometry[3] * 90 !== view.rotation) throw Error('COMMENT_CLOSE_POINT_UNAVAILABLE');
  const sources = display.split(/\r?\n/).filter(l => /^\s*InsetsSource\b/.test(l) &&
    /\btype=(?:systemGestures|mandatorySystemGestures|ITYPE_(?:LEFT|RIGHT|TOP|BOTTOM)(?:_MANDATORY)?_GESTURES)\b/i.test(l));
  if (!sources.length) throw Error('COMMENT_CLOSE_POINT_UNAVAILABLE');
  const blocked: Bounds[] = [];
  for (const source of sources) {
    if (/\bvisible=false\b/.test(source)) continue;
    const box = bounds(source.match(/\bframe=(\[-?\d+,-?\d+\]\[-?\d+,-?\d+\])/)?.[1]);
    if (!box || box.width < 0 || box.height < 0) throw Error('COMMENT_CLOSE_POINT_UNAVAILABLE');
    if (box.width && box.height) blocked.push(box);
  }
  const center = visibleCenter(view, button);
  if (!blocked.some(b => containsPoint(b, center))) return center;
  const left = Math.max(0, button.x), right = Math.min(view.width, button.x + button.width);
  const top = Math.max(0, button.y), bottom = Math.min(view.height, button.y + button.height);
  // Gesture sources are rectangles. Their edges divide the visible button into
  // cells that are either completely available or completely reserved.
  const cuts = (a: number, b: number, edges: number[]) =>
    [...new Set([a, ...edges.filter(v => v > a && v < b), b])].sort((x, y) => x - y);
  const xs = cuts(left, right, blocked.flatMap(b => [b.x, b.x + b.width]));
  const ys = cuts(top, bottom, blocked.flatMap(b => [b.y, b.y + b.height]));
  let largest = 0;
  let point;
  for (let i = 1; i < xs.length; i++) {
    for (let j = 1; j < ys.length; j++) {
      const area = (xs[i] - xs[i - 1]) * (ys[j] - ys[j - 1]);
      const candidate = {
        x: Math.floor((xs[i - 1] + xs[i]) / 2),
        y: Math.floor((ys[j - 1] + ys[j]) / 2),
      };
      if (area > largest && !blocked.some(b => containsPoint(b, candidate))) {
        point = candidate;
        largest = area;
      }
    }
  }
  if (!point) throw Error('COMMENT_CLOSE_POINT_UNAVAILABLE');
  return point;
}

export class CommentCloseUnverified extends Error {
  constructor(stillOpen: boolean, readonly view?: View) {
    super(stillOpen ? 'COMMENT_PANEL_STILL_OPEN' : 'COMMENT_CLOSE_UNCONFIRMED');
  }
}

export type CommentCloseProof = {
  commentPanelClosed: true; tapPoint: Point; view: View; close: Control; original?: CommentVideo;
};

export function commentCloseState(view: View, before: View, close: Control, original?: CommentVideo) {
  if (view.app !== before.app || view.window !== before.window) return 'unknown';
  if (view.controls.some(c => labelled(c, heading) ||
    (c.id === close.id && c.role === close.role && labelled(c, dismiss)))) return 'open';
  if (!original || commentVideo(view)?.key !== original.key) return 'unknown';
  try {
    screenAvailable(view);
    return 'closed';
  } catch {
    return 'unknown';
  }
}

export async function verifyCommentClose(read: () => Promise<View>, before: View, close: Control,
  original: CommentVideo | undefined, signal?: AbortSignal) {
  let last: View | undefined, stillOpen = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(200, undefined, { signal });
    signal?.throwIfAborted();
    last = undefined;
    stillOpen = false;
    try {
      last = await read();
      signal?.throwIfAborted();
      if (last.app !== before.app || last.window !== before.window) break;
      const state = commentCloseState(last, before, close, original);
      if (state === 'closed') return last;
      stillOpen = state === 'open';
    } catch {
      signal?.throwIfAborted();
    }
  }
  throw new CommentCloseUnverified(stillOpen, last);
}
