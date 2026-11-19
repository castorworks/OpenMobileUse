import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { LocalAppium } from '../appium.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

test('cold start, simultaneous connections, reuse, crash recovery and owned shutdown', async () => {
  const reservation = createServer();
  const url = (await listen(reservation)) + '/wd/hub';
  await new Promise((resolve) => reservation.close(resolve));
  const owner = new LocalAppium(url);
  const borrower = new LocalAppium(url);
  try {
    const first = owner.ensureReady();
    assert.equal(owner.ensureReady(), first);
    await first;
    const service = owner.owned;
    await borrower.ensureReady();
    assert.equal(borrower.owned, undefined);
    await borrower.close();
    const health = await (await fetch(url + '/status')).json();
    assert.equal(health.value.ready, true);
    service.child.kill('SIGTERM');
    await service.closed;
    await owner.ensureReady();
    assert.notEqual(owner.owned.child.pid, service.child.pid);
  } finally {
    await borrower.close();
    await owner.close();
  }
  await assert.rejects(fetch(url + '/status'));
});

test('an occupied endpoint is diagnosed without starting or stopping a process', async () => {
  const server = createServer((_req, res) => res.end('other local service'));
  const url = await listen(server);
  const manager = new LocalAppium(url);
  try {
    await assert.rejects(manager.ensureReady(), /APPIUM_ENDPOINT_CONFLICT/);
    assert.equal(manager.owned, undefined);
    await manager.close();
    assert.equal(await (await fetch(url)).text(), 'other local service');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
