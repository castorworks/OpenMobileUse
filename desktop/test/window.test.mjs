import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const fixture = fileURLToPath(new URL('./fixture.cjs', import.meta.url));
test(
  'desktop selection, observation-bound input, history, cancellation and per-device isolation',
  { timeout: 60000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'omu-window-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const env = { ...process.env, OMU_STATE_DIR: dir };
    delete env.DEEPSEEK_API_KEY;
    const app = await _electron.launch({
      executablePath: require('electron'),
      args: [fixture, '--user-data-dir=' + join(dir, 'electron')],
      env,
    });
    try {
      const p = await app.firstWindow();
      p.setDefaultTimeout(8000);
      await p.getByRole('button', { name: /Android 模拟器|android fixture/ }).click();
      await p.waitForFunction(() => !document.querySelector('#control').disabled);
      const id = 'android:fixture';
      const before = (await p.evaluate((id) => window.omu.refresh(id), id)).frame.observationId;
      await p.locator('#control').selectOption('0');
      await p.locator('#text').fill('中文输入');
      await p.locator('#input').click();
      await p.waitForFunction(() => !document.querySelector('#control').disabled);
      assert.match(await p.locator('#notice').textContent(), /输入已执行/);
      const error = await p.evaluate(
        async ([id, token]) => {
          try {
            await window.omu.action(id, { action: 'tap', x: 0.5, y: 0.5 }, token);
          } catch (e) {
            return e.message;
          }
        },
        [id, before],
      );
      assert.match(error, /STALE_OBSERVATION/);
      await p.locator('#task').selectOption('script-bluetooth');
      await p.locator('#start').click();
      await p.waitForFunction(() => document.querySelector('#run-status').dataset.status === 'succeeded');
      assert.deepEqual(await p.locator('#readings b').allTextContents(), ['关闭', '关闭', '关闭']);
      assert.match(await p.locator('#result-message').textContent(), /已回到设置首页/);
      await p.locator('#task').selectOption('custom-script');
      await p.locator('#task-file').setInputFiles({
        name: 'wait.json',
        mimeType: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            steps: [
              { action: 'waitFor', id: 'missing', timeoutMs: 15000 },
              { action: 'tap', x: 0.5, y: 0.5 },
            ],
          }),
        ),
      });
      await p.locator('#start').click();
      await p.locator('#stop').waitFor({ state: 'visible' });
      assert.equal(await p.locator('#tap').isDisabled(), true);
      await p.getByRole('button', { name: /harmony fixture/ }).click();
      await p.waitForFunction(() => !document.querySelector('#control').disabled);
      assert.equal(await p.locator('#history').isVisible(), false);
      await p.getByRole('button', { name: /android fixture/ }).click();
      await p.locator('#stop').click();
      await p.waitForFunction(() => document.querySelector('#run-status').dataset.status === 'cancelled');
      const data = await p.evaluate((id) => window.omu.history(id), id);
      assert.equal(data.history.length, 2);
      assert.equal(data.history[0].result.steps.length, 1);
      assert.equal(data.history[1].status, 'succeeded');
      const files = await readdir(join(dir, 'workbench'), { recursive: true });
      for (const file of files.filter((f) => f.endsWith('.json'))) {
        const saved = await readFile(join(dir, 'workbench', file), 'utf8');
        assert.doesNotMatch(saved, /中文输入|data:image/);
      }
      const box = await p.locator('#screen').boundingBox();
      await p.mouse.click(box.x + box.width * 0.95, box.y + box.height * 0.8);
      await p.locator('#tap').click();
      await p.waitForFunction(() =>
        document.querySelector('#notice').textContent.includes('ACTION_OUTCOME_UNKNOWN'),
      );
      assert.equal(await p.locator('#tap').isDisabled(), true);
      await p.locator('#diagnose').click();
      await p.getByText(/待核查 · tap/).waitFor();
      await p.getByText('设备可控制', { exact: true }).waitFor();
    } finally {
      await app.close();
    }
  },
);

test('the same Electron entry used by npm start opens the workbench', { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omu-start-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [fileURLToPath(new URL('../', import.meta.url)), '--user-data-dir=' + dir],
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: '运行控制' }).waitFor();
    assert.equal(await page.locator('#start').isDisabled(), true);
  } finally {
    await app.close();
  }
});
