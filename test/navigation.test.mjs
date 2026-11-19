import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { roundTrip, parseScript } from '../dist/navigation.js';
import { classifyHarmony } from '../dist/harmony.js';
import { classifyXml } from '../dist/webdriver.js';

const sample = JSON.parse(
  await readFile(new URL('../examples/settings-bluetooth.json', import.meta.url)),
);
function fixture(initial, reads = () => initial) {
  let page = 'home',
    visits = 0;
  return {
    async observe() {
      return {
        page,
        marker: page + '-test-marker',
        bluetooth: page === 'bluetooth' ? reads(visits) : undefined,
      };
    },
    async move(action) {
      if (action === 'forward') {
        visits++;
        page = 'bluetooth';
      } else page = 'home';
    },
  };
}
test('off remains a valid reading, and ordered checks belong to the execution phase', async () => {
  const result = await roundTrip(fixture(false), parseScript(sample));
  assert.equal(result.initial, false);
  assert.equal(result.final, false);
  assert.deepEqual(
    result.evidence.filter((e) => e.phase === 'execution').map((e) => e.page),
    ['home', 'bluetooth', 'home'],
  );
});
test('a preflight visit cannot pass a script that never enters Bluetooth', async () => {
  const script = { schemaVersion: 1, steps: [sample.steps[0], sample.steps[1]] };
  await assert.rejects(roundTrip(fixture(true), parseScript(script)), /MISSING_EXECUTION_EVIDENCE/);
});
test('an independent final reading must match the initial one', async () => {
  await assert.rejects(
    roundTrip(
      fixture(true, (visit) => visit < 3),
      parseScript(sample),
    ),
    /BLUETOOTH_STATE_CHANGED/,
  );
});
test('extra arguments cannot turn navigation into a tap on a switch', () => {
  assert.throws(() => parseScript({ schemaVersion: 1, steps: [{ ...sample.steps[2], x: 12, y: 3 }] }));
});
test('Harmony NearLink and Bluetooth switches can have different values', () => {
  const control = (name) => ({
    type: 'Toggle',
    id: `Setting.Fusion.${name}SwitchGroup.${name}SwitchItem.result`,
    checkable: 'true',
    checked: 'true',
  });
  assert.equal(classifyHarmony([control('Nearlink')]).page, 'other');
  assert.equal(
    classifyHarmony([control('Nearlink'), { ...control('Bluetooth'), checked: 'false' }]).bluetooth,
    false,
  );
});
test('iOS requires the identified Bluetooth switch and navigation button', () => {
  const xml = (body) => '<AppiumAUT>' + body + '</AppiumAUT>';
  const back = '<button type="XCUIElementTypeButton" name="BackButton" visible="true"/>';
  const toggle = '<switch type="XCUIElementTypeSwitch" name="BLUETOOTH" value="0" visible="true"/>';
  assert.equal(classifyXml('ios', xml(back + '<text name="蓝牙"/>')).page, 'other');
  assert.equal(classifyXml('ios', xml(back + toggle + toggle)).page, 'other');
  assert.equal(classifyXml('ios', xml(back + toggle)).bluetooth, false);
});
test('Android switch needs its Settings package and Bluetooth-specific label', () => {
  const xml = (pkg, label) =>
    `<hierarchy><n package="${pkg}" resource-id="com.android.settings:id/switch_text" text="${label}"/><n package="${pkg}" resource-id="android:id/switch_widget" class="android.widget.Switch" checkable="true" checked="true"/></hierarchy>`;
  assert.equal(classifyXml('android', xml('com.android.settings', '启用蓝牙')).bluetooth, true);
  assert.equal(classifyXml('android', xml('com.android.settings', '使用 WLAN')).page, 'other');
  assert.equal(classifyXml('android', xml('other', '启用蓝牙')).page, 'other');
});
