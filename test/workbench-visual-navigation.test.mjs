import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { Workbench } from '../desktop/workbench.mjs';

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

test('chat opens the correct More button and its recording follows the section when rows move', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omu-sections-'));
  const previous = process.env.OMU_STATE_DIR;
  process.env.OMU_STATE_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.OMU_STATE_DIR;
    else process.env.OMU_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const devices = { original: await phone(false), reordered: await phone(true) };
  const workbench = new Workbench(() => {}, {
    bridge: { openDevice: async (target) => devices[target.id] },
    preferences: { useImages: true, clientConfig: () => ({ baseURL: 'http://localhost', model: 'test' }) },
  });
  for (const id of Object.keys(devices)) {
    workbench.targets.set('harmony:' + id, { id, platform: 'harmony', available: true });
  }
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { messages } = JSON.parse(options.body);
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
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', tool_calls: [{ id: observationId, type: 'function', function: {
        name, arguments: JSON.stringify({ observationId, ...args }),
      } }],
    } }] });
  });

  const original = 'harmony:original', reordered = 'harmony:reordered';
  await workbench.start(original, 'chat', { message: 'Summarize the first two Channels results.' });
  await workbench.operations.get(original);
  const { history: [run] } = await workbench.history(original);
  assert.equal(run.status, 'succeeded', JSON.stringify(run.result));
  assert.deepEqual(devices.original.actions, ['Channels', 'swipe']);
  const chat = await workbench.conversation(original, run.chatId);
  assert.equal(chat.turns.length, 1);
  assert.equal(chat.turns[0].assistant, titles.join(', '));
  assert.ok(!chat.turns[0].replyRequested);

  await workbench.start(reordered, 'script', chat.recordingId);
  await workbench.operations.get(reordered);
  const { history: [playback] } = await workbench.history(reordered);
  assert.equal(playback.status, 'succeeded', JSON.stringify(playback.result));
  assert.deepEqual(playback.events.map(e => e.name), ['tapImage', 'swipe', 'check']);
  assert.deepEqual(devices.reordered.actions, ['Channels', 'swipe']);
});
