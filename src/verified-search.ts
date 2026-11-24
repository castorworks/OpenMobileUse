import { setTimeout as sleep } from 'node:timers/promises';
import { DOMParser, type Element as XmlElement } from '@xmldom/xmldom';
import { bounds } from './native-layout.js';
import { isTransientObservation, reason } from './observation.js';
import {
  executeStep, guardObservation, screenAvailable, uniqueSelector,
  type Control, type StepDevice, type View,
} from './steps.js';

export type SearchRequest = { query: string; firstResult: boolean };
export type SearchEvidence = { query: string; first?: string };
type SearchFailure = { reason: 'SEARCH_NOT_SUBMITTED' | 'SEARCH_RESULTS_UNVERIFIED'; actual?: string };
const openingQuote: Record<string, string> = { '」': '「', '”': '“', '』': '『', '"': '"', "'": "'" };

function asksToSubmit(after: string) {
  return /^[\s，,。；;、]*(?:(?:之?后|然后|再|并且|并|接着|随后)\s*)*(?:点(?:击)?|按(?:下)?|执行|发起|提交)?\s*[「“"]?搜(?:索|一下)(?!框|栏|词|结果)/u.test(after) ||
    /^[\s,;.]*(?:(?:and|then)\s+)*(?:(?:click|press|submit)\s+(?:the\s+)?)?["']?search\b/i.test(after);
}

function negatedEdit(prefix: string) {
  const clause = prefix.split(/[，,。；;！？!?\n]/u).at(-1) ?? '';
  return /不要|不用|禁止|不需要|别(?:把|将|在|去|$)|\b(?:do not|don't|never)\b/i.test(clause);
}

// An ordinary input tool call also identifies the intended field and literal. A failed write
// cannot satisfy a subsequent explicit submit even when the edit verb was not recognized.
export function asksToSubmitQuery(instruction: string, query: string) {
  if (!query) return false;
  for (let at = instruction.indexOf(query); at !== -1; at = instruction.indexOf(query, at + query.length)) {
    if (negatedEdit(instruction.slice(0, at))) continue;
    const after = instruction.slice(at + query.length);
    const opening = openingQuote[after.charAt(0)];
    if (opening && opening !== instruction[at - 1]) continue;
    if (asksToSubmit(opening ? after.slice(1) : after)) return true;
  }
  return false;
}

// Bind an explicit write-then-search request to the literal in the user's instruction, before tool selection.
export function requestedSearch(text: string): SearchRequest | undefined {
  if (!/搜|\bsearch\b/i.test(text)) return;
  const verb = /(?:(?:替换|改|换)[成为]|输入(?:关键词|搜索词)?|\breplace\b[^\n,;]{1,100}?\bwith\s+|\b(?:enter|type)\s+)/gi;
  const queries = new Set<string>();
  for (const match of text.matchAll(verb)) {
    if (negatedEdit(text.slice(0, match.index))) continue;
    const rest = text.slice(match.index! + match[0].length).trimStart();
    const quoted = /^(?:「([^」]+)」|“([^”]+)”|『([^』]+)』|"([^"]+)"|'([^']+)')/u.exec(rest);
    const bare = quoted ? null :
      /^([^，,。；;！？!?\n「“"'」”]+?)(?=\s*(?:[,，。；;]|然后|再(?:点|按|提交|搜)|并(?:点击|搜索)|\s+(?:then|and)\b))/i.exec(rest);
    const literal = (quoted?.slice(1).find(Boolean) ?? bare?.[1])?.trim();
    if (!literal || literal.length > 200) continue;
    // Merely editing a search box does not authorize submitting its contents.
    if (asksToSubmit(rest.slice((quoted ?? bare)![0].length))) queries.add(literal);
  }
  if (queries.size !== 1) return;
  return { query: [...queries][0], firstResult: /(?:第[一1]|首)(?:条|个|项|条搜索|个搜索).{0,8}结果|\bfirst\s+(?:search\s+)?result\b/i.test(text) };
}

function submitButtons(view: View, field: Control) {
  return view.controls.filter(c => c.enabled && !c.secret && !c.editable &&
    c.labels.some(l => /^(?:搜索|search)(?:[，,]\s*(?:按钮|button))?$/i.test(l.trim())) &&
    c.bounds.y < field.bounds.y + field.bounds.height && field.bounds.y < c.bounds.y + c.bounds.height);
}

export function searchField(view: View) {
  const fields = view.controls.filter(c => c.enabled && c.editable && !c.secret);
  const named = fields.filter(c =>
    /search|query|keyword|搜索/i.test([c.id.split('/').at(-1), c.role, ...c.labels.filter(l => l !== c.value)].join(' ')));
  if (named.length) return named.length === 1 ? named[0] : undefined;
  const paired = fields.filter(c => submitButtons(view, c).length === 1);
  if (paired.length === 1) return paired[0];
}

export function searchForm(view: View) {
  const field = searchField(view);
  if (!field) return;
  const buttons = submitButtons(view, field);
  if (buttons.length !== 1) return;
  const input = uniqueSelector(view, field), submit = uniqueSelector(view, buttons[0]);
  if (input && submit) return { field, input, submit };
}

function boxOf(el: XmlElement) {
  if (el.getAttribute('displayed') === 'false' || el.getAttribute('visible') === 'false') return;
  if (el.hasAttribute('bounds')) return bounds(el.getAttribute('bounds'));
  if (el.hasAttribute('width')) return { x: Number(el.getAttribute('x')), y: Number(el.getAttribute('y')),
    width: Number(el.getAttribute('width')), height: Number(el.getAttribute('height')) };
}

// Use the order of result cards, not the order of all labels on the screen.
function resultCards(view: View, field: Control) {
  if (typeof view.layout !== 'string') return;
  const doc = new DOMParser().parseFromString(view.layout, 'application/xml');
  const nativeId = (el: XmlElement) => (el.getAttribute('resource-id') || el.getAttribute('name') || '').split('/').at(-1)!;
  const role = (el: XmlElement) => el.getAttribute('class') || el.getAttribute('type') || '';
  function visibleBox(el: XmlElement) {
    const box = boxOf(el);
    if (!box || box.width <= 0 || box.height <= 0 || box.y >= view.height || box.x >= view.width ||
      box.y + box.height <= 0 || box.x + box.width <= 0) return;
    for (let p: XmlElement | null = el; p; p = p.parentElement)
      if (p.getAttribute('displayed') === 'false' || p.getAttribute('visible') === 'false' ||
        (p.hasAttribute('package') && p.getAttribute('package') !== view.app)) return;
    return box;
  }
  const tabs = new Set(view.controls.filter(c => /Button|Tab/.test(c.role)).flatMap(c => c.labels)
    .filter(l => /^(?:综合|视频|用户|商品|直播|Top|Videos|Users|Shop)$/i.test(l)));
  const elements = Array.from(doc.getElementsByTagName('*'));
  const suggestions = /(?:^|[_-])(?:sug|suggest(?:ions?)?|autocomplete|history)(?:$|[_-])/i;
  if (elements.some(el => suggestions.test(nativeId(el)) && visibleBox(el))) return;
  const lists = elements.filter(el => {
    if (!/(?:RecyclerView|ListView|GridView|CollectionView|Table)$/.test(role(el))) return false;
    const box = visibleBox(el);
    if (!box || box.y < field.bounds.y + field.bounds.height) return false;
    return /results?(?:[_-]?(?:list|container|recycler))?$|results?[_-]?view/i.test(nativeId(el)) ||
      (tabs.size >= 2 && box.height > view.height / 4);
  });
  const outer = lists.filter(list => !lists.some(other => other !== list && other.contains(list)));
  if (outer.length !== 1) return;
  const list = outer[0], listBox = boxOf(list)!;
  const rows = Array.from(list.childNodes).filter((el): el is XmlElement => el.nodeType === 1)
    .flatMap(el => {
      const box = visibleBox(el);
      return box && box.y + box.height > listBox.y && box.y < listBox.y + listBox.height ? [{ el, box }] : [];
    }).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const titles = rows.slice(0, 2).map(row => {
    for (const el of [row.el, ...Array.from(row.el.getElementsByTagName('*'))]) {
      // A live card names the room on its cover; the audience count and the embedded product can change.
      const room = /^(.+?的直播间)[，,]\s*(?:正在直播|直播中)(?:[，,]|$)/u.exec(el.getAttribute('content-desc') || '');
      if (room) {
        const cover = visibleBox(el);
        if (cover && cover.width >= row.box.width / 2 && cover.y < row.box.y + row.box.height / 2) return room[1];
      }
      if (!/(?:TextView|StaticText)$/.test(role(el)) || !/^(?:desc|(?:result_|item_|media_|video_)?title|caption)$/i.test(nativeId(el)) ||
        !visibleBox(el)) continue;
      const text = (el.getAttribute('text') || el.getAttribute('label') || '').trim();
      if (text) return text;
    }
    return '';
  });
  if (titles[0]) return { first: titles[0], next: titles[1] };
}

export function firstSearchResult(view: View, field: Control) {
  return resultCards(view, field)?.first;
}

export function searchFailureMessage(request: SearchRequest, failure: SearchFailure) {
  const field = failure.actual === undefined ? '当前无法读回搜索框。' : '搜索框实际显示「' + failure.actual + '」。';
  return failure.reason === 'SEARCH_NOT_SUBMITTED'
    ? field + '尚未确认用「' + request.query + '」提交搜索。'
    : field + '已提交「' + request.query + '」搜索，但尚未确认' + (request.firstResult ? '本次的第一条结果。' : '结果页的搜索词。');
}

export function searchReport(evidence: SearchEvidence) {
  return '实际搜索词为「' + evidence.query + '」。' +
    (evidence.first ? '第一条结果为「' + evidence.first + '」。' : '已提交搜索。');
}

export async function executeVerifiedSearch(device: StepDevice, identity: string, initial: View,
  request: SearchRequest, signal: AbortSignal): Promise<SearchEvidence | SearchFailure> {
  const { query, firstResult } = request;
  let view = initial, actual: string | undefined;
  const original = searchField(initial);
  const alreadyMatched = original?.value === query;
  const previousLists: { first: string; next?: string }[] = [];
  function sameForm(fresh: View) {
    if (fresh.app !== initial.app || !original) return;
    const form = searchForm(fresh);
    if (form && form.field.role === original.role && form.field.id === original.id &&
      (original.id || fresh.window === initial.window)) return form;
  }
  const current = async () => {
    signal.throwIfAborted();
    const fresh = await device.snapshot();
    signal.throwIfAborted();
    screenAvailable(fresh);
    return fresh;
  };
  let submitted = false;
  for (let attempt = 0; attempt < 2 && !submitted; attempt++) {
    screenAvailable(view);
    const form = sameForm(view);
    if (!form) break;
    actual = form.field.value;
    try {
      if (actual !== query) {
        const previous = firstResult && resultCards(view, form.field);
        if (previous) previousLists.push(previous);
        const input = { kind: 'input' as const, selector: form.input, text: query, replace: true };
        await executeStep(device, identity, input, guardObservation(identity, view, input, screenAvailable), signal);
      }
      view = await current();
      const ready = sameForm(view);
      actual = ready ? ready.field.value : undefined;
      if (!ready || actual !== query) continue;
      const tap = { kind: 'tap' as const, selector: ready.submit };
      await executeStep(device, identity, tap, guardObservation(identity, view, tap, fresh => {
        screenAvailable(fresh);
        const latest = sameForm(fresh);
        actual = latest?.field.value;
        if (!latest || actual !== query) throw Error('SEARCH_QUERY_CHANGED');
        const previous = firstResult && resultCards(fresh, latest.field);
        if (previous) previousLists.push(previous);
      }), signal);
      submitted = true;
    } catch (error) {
      if (!['INPUT_NOT_VERIFIED', 'SEARCH_QUERY_CHANGED', 'STALE_OBSERVATION'].includes((error as Error).message)) throw error;
      view = await current();
      actual = view.app === initial.app ? searchForm(view)?.field.value : undefined;
    }
  }
  if (!submitted) return { reason: 'SEARCH_NOT_SUBMITTED', actual };

  let lastList: ReturnType<typeof resultCards>, sawReload = false;
  for (let read = 0; read < 5; read++) {
    try {
      view = await current();
      const field = view.app === initial.app ? searchField(view) : undefined;
      actual = field?.value;
      const list = firstResult && field && actual === query ? resultCards(view, field) : undefined;
      if (actual === query && !list) sawReload = true;
      if (actual === query && !firstResult) return { query: actual };
      if (list && lastList?.first === list.first && lastList.next === list.next) {
        const changed = previousLists.every(old => old.first !== list.first ||
          (old.next && list.next && old.next !== list.next));
        if (changed || (alreadyMatched && sawReload)) return { query: actual!, first: list.first };
      }
      lastList = list;
    } catch (error) {
      signal.throwIfAborted();
      actual = undefined;
      lastList = undefined;
      // Only the result read is retried after the submit receipt, including on replay.
      if (!isTransientObservation(reason(error))) break;
    }
    if (read < 4) await sleep(300, undefined, { signal });
  }
  return { reason: 'SEARCH_RESULTS_UNVERIFIED', actual };
}
