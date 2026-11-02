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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserPath = process.env.MIKCORT_TEST_BROWSER || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const csp = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).app.security.csp;

test('microphone processing in Chromium with the production CSP', { timeout: 90_000 }, async (t) => {
  assert.ok(browserPath, 'Install Chrome/Edge, or set MIKCORT_TEST_BROWSER to a Chromium executable.');
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'mikcort-audio-'));
  assert.equal(dirname(directory), temporaryRoot, 'Build and cleanup stay inside the temporary directory');
  let browser;
  let server;
  let failWorklet = false;
  try {
    await build({ root, configFile: false, logLevel: 'error', build: {
      outDir: directory, emptyOutDir: true, rollupOptions: { input: join(root, 'tests/fixtures/audio.html') },
    } });
    server = createServer(async (request, response) => {
      if (/workletProcessor/.test(request.url) && failWorklet) {
        response.writeHead(404).end();
        return;
      }
      const file = resolve(directory, '.' + new URL(request.url, 'http://localhost').pathname);
      if (!file.startsWith(directory + '/') && !file.startsWith(directory + '\\')) {
        response.writeHead(403).end();
        return;
      }
      try {
        const data = await readFile(file);
        response.writeHead(200, {
          'Content-Type': ({ '.js': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm' })[extname(file)] || 'text/plain',
          'Content-Security-Policy': csp,
        }).end(data);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/tests/fixtures/audio.html`;
    browser = await chromium.launch({ executablePath: browserPath, headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'] });

    async function fixture(run) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(url);
        await page.waitForFunction(() => window.audioTest);
        await run(page);
        assert.deepEqual(errors, [], 'No uncaught audio/worklet errors');
      } finally {
        await context.close();
      }
    }

    await t.test('real RNNoise WASM reduces noise and cleans up tracks/context', () => fixture(async (page) => {
      const result = await page.evaluate(async () => {
        const { createPipeline, captures } = window.audioTest;
        async function rms(pipeline) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const samples = new Float32Array(pipeline.analyser.fftSize);
          let power = 0;
          for (let i = 0; i < 10; i++) {
            pipeline.analyser.getFloatTimeDomainData(samples);
            power += samples.reduce((sum, value) => sum + value * value, 0) / samples.length;
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          return Math.sqrt(power / 10);
        }
        const off = await createPipeline('off');
        const rawRms = await rms(off);
        off.destroy();
        const filtered = await createPipeline('rnnoise');
        const filteredRms = await rms(filtered);
        const sampleRate = filtered.context.sampleRate;
        const notices = filtered.notices;
        filtered.destroy();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { rawRms, filteredRms, sampleRate, notices, context: filtered.context.state,
          tracks: [...filtered.rawStream.getTracks(), ...filtered.stream.getTracks()].map((track) => track.readyState),
          browserNoiseSuppression: captures[1].constraints.audio.noiseSuppression };
      });
      t.diagnostic(JSON.stringify(result));
      assert.equal(result.sampleRate, 48_000);
      assert.ok(result.rawRms > 0.01);
      assert.ok(result.filteredRms > 0, 'WASM produces audio rather than permanent silence');
      assert.ok(result.filteredRms < result.rawRms * 0.85, 'Noise is reduced rather than passed through');
      assert.equal(result.browserNoiseSuppression, false, 'Do not stack denoisers');
      assert.deepEqual(result.notices, []);
      assert.equal(result.context, 'closed');
      assert.deepEqual(result.tracks, ['ended', 'ended']);
    }));

    await t.test('Standard and Off do not load RNNoise', () => fixture(async (page) => {
      const assets = [];
      page.on('request', (request) => { if (/wasm|workletProcessor/.test(request.url())) assets.push(request.url()); });
      const flags = await page.evaluate(async () => {
        for (const mode of ['standard', 'off']) (await window.audioTest.createPipeline(mode)).destroy();
        return window.audioTest.captures.map((capture) => capture.constraints.audio.noiseSuppression);
      });
      assert.deepEqual(flags, [true, false]);
      assert.deepEqual(assets, []);
    }));

    await t.test('invalid WASM falls back, and a later attempt can recover', () => fixture(async (page) => {
      await page.route('**/*.wasm', (route) => route.fulfill({ body: 'invalid wasm' }));
      const fallback = await page.evaluate(async () => {
        const pipeline = await window.audioTest.createPipeline();
        const result = { notices: pipeline.notices, applied: window.audioTest.captures[0].appliedConstraints };
        pipeline.destroy();
        return result;
      });
      assert.match(fallback.notices[0], /Standard noise suppression is active/);
      assert.deepEqual(fallback.applied, [{ noiseSuppression: true }]);
      await page.unroute('**/*.wasm');
      const recovered = await page.evaluate(async () => {
        const pipeline = await window.audioTest.createPipeline();
        pipeline.destroy();
        return pipeline.notices;
      });
      assert.deepEqual(recovered, []);
    }));

    await t.test('worklet load failure keeps microphone available', () => fixture(async (page) => {
      // AudioWorklet requests do not pass through Playwright page routing.
      failWorklet = true;
      try {
        const result = await page.evaluate(async () => {
          const pipeline = await window.audioTest.createPipeline();
          const result = { notices: pipeline.notices, track: pipeline.stream.getAudioTracks()[0].readyState };
          pipeline.destroy();
          return result;
        });
        assert.equal(result.track, 'live');
        assert.match(result.notices[0], /Standard/);
      } finally {
        failWorklet = false;
      }
    }));

    await t.test('processor errors bypass RNNoise and enable Standard', () => fixture(async (page) => {
      const result = await page.evaluate(async () => {
        const pipeline = await window.audioTest.createPipeline();
        window.audioTest.worklets[0].dispatchEvent(new Event('processorerror'));
        await new Promise((resolve) => setTimeout(resolve, 30));
        const result = { notices: pipeline.notices, applied: window.audioTest.captures[0].appliedConstraints };
        pipeline.destroy();
        return result;
      });
      assert.match(result.notices[0], /Standard/);
      assert.deepEqual(result.applied, [{ noiseSuppression: true }]);
    }));

    await t.test('leaving while microphone permission is pending releases the late stream', () => fixture(async (page) => {
      const result = await page.evaluate(async () => {
        const original = navigator.mediaDevices.getUserMedia;
        let release;
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          await new Promise((resolve) => { release = resolve; });
          return original(constraints);
        };
        const controller = new AbortController();
        const pending = window.audioTest.createPipeline('rnnoise', controller.signal);
        controller.abort();
        release();
        try { await pending; return { error: '' }; } catch (error) {
          return { error: error.name, state: window.audioTest.captures[0].stream.getAudioTracks()[0].readyState };
        }
      });
      assert.deepEqual(result, { error: 'AbortError', state: 'ended' });
    }));

    await t.test('mode switches replace peer tracks and preserve mute/deafen', () => fixture(async (page) => {
      const result = await page.evaluate(async () => {
        const { audio, replacements, scope } = window.audioTest.createVoice();
        const defaultMode = audio.noiseSuppressionMode.value;
        await audio.startMicrophone();
        replacements.length = 0;
        const oldTrack = audio.localStream.value.getAudioTracks()[0];
        audio.toggleMute();
        audio.noiseSuppressionMode.value = 'standard';
        await audio.applyAudioSettings();
        const mutedTrack = replacements[0].enabled;
        audio.toggleMute();
        audio.toggleDeafen();
        audio.noiseSuppressionMode.value = 'off';
        await audio.applyAudioSettings();
        const deafenedTrack = replacements[1].enabled;
        audio.toggleDeafen();
        const restored = replacements[1].enabled;
        audio.stopLocalAudio();
        scope.stop();
        return { defaultMode, oldState: oldTrack.readyState, mutedTrack, deafenedTrack, restored,
          replacements: replacements.length, saved: localStorage.getItem('mikcort:audio:noise-suppression-mode') };
      });
      assert.deepEqual(result, { defaultMode: 'rnnoise', oldState: 'ended', mutedTrack: false,
        deafenedTrack: false, restored: true, replacements: 2, saved: 'off' });
    }));
  } finally {
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
