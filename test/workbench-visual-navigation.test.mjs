import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { runConversation } from '../dist/conversation.js';
import { compileScript, executeRound } from '../dist/run.js';

const width = 216, height = 480;
const buttonX = 185, firstY = 110, secondY = 235;
const titles = ['Search models', 'Using DeepSeek'];

function frame(body) {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="white"/>
    <g font-family="sans-serif" font-size="14" fill="#242424">${body}</g>
  </svg>`)).png().toBuffer();
}

async function phone(channelsFirst) {
  const channelsY = channelsFirst ? firstY : secondY;
  const rows = [firstY, secondY].map(y =>
    `<text x="12" y="${y + 5}">${y === channelsY ? 'Channels' : 'Mini Programs'}</text>
     <text x="${buttonX}" y="${y + 5}" text-anchor="middle">More ›</text>`);
  const frames = await Promise.all([
    frame(rows.join('')),
    ...titles.map(title => frame(`<text x="12" y="60">${title}</text>`)),
  ]);
  const actions = [];
  let page = 0;
  return {
    actions,
    snapshot: async () => ({
      app: 'example.search', window: 'main', width, height, rotation: 0, screen: {},
      controls: page ? [{
        id: 'item' + page, labels: [titles[page - 1]], role: 'Text', enabled: true,
        bounds: { x: 12, y: 42, width: 150, height: 24 },
      }] : [],
    }),
    screenshot: async () => frames[page],
    async perform(step) {
      if (page === 0) {
        assert.equal(step.kind, 'tap');
        const x = step.point.x * (width - 1);
        const y = step.point.y * (height - 1);
        assert.ok(
          Math.abs(x - buttonX) <= 12 && Math.abs(y - channelsY) <= 6,
          `Unexpected tap at ${x}, ${y}`,
        );
        actions.push('Channels');
      } else {
        assert.equal(page, 1);
        assert.equal(step.kind, 'swipe');
        actions.push('swipe');
      }
      page++;
    },
    foregroundApp() {}, observe() {}, close() {}, move() {}, launch() {}, back() {},
  };
}

test('chat opens the correct More button and its recording follows the section when rows move', async () => {
  const live = await phone(false);
  const decide = async (messages, _tools, _deadline, count) => {
    count();
    const current = messages.findLast(m => m.role === 'user' && typeof m.content === 'string');
    const { observationId, controls, savedNotes, lastBlocker } = JSON.parse(current.content);
    let name, args;
    if (lastBlocker) {
      name = 'ask_user';
      args = { message: 'Cannot open the Channels section: ' + lastBlocker.outcome };
    } else if (!controls.length) {
      name = 'tap_visual';
      args = { x: buttonX / (width - 1), y: secondY / (height - 1), label: 'More in Channels' };
    } else if (controls[0].id === 'item1') {
      name = 'swipe';
      args = { direction: 'up', note: controls[0].label };
    } else {
      name = 'finish';
      args = { evidence: controls[0].ref, message: [...savedNotes, controls[0].label].join(', ') };
    }
    return { role: 'assistant', content: null, tool_calls: [{
      id: observationId, type: 'function', function: {
        name, arguments: JSON.stringify({ observationId, ...args }),
      },
    }] };
  };
  const signal = new AbortController().signal;
  const steps = [];
  const run = await runConversation(
    live, 'harmony:original', 'harmony', [{ user: 'Summarize the first two Channels results.' }],
    decide, signal, async (step) => steps.push(step), () => {}, () => true, undefined, true,
  );
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  assert.deepEqual(live.actions, ['Channels', 'swipe']);
  assert.equal(run.answer, titles.join(', '));
  assert.ok(!run.replyRequested);

  const target = await phone(true);
  const script = await compileScript(JSON.parse(JSON.stringify({ platform: 'harmony', steps })), 'harmony');
  const playback = await executeRound(target, 'harmony:reordered', { script }, signal);
  assert.equal(playback.status, 'succeeded', JSON.stringify(playback));
  assert.deepEqual(playback.steps.map((step) => step.action), ['tapImage', 'swipe', 'check']);
  assert.deepEqual(target.actions, ['Channels', 'swipe']);
});
