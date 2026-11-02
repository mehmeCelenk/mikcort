import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserPath = process.env.MIKCORT_TEST_BROWSER || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const csp = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).app.security.csp;

test('WebRTC connection recovery', { timeout: 180_000 }, async (t) => {
  assert.ok(browserPath);
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'mikcort-recovery-'));
  assert.equal(dirname(directory), temporaryRoot);
  let browser;
  let server;
  try {
    await build({ root, configFile: false, plugins: [vue()], logLevel: 'error', build: { outDir: directory, emptyOutDir: true,
      rollupOptions: { input: [join(root, 'tests/fixtures/recovery.html'), join(root, 'tests/fixtures/signaling.html')] } } });
    server = createServer(async (request, response) => {
      const file = resolve(directory, '.' + new URL(request.url, 'http://localhost').pathname);
      if (!file.startsWith(directory + '/') && !file.startsWith(directory + '\\')) { response.writeHead(403).end(); return; }
      try {
        const data = await readFile(file);
        response.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css' })[extname(file)] || 'text/html',
          'Content-Security-Policy': csp }).end(data);
      } catch { response.writeHead(404).end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ executablePath: browserPath, headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    async function fixture(ids, run, dropFirstOffer = false) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.setDefaultTimeout(10_000);
      try {
        await page.clock.install();
        await page.goto(`http://127.0.0.1:${server.address().port}/tests/fixtures/recovery.html`);
        if (dropFirstOffer) await page.evaluate(() => {
          window.recoveryTest.controls.drop = (message) => {
            if (message.type !== 'offer') return false;
            window.recoveryTest.controls.drop = null;
            return true;
          };
        });
        await page.evaluate((ids) => window.recoveryTest.start(ids), ids);
        if (!dropFirstOffer) await page.waitForFunction(() => window.recoveryTest.connected());
        await run(page);
        assert.deepEqual(await page.evaluate(() => window.recoveryTest.failures), []);
        assert.deepEqual(errors, []);
      } catch (cause) {
        t.diagnostic(JSON.stringify(await page.evaluate(() => ({
          states: [...window.recoveryTest.clients.values()].map((c) => ({ id: c.id, peers: [...c.voice.peers].map(([id, p]) =>
            ({ id, state: p.connectionState, ice: p.iceConnectionState, signaling: p.signalingState })) })),
          failures: window.recoveryTest.failures,
          events: window.recoveryTest.report().entries.filter((e) => e.event !== 'peer-stats').slice(-65),
        }))));
        throw cause;
      } finally { await page.evaluate(() => window.recoveryTest.stop()).catch(() => {}); await page.close(); }
    }

    await t.test('one-sided failure in a five-member room rebuilds only that pair and resumes audio', () => fixture(['a', 'b', 'c', 'd', 'e'], async (page) => {
      await page.evaluate(() => {
        const r = window.recoveryTest;
        window.original = r.peer('a', 'b');
        window.unaffected = r.peer('a', 'c');
        r.clients.get('a').volumes.b = 0.45;
        r.fail('a', 'b'); // The lower ID used to wait forever after rebuilding.
      });
      for (let i = 0; i < 3; i++) {
        await page.clock.fastForward(i ? 15_100 : 1);
        await page.waitForFunction((count) => window.recoveryTest.report().entries.filter((e) => e.event === 'recovery-start').length >= count, i + 1);
      }
      await page.waitForFunction(() => window.recoveryTest.peer('a', 'b') !== window.original && window.recoveryTest.connected());
      assert.equal(await page.evaluate(() => window.recoveryTest.peer('a', 'c') === window.unaffected), true);
      assert.equal(await page.evaluate(() => window.recoveryTest.clients.get('a').volumes.b), 0.45);
      const initial = await page.evaluate(() => window.recoveryTest.packets('a', 'b'));
      await page.waitForFunction(async (initial) => await window.recoveryTest.packets('a', 'b') > initial, initial);
      await page.waitForFunction(async () => await window.recoveryTest.packets('b', 'a') > 0);
    }));

    await t.test('offline signaling waits without giving up, then retries when available', () => fixture(['a', 'b'], async (page) => {
      await page.evaluate(() => { const r = window.recoveryTest; r.clients.get('a').online = false; r.fail('a', 'b'); });
      await page.clock.fastForward(1);
      await page.waitForFunction(() => window.recoveryTest.report().entries.some((e) => e.event === 'recovery-waiting-for-signaling'));
      await page.clock.fastForward(15_000);
      assert.equal(await page.evaluate(() => window.recoveryTest.report().entries.filter((e) => e.event === 'recovery-start').length), 0);
      await page.evaluate(() => { window.recoveryTest.clients.get('a').online = true; });
      await page.clock.fastForward(3100);
      await page.waitForFunction(() => window.recoveryTest.messages.some((m) => m.type === 'offer' && m.payload.sdp.includes('a=ice-ufrag:')) &&
        window.recoveryTest.report().entries.some((e) => e.event === 'recovery-start' && e.details.attempts === 1));
    }));

    await t.test('an initial offer lost before ICE starts is retried by the connection watchdog', () => fixture(['a', 'b'], async (page) => {
      await page.clock.runFor(26_000);
      await page.waitForFunction(() => window.recoveryTest.connected());
      await page.waitForFunction(async () => await window.recoveryTest.packets('a', 'b') > 0);
      assert.ok(await page.evaluate(() => window.recoveryTest.report().entries.some((e) => e.event === 'connection-timeout')));
    }, true));

    await t.test('lost answers time out instead of trapping negotiation', () => fixture(['a', 'b'], async (page) => {
      await page.evaluate(async () => {
        const r = window.recoveryTest;
        r.controls.drop = (m) => m.type === 'answer';
        await r.clients.get('a').voice.requestPeerOffer('b', r.peer('a', 'b'), { iceRestart: true });
      });
      assert.equal(await page.evaluate(() => window.recoveryTest.peer('a', 'b').signalingState), 'have-local-offer');
      await page.clock.runFor(25_100);
      await page.waitForFunction(() => window.recoveryTest.report().entries.some((e) => e.event === 'connection-timeout'));
      await page.evaluate(() => { window.recoveryTest.controls.drop = null; });
      await page.clock.runFor(25_100);
      await page.waitForFunction(() => window.recoveryTest.peer('a', 'b').signalingState === 'stable' && window.recoveryTest.connected());
    }));

    await t.test('simultaneous rebuilds resolve collisions and reject delayed old answers', () => fixture(['a', 'b'], async (page) => {
      await page.evaluate(() => {
        const r = window.recoveryTest;
        window.original = r.peer('a', 'b');
        window.oldAnswer = r.messages.find((m) => m.type === 'answer');
        r.fail('a', 'b'); r.fail('b', 'a');
      });
      for (let i = 0; i < 3; i++) {
        await page.clock.fastForward(i ? 15_100 : 1);
        await page.waitForFunction((count) => window.recoveryTest.report().entries.filter((e) => e.event === 'recovery-start').length >= count, (i + 1) * 2);
      }
      await page.waitForFunction(() => window.recoveryTest.peer('a', 'b') !== window.original && window.recoveryTest.connected());
      await page.evaluate(async () => {
        const r = window.recoveryTest;
        r.controls.drop = (m) => m.type === 'answer';
        await r.clients.get('a').voice.requestPeerOffer('b', r.peer('a', 'b'));
        r.controls.drop = null;
        await r.deliver(window.oldAnswer);
      });
      assert.equal(await page.evaluate(() => window.recoveryTest.peer('a', 'b').signalingState), 'have-local-offer');
      assert.equal(await page.evaluate(() => window.recoveryTest.report().entries.some((e) => e.event === 'stale-answer')), true);
    }));

    await t.test('heartbeat has responses and diagnostics contain no SDP or addresses', () => fixture(['a', 'b'], async (page) => {
      await page.clock.runFor(60_100);
      const report = await page.evaluate(() => window.recoveryTest.report());
      assert.ok(report.entries.some((e) => e.event === 'peer-stats'));
      assert.ok(!report.entries.some((e) => e.event === 'heartbeat-timeout'));
      assert.doesNotMatch(JSON.stringify(report), /a=ice-ufrag|candidate:|127\.0\.0\.1|"sdp"|"password"/);
    }));

    await t.test('a late answer from an earlier offer cannot satisfy a newer offer in the same session', () => fixture(['a', 'b'], async (page) => {
      const state = await page.evaluate(async () => {
        const r = window.recoveryTest;
        const oldAnswer = r.messages.find((m) => m.type === 'answer');
        r.controls.drop = (m) => m.type === 'answer';
        await r.clients.get('a').voice.requestPeerOffer('b', r.peer('a', 'b'), { iceRestart: true });
        await r.clients.get('a').voice.receiveAnswer('b', oldAnswer.payload);
        return r.peer('a', 'b').signalingState;
      });
      assert.equal(state, 'have-local-offer');
      assert.equal(await page.evaluate(() => window.recoveryTest.report().entries.some((e) => e.event === 'stale-answer')), true);
    }));

    await t.test('a muted remote microphone recovers even while transport remains connected', () => fixture(['a', 'b'], async (page) => {
      await page.waitForFunction(() => !window.recoveryTest.peer('a', 'b').getReceivers()[0].track.muted);
      await page.evaluate(() => {
        const r = window.recoveryTest;
        window.original = r.peer('a', 'b');
        const track = window.original.getReceivers().find((receiver) => receiver.track.kind === 'audio').track;
        Object.defineProperty(track, 'muted', { configurable: true, get: () => true });
        track.dispatchEvent(new Event('mute'));
      });
      await page.clock.runFor(8100);
      await page.waitForFunction(() => window.recoveryTest.report().entries.some((e) => e.event === 'recovery-start'));
      await page.clock.runFor(40_100);
      await page.waitForFunction(() => window.recoveryTest.peer('a', 'b') !== window.original && window.recoveryTest.connected());
      await page.waitForFunction(async () => await window.recoveryTest.packets('a', 'b') > 0);
    }));

    await t.test('heartbeat silence triggers recovery and leaving cancels all retry work', () => fixture(['a', 'b'], async (page) => {
      await page.evaluate(() => {
        // Drop data-channel traffic without changing the real transport state.
        RTCDataChannel.prototype.send = function () {};
      });
      await page.clock.runFor(51_100);
      await page.waitForFunction(() => window.recoveryTest.report().entries.some((e) => e.event === 'heartbeat-timeout'));
      await page.waitForFunction(() => window.recoveryTest.report().entries.some((e) => e.event === 'recovery-start'));
      await page.evaluate(() => window.recoveryTest.stop());
      const count = await page.evaluate(() => window.recoveryTest.messages.length);
      await page.clock.runFor(61_000);
      assert.equal(await page.evaluate(() => window.recoveryTest.messages.length), count);
    }));

    for (const mode of ['missing-pong', 'missing-join']) {
      await t.test(`signaling reconnects after ${mode} and rejoins the room`, async () => {
        const page = await browser.newPage();
        let connections = 0;
        let joins = 0;
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        try {
          await page.clock.install();
          await page.routeWebSocket('ws://mikcort.test/ws', (socket) => {
            const connection = ++connections;
            socket.onMessage((raw) => {
              const message = JSON.parse(String(raw));
              if (message.type === 'join-room') {
                joins++;
                if (mode !== 'missing-join' || connection > 1) socket.send(JSON.stringify({ type: 'room-users',
                  userId: message.userId, payload: { users: [] } }));
              }
              if (message.type === 'ping' && (mode !== 'missing-pong' || connection > 1)) socket.send(JSON.stringify({ type: 'pong' }));
            });
          });
          await page.goto(`http://127.0.0.1:${server.address().port}/tests/fixtures/signaling.html`);
          await page.waitForFunction(() => window.signalingReport().entries.some((e) => e.event === 'signaling-open'));
          await page.clock.runFor(mode === 'missing-pong' ? 42_000 : 12_000);
          await page.waitForFunction(() => window.signalingReport().entries.filter((e) => e.event === 'signaling-open').length >= 2);
          assert.ok(connections >= 2);
          assert.ok(joins >= 2);
          const events = await page.evaluate(() => window.signalingReport().entries.map((e) => e.event));
          assert.ok(events.includes(mode === 'missing-pong' ? 'signaling-pong-timeout' : 'room-join-timeout'));
          assert.ok(events.includes('room-joined'));
          await page.getByRole('button', { name: 'Copy connection report' }).click();
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });
    }
  } finally {
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
