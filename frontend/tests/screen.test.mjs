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

test('screen sharing in Chromium with the production CSP', { timeout: 90_000 }, async (t) => {
  assert.ok(browserPath, 'Install Chrome/Edge or set MIKCORT_TEST_BROWSER.');
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'mikcort-screen-'));
  assert.equal(dirname(directory), temporaryRoot);
  let browser;
  let server;
  try {
    await build({ root, configFile: false, plugins: [vue()], logLevel: 'error', build: {
      outDir: directory, emptyOutDir: true, rollupOptions: { input: join(root, 'tests/fixtures/screen.html') },
    } });
    server = createServer(async (request, response) => {
      const file = resolve(directory, '.' + new URL(request.url, 'http://localhost').pathname);
      if (dirname(file) !== directory && !file.startsWith(directory + '/') && !file.startsWith(directory + '\\')) {
        response.writeHead(403).end();
        return;
      }
      try {
        const data = await readFile(file);
        response.writeHead(200, {
          'Content-Type': ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[extname(file)] || 'text/plain',
          'Content-Security-Policy': csp,
        }).end(data);
      } catch { response.writeHead(404).end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/tests/fixtures/screen.html`;
    browser = await chromium.launch({ executablePath: browserPath, headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'] });
    async function fixture(run) {
      const context = await browser.newContext({ viewport: { width: 900, height: 520 } });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(url);
        await page.waitForFunction(() => window.screenTest);
        await run(page);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }

    await t.test('all four profiles configure real WebRTC senders and capture constraints', () => fixture(async (page) => {
      const results = await page.evaluate(async () => {
        const results = [];
        for (const [resolution, fps] of [[720, 30], [720, 60], [1080, 30], [1080, 60]]) {
          const voice = window.screenTest.createVoice();
          voice.selectedScreenResolution.value = resolution;
          voice.selectedScreenFps.value = fps;
          await voice.screen.startScreenShare();
          const senders = voice.peers.peers.get('remote').getSenders();
          const video = senders.find((sender) => sender.track?.kind === 'video');
          const audio = senders.find((sender) => sender.track?.kind === 'audio');
          results.push({ resolution, fps, video: video.getParameters(), audio: audio.getParameters(),
            hint: video.track.contentHint, constraints: window.screenTest.captures.at(-1).constraints,
            error: voice.error.value, label: voice.screen.screenShareCaptureLabel.value });
          await voice.cleanup();
        }
        return results;
      });
      for (const [index, bitrate] of [3_000_000, 5_000_000, 6_000_000, 10_000_000].entries()) {
        const result = results[index];
        assert.equal(result.error, '');
        assert.equal(result.video.encodings[0].maxBitrate, bitrate);
        assert.equal(result.video.encodings[0].maxFramerate, result.fps);
        assert.equal(result.video.encodings[0].scaleResolutionDownBy, 1);
        assert.equal(result.video.degradationPreference, result.fps === 60 ? 'balanced' : 'maintain-resolution');
        assert.equal(result.audio.encodings[0].maxBitrate, 128_000);
        assert.equal(result.hint, result.fps === 60 ? 'motion' : 'detail');
        assert.deepEqual(result.constraints.video.height, { ideal: result.resolution, max: result.resolution });
        assert.match(result.label, new RegExp(`${result.resolution}.*${result.fps} FPS`));
      }
    }));

    await t.test('quality menu fits the smallest window, starts selected quality and persists it', () => fixture(async (page) => {
      await page.evaluate(() => window.screenTest.createVoice(true));
      await page.getByRole('button', { name: 'Share screen', exact: true }).click();
      assert.equal(await page.getByLabel('Screen share resolution', { exact: true }).inputValue(), '1080');
      assert.equal(await page.getByLabel('Screen share frame rate', { exact: true }).inputValue(), '30');
      const bounds = await page.locator('.share-menu').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 900 && bounds.y + bounds.height <= 520);
      await page.getByLabel('Screen share resolution', { exact: true }).selectOption('720');
      await page.getByLabel('Screen share frame rate', { exact: true }).selectOption('60');
      await page.getByRole('button', { name: 'Start sharing', exact: true }).click();
      await page.waitForFunction(() => window.screenTest.current.screen.sharingScreen.value && !window.screenTest.current.screen.screenStarting.value);
      const result = await page.evaluate(async () => {
        const voice = window.screenTest.current;
        const saved = [localStorage.getItem('mikcort:screen:resolution'), localStorage.getItem('mikcort:screen:fps')];
        await voice.cleanup();
        const next = window.screenTest.createVoice();
        const restored = [next.selectedScreenResolution.value, next.selectedScreenFps.value];
        await next.cleanup();
        return { saved, restored };
      });
      assert.deepEqual(result, { saved: ['720', '60'], restored: [720, 60] });
    }));

    await t.test('smaller sources show actual dimensions and quality failures are visible', () => fixture(async (page) => {
      const result = await page.evaluate(async () => {
        const { controls } = window.screenTest;
        controls.sourceHeight = 720;
        controls.failCaptureConstraints = true;
        const voice = window.screenTest.createVoice();
        await voice.screen.startScreenShare();
        const label = voice.screen.screenShareCaptureLabel.value;
        const captureError = voice.error.value;
        controls.failSenderParameters = true;
        const sender = voice.peers.peers.get('remote').getSenders().find((sender) => sender.track?.kind === 'video');
        await voice.peers.configureSender(sender, sender.track, 'screen');
        const senderError = voice.error.value;
        await voice.cleanup();
        return { label, captureError, senderError };
      });
      assert.match(result.label, /1280×720/);
      assert.match(result.captureError, /capture quality could not be applied/);
      assert.match(result.senderError, /streaming quality could not be applied/);
    }));

    await t.test('late picker results and duplicate starts cannot leave a capture running', () => fixture(async (page) => {
      const result = await page.evaluate(async () => {
        let release;
        window.screenTest.controls.delay = new Promise((resolve) => { release = resolve; });
        const voice = window.screenTest.createVoice();
        const first = voice.screen.startScreenShare();
        await voice.screen.startScreenShare();
        await voice.screen.stopScreenShare();
        release();
        await first;
        const result = { count: window.screenTest.captures.length, sharing: voice.screen.sharingScreen.value,
          starting: voice.screen.screenStarting.value,
          tracks: window.screenTest.captures[0].stream.getTracks().map((track) => track.readyState) };
        await voice.cleanup();
        return result;
      });
      assert.deepEqual(result, { count: 1, sharing: false, starting: false, tracks: ['ended', 'ended'] });
    }));

    await t.test('stopping during sender setup cannot attach a stale screen audio track', () => fixture(async (page) => {
      const result = await page.evaluate(async () => {
        let release;
        window.screenTest.controls.senderDelay = new Promise((resolve) => { release = resolve; });
        const voice = window.screenTest.createVoice();
        const pending = voice.screen.startScreenShare();
        while (!voice.peers.peers.get('remote')?.getSenders().length) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await voice.screen.stopScreenShare();
        release();
        await pending;
        const attached = voice.peers.peers.get('remote').getSenders().filter((sender) => sender.track !== null).length;
        await voice.cleanup();
        return attached;
      });
      assert.equal(result, 0);
    }));

    await t.test('1080p screen video is decoded by a second local WebRTC peer', () => fixture(async (page) => {
      const result = await page.evaluate(async () => {
        const voice = window.screenTest.createVoice();
        const receiver = new window.screenTest.NativePeerConnection({ iceServers: [] });
        const video = document.createElement('video');
        video.autoplay = true;
        video.muted = true;
        document.body.append(video);
        receiver.ontrack = ({ track, streams }) => { if (track.kind === 'video') video.srcObject = streams[0]; };
        async function gathered(peer) {
          if (peer.iceGatheringState === 'complete') return;
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('ICE gathering timed out')), 5000);
            peer.addEventListener('icegatheringstatechange', () => {
              if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
            });
          });
        }
        try {
          await voice.screen.startScreenShare();
          const sender = voice.peers.peers.get('remote');
          await gathered(sender);
          await receiver.setRemoteDescription(sender.localDescription);
          await receiver.setLocalDescription(await receiver.createAnswer());
          await gathered(receiver);
          await sender.setRemoteDescription(receiver.localDescription);
          const deadline = Date.now() + 12_000;
          while ((video.videoWidth !== 1920 || video.videoHeight !== 1080) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          const reports = [...(await sender.getStats()).values()];
          const outbound = reports.find((report) => report.type === 'outbound-rtp' && report.kind === 'video');
          return { width: video.videoWidth, height: video.videoHeight, framesEncoded: outbound?.framesEncoded, error: voice.error.value };
        } finally {
          receiver.close();
          await voice.cleanup();
        }
      });
      t.diagnostic(JSON.stringify(result));
      assert.equal(result.error, '');
      assert.equal(result.width, 1920);
      assert.equal(result.height, 1080);
      assert.ok(result.framesEncoded > 0);
    }));
  } finally {
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
