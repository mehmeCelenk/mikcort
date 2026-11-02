# Mikcort Voice

Lightweight desktop voice chat for small rooms. The Go and Cloudflare backends are signaling-only; audio, screen share, and voice data flow directly between clients through peer-to-peer WebRTC.

[Turkish README](README.md)

## Project Structure

```text
mikcort/
  frontend/                    Vue 3 + Tauri desktop app
    src/                       Frontend source
    src-tauri/                 Native desktop shell
  backend/
    go/                        Self-hosted Go signaling server
      cmd/server/
      internal/
    cloudflare-signaling/      Cloudflare Workers + Durable Objects signaling server
```

## How It Works

Mikcort has two main parts:

- `frontend/`: the desktop client. It renders the Vue UI, opens the microphone/screen streams, creates WebRTC peer connections, and plays remote audio.
- `backend/`: signaling backends. They do not receive or relay voice audio. They only help clients find each other and exchange WebRTC setup messages.

The app can use either backend:

- `backend/go/`: a small self-hosted WebSocket server.
- `backend/cloudflare-signaling/`: a Cloudflare Workers + Durable Objects version for hosted signaling.

Both backends speak the same WebSocket message contract, so the frontend can switch between them by changing the signaling server URL.

### Connection Flow

1. A client opens the app and connects to a signaling server through `/ws`.
2. The client joins a room with `join-room`.
3. The signaling backend stores who is in that room and sends the new client the existing room members.
4. Clients exchange WebRTC `offer`, `answer`, and `ice-candidate` messages through the signaling backend.
5. Once WebRTC connects, microphone audio and screen share media flow directly between clients peer-to-peer.
6. Chat messages still go through the signaling backend because they are small room events, not media streams.

```text
Desktop client A  <-- WebRTC audio/screen -->  Desktop client B
        |                                           |
        +---------- WebSocket signaling ------------+
                         |
                 Go or Cloudflare backend
```

### Privacy And Rooms

Rooms are created implicitly when the first user joins a room ID. A room can be public or password-protected:

- Public rooms show connected display names in the room list.
- Password-protected rooms show only that the room exists; user names and counts are hidden.
- Room passwords are kept only in the in-memory signaling room state and disappear when the room becomes empty.

This keeps the project lightweight: no database, no account system, and no central media server.

## Stack

- Desktop UI: Tauri + Vue 3 + TypeScript
- Backend option 1: Go standard library WebSocket signaling
- Backend option 2: Cloudflare Workers + Durable Objects
- Voice: WebRTC mesh peer-to-peer
- STUN: `stun:stun.l.google.com:19302`, `stun:global.stun.twilio.com:3478`
- No media server, database, auth, Kubernetes, or Redis

## Run Locally

Start the Go signaling server:

```powershell
cd backend/go
go run ./cmd/server
```

The server listens on `:8080` by default. Override it with:

```powershell
cd backend/go
$env:ADDR=":9090"; go run ./cmd/server
```

Install frontend dependencies:

```powershell
cd frontend
cmd /c npm install
```

Run the Tauri app in development:

```powershell
cd frontend
cmd /c npm run tauri dev
```

You can also run the web UI only for quick browser testing:

```powershell
cd frontend
cmd /c npm run dev
```

## Usage

1. Start one signaling backend.
2. Start two or more app instances.
3. Enter a display name and choose **Create room**.
4. Click the same room in the room list on the other instances.
5. For a password-protected room, choose **Room options > Create private room**. Joining prompts for the password, and participants stay hidden in the room list.
6. The microphone opens automatically. The bottom bar contains microphone, deafen, screen sharing, sound settings, and leave controls.

Change the server address through **Connection settings** on the home screen. Chat opens on the right. Additional sound settings are grouped under **Fine-tune your microphone** and **Keyboard shortcuts**.

Logo sources live in `frontend/public/brand/`. Regenerate desktop icons from the frontend directory with `npm run tauri -- icon public/brand/app-icon.svg -o src-tauri/icons`.

## Screen Sharing Quality

Choose **720p / 1080p** and **30 / 60 FPS** in the screen sharing menu. The default is 1080p 30 FPS, and selections are saved on the device.

| Target quality | Video bitrate ceiling (per peer) |
| --- | --- |
| 720p 30 FPS | 3 Mbps |
| 720p 60 FPS | 5 Mbps |
| 1080p 30 FPS | 6 Mbps |
| 1080p 60 FPS | 10 Mbps |

30 FPS profiles prioritize text/detail resolution; 60 FPS profiles balance sharpness and motion. Screen audio has a 128 kbps ceiling. These are targets and ceilings; WebRTC adapts to the connection and hardware. The sharing status shows the source's actual dimensions and FPS setting, rather than measuring the quality received by viewers. The app displays a notice if quality settings cannot be applied.

## Microphone Noise Suppression

**Audio settings > Noise suppression** offers three modes:

- **Off**: no noise suppression.
- **Standard**: WebRTC's built-in noise suppression.
- **RNNoise (AI)**: on-device WASM/AudioWorklet processing at 48 kHz mono. This is the default; users who previously disabled noise suppression keep Off.

The RNNoise model and processor ship with the app, so no external service or API key is required. Built-in noise suppression is disabled while RNNoise is selected. If loading or processing fails, the app attempts to enable Standard mode and shows a notice in audio settings. Echo cancellation and automatic gain remain independent settings.

Bundled licenses: [frontend/public/third-party-licenses](frontend/public/third-party-licenses).

## Checks

```powershell
cd backend/go
go test ./...
go build ./...
```

```powershell
cd frontend
cmd /c npm run build
cmd /c npm run test:audio
cmd /c npm run test:screen
cmd /c npm run test:ui
```

Screen tests use synthetic video/audio to check quality selection, real WebRTC sender parameters, cancellation/error handling, and 1080p reception by a second local peer. They do not capture the user's screen.

Audio tests use synthetic input in an installed Chrome/Edge browser without opening the physical microphone. Set `MIKCORT_TEST_BROWSER` to a Chromium executable to use another installation. Tests exercise real RNNoise WASM processing under the production CSP, failure recovery, mode changes, and microphone resource cleanup.

```powershell
cd backend/cloudflare-signaling
cmd /c npm run typecheck
```

Tauri native builds also require the Rust toolchain and the platform-specific Tauri prerequisites.

## Desktop Auto Updates

The Tauri desktop app uses the official Tauri updater plugin and GitHub Releases.

Updater endpoint:

```text
https://github.com/mehmeCelenk/mikcort/releases/latest/download/latest.json
```

The app checks for updates on startup. If an update exists, it downloads and installs it automatically, then asks the user to restart.

### Signing Keys

Updates are signed. The public key is stored in `frontend/src-tauri/tauri.conf.json`. The private key must stay secret and is ignored by Git under `frontend/.tauri/`.

Generate a new keypair only if you are starting a new update channel:

```powershell
cd frontend
cmd /c npm run tauri signer generate -- --ci -f -w .tauri\mikcort-updater.key
```

Use the generated public key in `frontend/src-tauri/tauri.conf.json`.

Add these GitHub repository secrets:

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

If the key was generated with `--ci` and no password, set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to an empty string or omit it.

### Releasing A New Version

Use semantic versioning, for example `0.2.12`.

1. Update the version in:
   - `frontend/package.json`
   - `frontend/src-tauri/Cargo.toml`
   - `frontend/src-tauri/tauri.conf.json`
2. Commit the version bump.
3. Create and push a matching tag:

```powershell
git tag v0.2.12
git push origin main v0.2.12
```

The `Release desktop app` workflow builds the Windows app and a universal macOS desktop app, signs updater artifacts, creates a GitHub Release, and uploads `latest.json`.

## Docker Backend

Build and push the Go signaling server image:

```powershell
docker build -t mehmetcelenk/mikcort:latest backend/go
docker push mehmetcelenk/mikcort:latest
```

Run it on a VM while publishing host port `8081`:

```bash
docker run -d --name mikcort-signaling --restart unless-stopped -p 8081:8080 mehmetcelenk/mikcort:latest
```

Desktop clients should then use:

```text
ws://SERVER_IP:8081/ws
```

## Cloudflare Workers Backend

An alternative signaling backend lives in `backend/cloudflare-signaling/`. It uses Cloudflare Workers + Durable Objects and keeps the same WebSocket message contract as the Go backend.

```bash
cd backend/cloudflare-signaling
npm install
npm run deploy
```

Desktop clients can then use:

```text
wss://mikcort-signaling.<your-subdomain>.workers.dev/ws
```

The Cloudflare backend is also signaling-only. WebRTC audio remains peer-to-peer.

## License

This project is released under the [MIT License](LICENSE).
