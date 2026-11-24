import assert from 'node:assert/strict';
import test from 'node:test';
import { Harmony } from '../dist/harmony.js';
import { readObservation } from '../dist/observation.js';
import { WebDriver } from '../dist/webdriver.js';

test('Harmony discards truncated and incomplete layouts before exposing a fresh tree', async () => {
  const phone = new Harmony('phone', () => assert.fail('unexpected action'));
  const complete = {
    attributes: { bounds: '[0,0][100,200]' },
    children: [{ attributes: { bundleName: 'example.app', focused: 'true' } }],
  };
  const layouts = ['{"attributes":', '{"attributes":{},"children":[{}]}', JSON.stringify(complete)];
  phone.shell = async (command, ...args) => {
    if (command === 'uitest') return args.at(-1);
    if (command === 'cat') return layouts.shift();
    if (command === 'rm') return '';
    if (command === 'hidumper') return 'ScreenRotation: 0';
    assert.fail('unexpected command ' + command);
  };
  assert.equal((await readObservation(() => phone.snapshot())).app, 'example.app');
  assert.equal(layouts.length, 0);
});

async function appium(t, reply) {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/session')) return Response.json({ value: { sessionId: 'test' } });
    const command = path.endsWith('/execute/sync') ? JSON.parse(options.body).script : path.split('/test')[1];
    const value = reply(command);
    if (value instanceof Response) return value;
    return Response.json({ value }, { status: value?.error ? 500 : 200 });
  });
  return WebDriver.open('android', 'phone', async (_kind, action) => action(), 'foreground');
}

test('Appium refreshes the native view after a truncated source and read timeouts', async (t) => {
  const replies = [
    new DOMException('expired', 'TimeoutError'),
    { error: 'timeout' },
    '<hierarchy><node',
    '<hierarchy />',
  ];
  const phone = await appium(t, (command) => {
    if (command === 'mobile: getCurrentPackage') return 'example.app';
    if (command === '/rotation') return { z: 0 };
    if (command === '/window/rect') return { width: 100, height: 200 };
    if (command === 'mobile: getCurrentActivity') return '.Main';
    assert.equal(command, '/source');
    const value = replies.shift();
    if (value instanceof Error) throw value;
    return value;
  });
  const view = await readObservation(() => phone.snapshot(), undefined, [0, 0, 0]);
  assert.equal(view.layout, '<hierarchy />');
  assert.equal(replies.length, 0);
});

test('Appium retries unavailable and empty screenshots but propagates invalid sessions', async (t) => {
  const replies = [{ error: 'unable to capture screen' }, null, 'dGVzdA==', { error: 'invalid session id' }];
  const phone = await appium(t, (command) => {
    assert.equal(command, '/screenshot');
    return replies.shift();
  });
  const frame = await readObservation(() => phone.screenshot(), undefined, [0, 0]);
  assert.equal(frame.toString(), 'test');
  await assert.rejects(readObservation(() => phone.screenshot()), { message: 'Appium: invalid session id' });
  assert.equal(replies.length, 0);
});

test('Appium retries incomplete HTTP 200 replies and stops on a non-JSON authentication response', async (t) => {
  const replies = [
    new Response('{"value":'), Response.json({}), 'example.app',
    new Response('Unauthorized', { status: 401 }),
  ];
  const phone = await appium(t, (command) => {
    assert.equal(command, 'mobile: getCurrentPackage');
    assert.ok(replies.length);
    return replies.shift();
  });
  assert.equal(await readObservation(() => phone.foregroundApp(), undefined, [0, 0]), 'example.app');
  await assert.rejects(readObservation(() => phone.foregroundApp()), { message: 'Appium: 401' });
  assert.equal(replies.length, 0);
});

test('Appium can read the next view after null rotation and window dimensions', async (t) => {
  const angles = [null, { z: 0 }, { z: 0 }, { z: 0 }];
  const sizes = [null, { width: 100, height: 200 }];
  const phone = await appium(t, (command) => {
    if (command === 'mobile: getCurrentPackage') return 'example.app';
    if (command === '/rotation') return angles.shift();
    if (command === '/window/rect') return sizes.shift();
    if (command === '/source') return '<hierarchy />';
    assert.equal(command, 'mobile: getCurrentActivity');
    return '.Main';
  });
  assert.equal((await readObservation(() => phone.snapshot(), undefined, [0, 0])).height, 200);
  assert.deepEqual(angles, []);
  assert.deepEqual(sizes, []);
});

test('a malformed HTTP 200 after a back gesture stays outside observation recovery', async (t) => {
  let calls = 0;
  const phone = await appium(t, (command) => {
    assert.equal(command, '/back');
    calls++;
    return new Response('{"value":');
  });
  await assert.rejects(phone.back(), { message: 'Appium: incomplete response' });
  assert.equal(calls, 1);
});

test('a timed-out Appium action does not become a retryable observation', async (t) => {
  let calls = 0;
  const phone = await appium(t, (command) => {
    assert.equal(command, '/back');
    calls++;
    return { error: 'timeout' };
  });
  await assert.rejects(phone.back(), { message: 'Appium: timeout' });
  assert.equal(calls, 1);
});
