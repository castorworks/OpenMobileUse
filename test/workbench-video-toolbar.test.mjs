import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { runConversation } from '../dist/conversation.js';
import { harmonyView } from '../dist/native-layout.js';
import { compileRecording, replayRecording } from '../dist/recording.js';

const width = 240;
const height = 480;
const bounds = '[0,0][240,480]';
const searchCenter = { x: 200, y: 32 };
const normalized = (x, y) => ({ x: x / (width - 1), y: y / (height - 1) });
const toPixels = ({ x, y }) => ({ x: Math.round(x * (width - 1)), y: Math.round(y * (height - 1)) });

function videoFrame(background, sceneX) {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="480">
    <rect width="240" height="480" fill="${background}"/>
    <circle cx="${sceneX}" cy="180" r="53" fill="#e4a47b"/>
    <g transform="translate(200 32)" fill="none" stroke="#fafafa" stroke-width="1.3">
      <circle cx="-1" cy="-1" r="4"/><path d="M2 2 l4 4"/>
    </g>
  </svg>`)).png().toBuffer();
}

function phone(frames, searchFrame, playing) {
  let searchOpen = false, query = '', clock = 0, captures = 0;
  const taps = [];
  return {
    taps,
    snapshot() {
      const controls = searchOpen
        ? [{ type: 'SearchField', id: 'query', bounds: '[10,15][226,50]', text: query }]
        : [
            { type: 'Text', bounds, text: '播放时间 ' + (playing ? ++clock : 0), clickable: 'false' },
            { type: 'Image', bounds: '[188,20][212,44]', clickable: 'true' },
          ];
      return harmonyView({
        attributes: { bundleName: 'example.channels', bounds, focused: 'true', hostWindowId: '1' },
        children: controls.map(attributes => ({ attributes })),
      }, 0);
    },
    screenshot() {
      if (searchOpen) return searchFrame;
      return frames[playing ? captures++ % frames.length : 0];
    },
    perform(step) {
      if (step.kind === 'tap') {
        const point = toPixels(step.point);
        taps.push(point);
        searchOpen = point.x >= 188 && point.x < 212 && point.y >= 20 && point.y < 44;
      } else {
        assert.equal(step.kind, 'input');
        assert.ok(searchOpen);
        query = step.text;
      }
    },
  };
}

test('video search centers an imprecise visual tap on the anonymous toolbar icon and replays the search', async () => {
  const [frame1, frame2, searchFrame] = await Promise.all([
    videoFrame('#293246', 65), videoFrame('#53413e', 125),
    sharp({ create: { width, height, channels: 3, background: 'white' } }).png().toBuffer(),
  ]);
  const live = phone([frame1, frame2], searchFrame, true);
  const identity = 'harmony:toolbar';
  const signal = new AbortController().signal;
  const records = [], actions = [];
  let centers;
  const decide = async (messages, tools, _deadline, count) => {
    count();
    const current = messages.findLast(m => m.role === 'user' && typeof m.content === 'string');
    const obs = JSON.parse(current.content);
    const field = obs.controls.find(c => c.id === 'query');
    let name, args = {};
    if (field?.value === 'deepseek') {
      name = 'finish';
      args = { evidence: field.ref, message: '搜索框中已输入 deepseek。' };
    } else if (field) {
      name = 'input_text';
      args = { target: field.ref, text: 'deepseek' };
    } else if (tools.some(tool => tool.function.name === 'tap_visual') && !actions.includes('tap_visual')) {
      name = 'tap_visual';
      centers = obs.visualIconCenters;
      // The model identified the search button but pointed at the blank corner of its hit area.
      args = { label: '放大镜', ...normalized(189, 21) };
    } else if (!actions.length) {
      name = 'inspect_screen';
    } else {
      name = 'ask_user';
      args = { message: '请手动打开视频号搜索框。' };
    }
    actions.push(name);
    assert.ok(actions.length <= 6);
    return { role: 'assistant', content: null, tool_calls: [{
      id: obs.observationId, type: 'function',
      function: { name, arguments: JSON.stringify({ observationId: obs.observationId, ...args }) },
    }] };
  };
  const result = await runConversation(
    live, identity, 'harmony', [{ user: '打开视频号搜索框并输入 deepseek。' }], decide,
    signal, async step => records.push(step), () => {}, () => true, undefined, true,
  );
  assert.equal(result.status, 'succeeded', result.reason || result.answer);
  assert.ok(!actions.includes('ask_user'));
  assert.deepEqual(live.taps, [searchCenter]);
  assert.deepEqual(centers?.map(toPixels), [searchCenter]);
  assert.deepEqual(records.map(s => s.command.action), ['tapImage', 'input', 'check']);
  const script = JSON.parse(JSON.stringify({ schemaVersion: 2, platform: 'harmony', steps: records }));
  const playback = await compileRecording(script, 'harmony');
  const paused = phone([frame2], searchFrame, false);
  const replay = await replayRecording(paused, identity, playback, signal, () => {});
  assert.equal(replay.status, 'succeeded');
  assert.deepEqual(paused.taps, [searchCenter]);
});
