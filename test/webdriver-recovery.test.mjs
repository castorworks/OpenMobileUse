import assert from 'node:assert/strict';
import test from 'node:test';
import { WebDriver } from '../dist/webdriver.js';

const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
const app = 'example.editor';
const protocolError = (error) => ({ error, message: 'Remote response' });

async function device(t, platform, responds) {
  const ios = platform === 'ios';
  const control = {
    id: 'query',
    role: ios ? 'XCUIElementTypeTextField' : 'android.widget.EditText',
    labels: ['Query'],
    bounds: { x: 1, y: 2, width: 20, height: 10 },
    focused: true,
    enabled: true,
    editable: true,
    secret: false,
    value: '',
  };
  const view = { app, window: ios ? app : 'main', controls: [control] };
  const dispatches = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname.replace(/^.*\/session\/test/, '');
    const data = options.body && JSON.parse(options.body);
    const command = data?.script ?? path;
    let value = responds(command, data);
    if (value === undefined) {
      if (path.endsWith('/session')) value = { sessionId: 'test' };
      else if (path === '/elements') value = [{ [elementKey]: 'handle' }];
      else if (command === 'mobile: activeAppInfo') value = { bundleId: app };
      else if (command === 'mobile: getCurrentPackage') value = app;
      else if (path.endsWith('/placeholderValue')) value = null;
      else if (path.endsWith('/showing-hint')) value = 'false';
      else assert.fail('Unexpected Appium command ' + command);
    }
    return Response.json({ value }, { status: value?.error ? 404 : 200 });
  });
  const phone = await WebDriver.open(
    platform,
    'device',
    async (kind, act) => {
      dispatches.push(kind);
      await act();
    },
    'foreground',
  );
  const input = () =>
    phone.perform({ kind: 'input', selector: { id: 'query' }, text: 'X', replace: true }, view, control);
  return { phone, control, view, input, dispatches };
}

test('element lookup and value reads recognize WebDriver target loss before dispatch', async (t) => {
  let response = 'stale element reference';
  const d = await device(t, 'ios', (command) => {
    if (command === '/elements' && response === 'stale element reference') return protocolError(response);
    if (command.endsWith('/attribute/value')) return protocolError(response);
  });
  await assert.rejects(d.input(), { message: 'STALE_OBSERVATION' });
  response = 'no such element';
  await assert.rejects(d.input(), { message: 'STALE_OBSERVATION' });
  response = 'invalid session id';
  await assert.rejects(d.input(), { message: 'Appium: Remote response' });
  assert.deepEqual(d.dispatches, []);
});

test('foreground reads distinguish missing windows from invalid sessions', async (t) => {
  let response = protocolError('no such window');
  const d = await device(t, 'android', (command) => {
    if (command === 'mobile: getCurrentPackage') return response;
  });
  await assert.rejects(d.phone.snapshot(), { message: 'FOREGROUND_APP_UNAVAILABLE' });
  response = '';
  await assert.rejects(d.phone.snapshot(), { message: 'FOREGROUND_APP_UNAVAILABLE' });
  response = protocolError('invalid session id');
  await assert.rejects(d.phone.snapshot(), { message: 'Appium: Remote response' });
});

test('Android rechecks autofill after the confirmed focus tap', async (t) => {
  let text = '';
  const d = await device(t, 'android', (command) => {
    if (command.endsWith('/attribute/text')) return text;
    if (command.endsWith('/click')) {
      text = 'autofilled';
      return null;
    }
  });
  d.control.focused = false;
  await assert.rejects(d.input(), { message: 'STALE_OBSERVATION' });
  assert.deepEqual(d.dispatches, ['tap']);
});

for (const platform of ['android', 'ios']) {
  test(platform + ' can verify an input on a refreshed tree without sending it twice', async (t) => {
    const writes = [];
    const d = await device(t, platform, (command) => {
      if (/\/attribute\/(value|text)$/.test(command))
        return writes.length ? protocolError('stale element reference') : '';
      if (command === 'mobile: replaceElementValue' || /\/(clear|value)$/.test(command)) {
        writes.push(command);
        return null;
      }
    });
    let refreshed = 0;
    d.phone.snapshot = async () => {
      refreshed++;
      if (refreshed === 1) throw Error('STALE_OBSERVATION');
      return { ...d.view, controls: [{ ...d.control, value: 'X' }] };
    };
    await d.input();
    assert.equal(refreshed, 2);
    assert.deepEqual(d.dispatches, ['input']);
    assert.deepEqual(
      writes,
      platform === 'ios' ? ['/element/handle/clear', '/element/handle/value'] : ['mobile: replaceElementValue'],
    );
  });
}

test('a lost reference after writing cannot verify a matching field in a different window', async (t) => {
  let writes = 0;
  const d = await device(t, 'android', (command) => {
    if (command.endsWith('/attribute/text')) return writes ? protocolError('no such element') : '';
    if (command === 'mobile: replaceElementValue') {
      writes++;
      return null;
    }
  });
  d.phone.snapshot = async () => ({
    ...d.view,
    window: 'other',
    controls: [{ ...d.control, value: 'X' }],
  });
  await assert.rejects(d.input(), { message: 'INPUT_NOT_VERIFIED' });
  assert.equal(writes, 1);
});

test('a stale reply to the iOS clear command stays inside the input dispatch', async (t) => {
  const d = await device(t, 'ios', (command) => {
    if (command.endsWith('/attribute/value')) return '';
    if (command.endsWith('/clear')) return protocolError('stale element reference');
  });
  await assert.rejects(d.input(), { message: 'TEXT_DRIVER_ERROR' });
  assert.deepEqual(d.dispatches, ['input']);
});
