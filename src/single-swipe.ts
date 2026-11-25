import { setTimeout as sleep } from 'node:timers/promises';
import { isTransientObservation, reason } from './observation.js';
import { recordStep, type RecordedStep } from './recording.js';
import { screenAvailable, uniqueSelector, type Control, type StepDevice, type View } from './steps.js';
import { readVideoDetails } from './video-player.js';

// Only a request made by the user can allocate a one-swipe limit. Reading a
// caption on screen, a model note, or an earlier turn must not allocate one.
export function singleSwipeRequest(instruction: string) {
  const command = instruction.normalize('NFKC').trim()
    .replace(/^(?:「([^」]+)」|“([^”]+)”|"([^"]+)")$/u, '$1$2$3');
  const text = command.replace(/「[^」]*」|“[^”]*”|"[^"]*"|『[^』]*』|'[^']*'/gu, ' ')
    .replace(/(?:只|仅)(?:做|执行|进行|允许)?\s*[一1]次\s*((?:(?:向|往|朝)?上)?(?:滑动?|划动?))/gu, '只$1一次');
  const gesture = /(?:(只(?:需|能|要|准|允许)?|仅(?:限|允许)?|最多)\s*)?((?:向|往|朝)?上\s*)?(?:滑动?|划动?|滚动)\s*(?:屏幕|画面)?\s*[一1]\s*[次下遍]|\b((?:swipe|scroll)\s+up(?:wards?)?)\s+(?:(?:only|exactly|just)\s+)?(?:once|one time)\b/gi;
  const matches = [...text.matchAll(gesture)].filter(m => m[1] || m[2] || m[3]);
  if (matches.length !== 1) return;
  const m = matches[0], prefix = text.slice(0, m.index), tail = text.slice(m.index! + m[0].length);
  if (/(?:不要|别|禁止|不用|每(?:条|次|个)(?:作品|视频)?(?:都)?)\s*$|\b(?:do not|don't|never)(?:\s+(?:only|just))?\s*$/i.test(prefix) ||
      /为什么|为何|什么叫|解释|\b(?:explain|why)\b/i.test(prefix.split(/[.,;!?，。；！？\n]/u).at(-1) ?? '') ||
      /\bfor (?:each|every)\b/i.test(tail) ||
      /^\s*(?:或|到|至|or\b|to\b)\s*(?:[两二三\d]|tw[oi])/i.test(tail)) return;
  if (!/^(?:只|仅|最多)/.test(m[0]) && /(?:再|接着|继续)\s*(?:向上|上)滑(?:动)?\s*(?:[两二三四五多\d]|若干)次/.test(tail)) return;
  const remainder = prefix + ' ' + tail;
  const compare = /换片|换了|换到|换没换|换视频|切换|下一条|同一|作品|新视频|原视频|视频.{0,5}[换变]|作者|标题|\b(?:videos?|items?|titles?|captions?|authors?|creators?|clip|changed)\b/i.test(remainder);
  const needsChange = /(?:必须|务必).{0,8}(?:换|切)|(?:切换到|换到|切到|进入)下一(?:条|个)|停在新(?:作品|视频)|\b(?:must (?:change|switch)|go to the next)\b/i.test(remainder) &&
    !/是否|有没有|如果|若|仍是|还是同一|\b(?:whether|if)\b/i.test(remainder);
  // Promote a text-only ending only when all the remaining words describe the
  // swipe or its readback. Unrecognised instructions keep the normal task flow.
  const extra = remainder
    .replace(/上滑|滑动|换片|换到|切换|切到|进入|下一(?:条内容)?|停止|停下来?|继续|重复/g, '')
    .replace(/读出|读取|看看|查看|判断|报告|汇报|告诉我|回答|说明|结果|确认|核实|核对|对比|比较|根据|如实|记下|成功|真的|就好|就行/g, '')
    .replace(/播放页|当前|视频|作品|标题|作者|名字|名称|画面|屏幕|页面|抖音/g, '')
    .replace(/是否|是不是|有没有|同一|相同|不同|还是|仍然|仍是|如果|已经|现在|否则|不要|不用|不再|别再|必须|务必|帮我|给我|然后|并且|最多/g, '')
    .replace(/[请再并和或用以的是有没未已就若还仍原新在从到前后只仅限一条个了看读停换片滑下]/g, '')
    .replace(/\b(?:please|just|only|exactly|and|then|the|a|an|on|in|of|to|at|from|up|before|after|both|its|current|previous|next|new|same|different|video|item|work|clip|title|caption|author|creator|titles|captions|authors|or|read|tell|me|check|verify|confirm|report|whether|if|it|has|is|changed|changes|switch|switched|still|stop|do|not|again|swipe)\b/gi, '')
    .replace(/[\s\p{P}]/gu, '');
  return { anyDirection: !m[2] && !m[3], english: !/\p{Script=Han}/u.test(text), compare, needsChange, reportOnly: !extra,
    followingAction: /(?:再|然后|随后|接着|并|and|then)\s*(?:点|打开|搜索|输入|返回|点赞|关注|收藏|播放|tap\b|open\b|search\b|type\b)/i.test(tail) };
}

type Request = NonNullable<ReturnType<typeof singleSwipeRequest>>;
type Item = { title?: string; author?: string };
export type SwipeStart = { app: string; window: string; windowIdentity?: string; item: Item };

function itemFields(view: View) {
  const details = readVideoDetails(view);
  // A sheet in the real player can expose background labels in its tree.
  if (!details && typeof view.layout === 'string' && view.app === 'com.ss.android.ugc.aweme') return {};
  const field = (ids: RegExp, observed?: string) => {
    if (details && !observed) return;
    const hits = view.controls.filter(c => !c.secret && !c.editable && c.enabled &&
      ids.test(c.id.split('/').at(-1) ?? '') && /Text/i.test(c.role) &&
      c.labels[0]?.trim() && !/^\d+:[\d:/\s.]+$/.test(c.labels[0].trim()) && (!observed || c.labels[0].trim() === observed));
    return hits.length === 1 ? hits[0] : undefined;
  };
  return {
    title: field(/^(?:caption|desc|video_(?:caption|title|description)|media_title)$/, details?.title),
    author: field(details ? /^(?:author|user_name|title)$/ : /^(?:author|user_name)$/, details?.author),
  };
}

function values(fields: { title?: Control; author?: Control }): Item {
  return { title: fields.title?.labels[0].trim(), author: fields.author?.labels[0].trim() };
}

export function swipeStart(view: View, compare: boolean): SwipeStart {
  const item = compare ? values(itemFields(view)) : {};
  if (compare && !item.title && !item.author) throw Error('SWIPE_BASELINE_UNAVAILABLE');
  return { app: view.app, window: view.window, windowIdentity: view.windowIdentity, item };
}

export function visibleSwipeItem(view: View, start: SwipeStart) {
  if (view.app !== start.app || view.window !== start.window || view.windowIdentity !== start.windowIdentity) return;
  screenAvailable(view);
  return describe(values(itemFields(view)));
}

function comparison(a: Item, b: Item) {
  if ((a.title && b.title && a.title !== b.title) || (a.author && b.author && a.author !== b.author)) return 'changed';
  if (a.title && a.title === b.title && a.author === b.author) return 'same';
}

function describe(item: Item) {
  return [item.author, item.title && '《' + item.title + '》'].filter(Boolean).join(' ');
}

export function unverifiedSwipe(request: Request) {
  return { status: 'needs_review', reason: 'SWIPE_RESULT_UNCONFIRMED',
    answer: request.english ? 'One swipe was acknowledged. The visible title and author could not confirm the result.'
      : (request.anyDirection ? '已滑动一次' : '已上滑一次') + '，未读到足以核对前后作品的稳定信息，换片结果待核对。' };
}

export async function verifySingleSwipe(device: StepDevice, start: SwipeStart, request: Request,
  first: View, signal: AbortSignal) {
  const checks: RecordedStep[] = [];
  const gesture = request.anyDirection ? '已滑动一次' : '已上滑一次';
  if (!request.compare) return { view: first, checks, result: { status: 'succeeded',
    answer: request.english ? 'The phone acknowledged one swipe.' : gesture + '，已收到手机回执。' } };
  let previous: Item | undefined;
  for (let i = 0; i < 4; i++) {
    if (i) await sleep(220, undefined, { signal });
    try {
      const view = i ? await device.snapshot() : first;
      signal.throwIfAborted();
      if (view.app !== start.app || view.window !== start.window || view.windowIdentity !== start.windowIdentity) break;
      screenAvailable(view);
      const fields = itemFields(view), item = values(fields);
      const outcome = comparison(start.item, item);
      const stable = previous && item.title === previous.title && item.author === previous.author;
      previous = item;
      // Give an outgoing card time to leave, even if the first two reads still show it.
      if (!outcome || !stable || (outcome === 'same' && i !== 3)) continue;
      for (const node of [fields.title, fields.author]) {
        if (!node) continue;
        const selector = uniqueSelector(view, node);
        if (selector) checks.push(recordStep(view, { action: 'check', ...selector }, node));
      }
      const answer = request.english
        ? 'Swiped once. ' + (outcome === 'changed' ? 'The item changed.' : 'The visible item information stayed the same.') +
          ' Before the swipe I read ' + describe(start.item) + '. After the swipe I read ' + describe(item) + '.'
        : gesture + (outcome === 'changed' ? '，已换片。' : '，前后读到的作品信息相同。') +
          '上滑前为' + describe(start.item) + '，上滑后为' + describe(item) + '。';
      return { view, checks, changed: outcome === 'changed', result: outcome === 'same' && request.needsChange
        ? { status: 'needs_review', reason: 'SWIPE_ITEM_UNCHANGED', answer }
        : { status: 'succeeded', answer } };
    } catch (error) {
      signal.throwIfAborted();
      previous = undefined;
      if (!isTransientObservation(reason(error))) break;
    }
  }
  return { view: first, checks, result: unverifiedSwipe(request) };
}
