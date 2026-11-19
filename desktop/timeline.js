'use strict';

function replyContent(text) {
  const body = document.createDocumentFragment();
  let block;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      block = undefined;
      continue;
    }
    const bullet = /^\s*(?:([-*•])|\d+[.)])\s+(.+)$/.exec(line);
    const tag = bullet ? (bullet[1] ? 'ul' : 'ol') : 'p';
    if (block?.localName !== tag) {
      block = document.createElement(tag);
      body.append(block);
    }
    const dest = bullet ? document.createElement('li') : block;
    if (bullet) block.append(dest);
    else if (block.childNodes.length) block.append(document.createElement('br'));
    // Model and device strings stay text, including anything that resembles HTML.
    for (const part of (bullet?.[2] || line).split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
        dest.append(element('strong', part.slice(2, -2)));
      else if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
        dest.append(element('code', part.slice(1, -1)));
      else dest.append(part);
    }
  }
  return body;
}

function turnDuration(started, ended) {
  if (!started || !ended) return '';
  const elapsed = Date.parse(ended) - Date.parse(started);
  if (!Number.isFinite(elapsed) || elapsed < 0) return '';
  if (elapsed < 1000) return '不到 1 秒';
  const seconds = Math.round(elapsed / 1000);
  return seconds >= 60 ? Math.floor(seconds / 60) + ' 分 ' + (seconds % 60) + ' 秒' : seconds + ' 秒';
}

function updateTurn(row, turn, hasFollowingTurn) {
  if (!row.firstChild) {
    const details = element('details', undefined, 'turn-process');
    const summary = element('summary');
    summary.append(element('span'), element('span', undefined, 'collapsed-activity'));
    details.append(
      summary,
      element('ol', undefined, 'turn-events'),
      element('div', undefined, 'turn-activity'),
    );
    row.append(
      element('p', turn.user, 'user-message'),
      details,
      element('div', undefined, 'turn-state'),
      element('div', undefined, 'assistant-message'),
    );
  }
  const [user, details, stateLabel, answer] = row.children;
  if (user.textContent !== turn.user) user.textContent = turn.user;
  const [summary, list, activity] = details.children;
  const running = turn.status === 'running';
  const events = turn.events || [];
  const stateText =
    {
      running: '执行中',
      succeeded: '已完成',
      cancelled: '已停止',
      interrupted: '已中断',
      failed: '执行失败',
      needs_review: turn.replyRequested ? (hasFollowingTurn ? '已回复' : '等待你回复') : '待核实',
    }[turn.status] || '';
  const phase = turn.activity ? nice(turn.activity) : events.length ? '' : '正在连接设备';
  if (row.dataset.status !== turn.status) details.open = running;
  row.dataset.status = turn.status;
  details.hidden = !running && !events.length;
  const meta = [
    running ? '执行中' : '执行过程',
    events.length ? events.length + ' 条记录' : '',
    turnDuration(turn.started, turn.ended),
  ]
    .filter(Boolean)
    .join(' · ');
  if (summary.firstChild.textContent !== meta) summary.firstChild.textContent = meta;
  const brief = running && phase ? ' · ' + phase : '';
  if (summary.lastChild.textContent !== brief) summary.lastChild.textContent = brief;
  activity.hidden = !running || !phase;
  if (running && activity.textContent !== phase) activity.textContent = phase;
  if (list.children.length > events.length) list.replaceChildren();
  for (let i = list.children.length; i < events.length; i++) {
    const event = events[i];
    const li = element('li');
    const ok = ['dispatched', 'succeeded', 'observed'].includes(event.status);
    li.className = ok ? 'event-ok' : 'event-review';
    li.append(
      element('span', nice(event.name)),
      element('small', nice(event.status)),
      element('time', clock(event.at)),
    );
    list.append(li);
  }
  if (stateLabel.textContent !== stateText) stateLabel.textContent = stateText;
  stateLabel.hidden =
    running ||
    (turn.status === 'succeeded' && !!turn.assistant) ||
    (turn.replyRequested && hasFollowingTurn);
  const text =
    turn.assistant ||
    (running
      ? ''
      : turn.reason
        ? describe(turn.reason)
        : turn.status === 'interrupted'
          ? '上次运行在保存结果前中断了。'
          : '');
  const warning = turn.historyError ? describe(turn.historyError) : '';
  if (answer.renderedText !== text || answer.renderedWarning !== warning) {
    answer.replaceChildren(replyContent(text));
    if (warning) answer.append(element('p', warning, 'hint'));
    answer.renderedText = text;
    answer.renderedWarning = warning;
  }
  answer.hidden = !text && !warning;
}
