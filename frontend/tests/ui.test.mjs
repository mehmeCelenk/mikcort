import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
const previewDirectory = process.env.MIKCORT_PREVIEW_DIR;

test('Mikcort desktop flows', { timeout: 90_000 }, async (t) => {
  assert.ok(browserPath, 'Install Chrome/Edge or set MIKCORT_TEST_BROWSER.');
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'mikcort-ui-'));
  assert.equal(dirname(directory), temporaryRoot);
  let browser;
  let server;
  try {
    await build({ root, configFile: false, plugins: [vue()], logLevel: 'error', build: { outDir: directory, emptyOutDir: true } });
    server = createServer(async (request, response) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const file = resolve(directory, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(directory + '/') && !file.startsWith(directory + '\\')) { response.writeHead(403).end(); return; }
      try {
        const data = await readFile(file);
        response.writeHead(200, {
          'Content-Type': ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' })[extname(file)] || 'text/plain',
          'Content-Security-Policy': csp,
        }).end(data);
      } catch { response.writeHead(404).end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: [
      '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    ] });
    async function fixture(run, screenPreview = false) {
      const context = await browser.newContext({ viewport: { width: 980, height: 680 } });
      const page = await context.newPage();
      page.setDefaultTimeout(6000);
      const errors = [];
      const joins = [];
      let previewSocket;
      await page.exposeFunction('sendPreviewSignal', (message) => {
        previewSocket.send(JSON.stringify({ ...message, roomId: 'a8c42d', userId: 'emre' }));
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem('mikcort:server-url', 'ws://mikcort.test/ws');
        const NativePeer = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends NativePeer { constructor(options) { super({ ...options, iceServers: [] }); } };
      });
      await page.route('http://mikcort.test/rooms', (route) => route.fulfill({
        contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ rooms: [
          { id: 'a8c42d', users: ['Emre', 'Deniz', 'Ece'] },
          { id: 'b6f91a', users: ['Selin', 'Can'] },
          { id: 'f4e28b', locked: true, users: [] },
        ] }),
      }));
      await page.routeWebSocket('ws://mikcort.test/ws', (socket) => {
        previewSocket = socket;
        socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (screenPreview && message.targetUserId === 'emre') {
          void page.evaluate((signal) => window.receivePreviewSignal(signal), message).catch((error) => errors.push(error.message));
        }
        if (message.type === 'join-room') {
          joins.push(message);
          if (message.roomId === 'f4e28b' && message.payload.password !== 'friends') {
            socket.send(JSON.stringify({ type: 'error', payload: { message: 'Wrong room password.' } }));
          } else {
            socket.send(JSON.stringify({ type: 'room-users', userId: message.userId, payload: {
              self: { id: message.userId, displayName: message.payload.displayName },
              users: [...(screenPreview ? [] : [{ id: 'emre', displayName: 'Emre' }]), { id: 'deniz', displayName: 'Deniz' }, { id: 'ece', displayName: 'Ece' }],
            } }));
          }
        }
        if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
        });
      });
      try {
        await page.goto(url);
        await page.getByRole('button', { name: /Room a8c42d/ }).waitFor();
        await run(page, joins, (message) => previewSocket.send(JSON.stringify(message)));
        assert.deepEqual(errors, [], 'No uncaught UI errors');
      } finally { await context.close(); }
    }
    async function preview(page, name) {
      if (!previewDirectory) return;
      await mkdir(previewDirectory, { recursive: true });
      await page.screenshot({ path: join(previewDirectory, name + '.png') });
    }

    await t.test('lobby is simple, validates the name and fits desktop sizes', () => fixture(async (page) => {
      assert.equal(await page.getByRole('button', { name: 'Create room', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('textbox', { name: 'Server address' }).count(), 0);
      const privateRoom = page.getByRole('button', { name: /Room f4e28b/ });
      assert.equal(await privateRoom.locator('.room-row-count').count(), 0);
      await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Mehmet');
      assert.equal(await page.getByRole('button', { name: 'Create room', exact: true }).isEnabled(), true);
      await preview(page, 'mikcort-lobby');
      for (const [width, height] of [[900, 520], [1440, 900]]) {
        await page.setViewportSize({ width, height });
        const button = await page.getByRole('button', { name: 'Create room', exact: true }).boundingBox();
        assert.ok(button.x >= 0 && button.y >= 0 && button.x + button.width <= width && button.y + button.height <= height);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      }
    }));

    await t.test('room controls, chat and focused sound settings work', () => fixture(async (page, joins) => {
      await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Mehmet');
      await page.getByRole('button', { name: /Room a8c42d/ }).click();
      await page.getByRole('button', { name: 'Mute microphone', exact: true }).waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('[title="Mute microphone"]').disabled);
      assert.equal(await page.locator('.member-card').count(), 4);
      assert.equal(await page.locator('.dock-actions button.icon-button').count(), 5);
      assert.equal(joins[0].payload.displayName, 'Mehmet');
      await preview(page, 'mikcort-room');
      await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
      await page.getByRole('button', { name: 'Unmute microphone', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Deafen output', exact: true }).click();
      await page.getByRole('button', { name: 'Turn output on', exact: true }).click();
      await page.getByRole('button', { name: 'Open chat', exact: true }).click();
      await page.getByRole('textbox', { name: 'Message room', exact: true }).fill('Akşam burada buluşalım.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.getByText('Akşam burada buluşalım.', { exact: true }).waitFor();
      await preview(page, 'mikcort-chat');
      await page.getByRole('button', { name: 'Close chat', exact: true }).last().click();
      await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Audio settings', exact: true });
      await settings.waitFor();
      assert.equal(await settings.evaluate((element) => element.contains(document.activeElement)), true);
      assert.equal(await settings.locator('details[open]').count(), 0);
      await preview(page, 'mikcort-settings');
      await settings.getByText('Fine-tune your microphone', { exact: true }).click();
      assert.equal(await settings.getByText('Mic gain', { exact: true }).isVisible(), true);
      await page.keyboard.press('Escape');
      await settings.waitFor({ state: 'hidden' });
      await page.setViewportSize({ width: 900, height: 520 });
      const dock = await page.locator('.voice-dock').boundingBox();
      assert.ok(dock.y + dock.height <= 520 && dock.x + dock.width <= 900);
      await page.getByRole('button', { name: 'Leave room', exact: true }).click();
      await page.getByRole('button', { name: 'Create room', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Create room', exact: true }).click();
      await page.locator('.room-shell').waitFor();
      assert.match(joins.at(-1).roomId, /^[a-z0-9]{8}$/);
      assert.equal(joins.at(-1).payload.password, undefined);
    }));

    await t.test('private-room password is requested in context and a wrong password can be retried', () => fixture(async (page, joins) => {
      await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Mehmet');
      await page.getByRole('button', { name: /Room f4e28b/ }).click();
      const dialog = page.getByRole('dialog', { name: 'You’re invited.', exact: true });
      await dialog.getByLabel('Password', { exact: true }).fill('wrong');
      await dialog.getByRole('button', { name: 'Join room', exact: true }).click();
      await dialog.getByRole('alert').waitFor();
      await dialog.getByLabel('Password', { exact: true }).fill('friends');
      await dialog.getByRole('button', { name: 'Join room', exact: true }).click();
      await page.locator('.room-shell').waitFor();
      assert.equal(joins.at(-1).payload.password, 'friends');
      await page.getByRole('button', { name: 'Leave room', exact: true }).click();
      await page.getByRole('button', { name: 'Room options', exact: true }).click();
      await page.getByRole('button', { name: 'Create private room', exact: true }).click();
      const createDialog = page.getByRole('dialog', { name: 'Keep it between friends.', exact: true });
      await createDialog.getByLabel('Password', { exact: true }).fill('our-room');
      await createDialog.getByRole('button', { name: 'Create private room', exact: true }).click();
      await page.locator('.room-shell').waitFor();
      assert.equal(joins.at(-1).payload.password, 'our-room');
    }));

    await t.test('watching a live screen keeps people and controls visible and supports chat/fullscreen', () => fixture(async (page, _joins, send) => {
      await page.evaluate(() => {
        const peer = new RTCPeerConnection({ iceServers: [] });
        const pendingCandidates = [];
        window.previewPeer = peer;
        peer.onicecandidate = ({ candidate }) => {
          if (candidate) void window.sendPreviewSignal({ type: 'ice-candidate', payload: candidate.toJSON() });
        };
        window.receivePreviewSignal = async (message) => {
          if (message.type === 'answer') {
            await peer.setRemoteDescription(message.payload);
            for (const candidate of pendingCandidates.splice(0)) await peer.addIceCandidate(candidate);
          } else if (message.type === 'ice-candidate') {
            if (peer.remoteDescription) await peer.addIceCandidate(message.payload);
            else pendingCandidates.push(message.payload);
          }
        };
        const canvas = document.createElement('canvas');
        canvas.width = 1920;
        canvas.height = 1080;
        const drawing = canvas.getContext('2d');
        drawing.scale(1.5, 1.5);
        let frame = 0;
        function draw() {
          drawing.fillStyle = '#f5f6f2'; drawing.fillRect(0, 0, 1280, 720);
          drawing.fillStyle = '#e6eae4'; drawing.fillRect(0, 0, 1280, 48);
          for (const [index, color] of ['#df9c96', '#d9c381', '#9ebca2'].entries()) {
            drawing.fillStyle = color; drawing.beginPath(); drawing.arc(24 + index * 20, 24, 5, 0, Math.PI * 2); drawing.fill();
          }
          drawing.fillStyle = '#6b776d'; drawing.font = '14px Segoe UI'; drawing.fillText('Weekend notes', 560, 30);
          drawing.fillStyle = '#edf0ea'; drawing.fillRect(0, 48, 205, 672);
          drawing.fillStyle = '#3c5142'; drawing.font = '600 22px Segoe UI'; drawing.fillText('Notes', 28, 108);
          drawing.fillStyle = '#6f8173'; drawing.font = '14px Segoe UI';
          drawing.fillText('All notes', 28, 162); drawing.fillText('Favorites', 28, 200); drawing.fillText('Shared with friends', 28, 238);
          drawing.fillStyle = '#dbe6d9'; drawing.fillRect(16, 277, 174, 40);
          drawing.fillStyle = '#3e6347'; drawing.fillText('Weekend plans', 28, 302);
          drawing.fillStyle = '#849383'; drawing.font = '12px Segoe UI'; drawing.fillText('SHARED WITH YOUR PEOPLE', 280, 137);
          drawing.fillStyle = '#28392d'; drawing.font = '600 44px Segoe UI'; drawing.fillText('A weekend, well spent.', 280, 205);
          drawing.fillStyle = '#778476'; drawing.font = '18px Segoe UI'; drawing.fillText('A few ideas. Everyone is welcome.', 282, 250);
          drawing.fillStyle = '#dde3d9'; drawing.fillRect(280, 288, 820, 1);
          for (const [index, [time, title, detail]] of [
            ['19:00', 'Game night', 'Bring your favorite co-op game.'],
            ['20:30', 'A movie together', 'We can pick something in the room.'],
            ['Later', 'Just hanging out', 'No plan needed.'],
          ].entries()) {
            const y = 349 + index * 102;
            drawing.fillStyle = '#81917f'; drawing.font = '14px Segoe UI'; drawing.fillText(time, 282, y);
            drawing.fillStyle = '#344b38'; drawing.font = '600 22px Segoe UI'; drawing.fillText(title, 380, y);
            drawing.fillStyle = '#7b8879'; drawing.font = '16px Segoe UI'; drawing.fillText(detail, 380, y + 31);
          }
          const x = 930 + Math.sin(frame++ / 30) * 15;
          drawing.fillStyle = '#5d9470'; drawing.beginPath(); drawing.moveTo(x, 458); drawing.lineTo(x + 5, 480); drawing.lineTo(x + 11, 472); drawing.lineTo(x + 20, 469); drawing.closePath(); drawing.fill();
          drawing.fillRect(x + 20, 479, 52, 24); drawing.fillStyle = '#fff'; drawing.font = '12px Segoe UI'; drawing.fillText('Emre', x + 29, 496);
        }
        draw();
        window.previewTimer = setInterval(draw, 50);
        const stream = canvas.captureStream(20);
        stream.getVideoTracks()[0].contentHint = 'detail';
        peer.addTrack(stream.getVideoTracks()[0], stream);
      });
      await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Mehmet');
      await page.getByRole('button', { name: /Room a8c42d/ }).click();
      await page.locator('.room-shell').waitFor();
      send({ type: 'user-joined', userId: 'emre', payload: { id: 'emre', displayName: 'Emre' } });
      await page.getByRole('button', { name: 'Adjust volume for Emre', exact: true }).waitFor();
      await page.evaluate(async () => {
        await window.previewPeer.setLocalDescription(await window.previewPeer.createOffer());
        await window.sendPreviewSignal({ type: 'offer', payload: window.previewPeer.localDescription.toJSON() });
      });
      const watch = page.locator('[title="Watch stream"]');
      await watch.waitFor();
      await preview(page, 'mikcort-live-ready');
      await watch.click();
      await page.waitForFunction(() => {
        const video = document.querySelector('.screen-video-wrap video');
        return video && video.readyState >= 2 && video.videoWidth > 0;
      });
      assert.equal(await page.locator('.member-card').count(), 4);
      assert.equal(await page.getByRole('button', { name: 'Leave room', exact: true }).isVisible(), true);
      await preview(page, 'mikcort-watching');
      await page.getByRole('button', { name: 'Open chat', exact: true }).click();
      await page.getByRole('textbox', { name: 'Message room', exact: true }).fill('Game night sounds good!');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await preview(page, 'mikcort-watching-chat');
      await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
      assert.equal(await page.locator('.screen-share-tile.fullscreen').count(), 1);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.screen-share-tile.fullscreen').count(), 0);
      await page.getByRole('button', { name: 'Stop watching', exact: true }).click();
      await page.locator('.screen-share-grid').waitFor({ state: 'hidden' });
      await page.evaluate(() => { clearInterval(window.previewTimer); window.previewPeer.close(); });
    }, true));

    await t.test('connection settings validate addresses and support Escape', () => fixture(async (page) => {
      await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Your connection.', exact: true });
      await dialog.getByLabel('Server address', { exact: true }).fill('https://example.com');
      await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
      assert.equal(await dialog.getByRole('alert').isVisible(), true);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await page.getByRole('textbox', { name: 'Your name', exact: true }).isVisible(), true);
    }));
  } finally {
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
