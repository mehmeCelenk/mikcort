import { computed, ref } from 'vue';
import { useVoicePeers } from '../../src/features/voice/useVoicePeers';
import { screenShareProfile } from '../../src/features/voice/screenShareQuality';
import { connectionDiagnosticsReport } from '../../src/features/voice/connectionDiagnostics';

const NativePeer = RTCPeerConnection;
window.RTCPeerConnection = class extends NativePeer {
  constructor(options) { super({ ...options, iceServers: [] }); }
};
const clients = new Map();
const messages = [];
const failures = [];
const controls = { drop: null };
let audio;

async function deliver(message) {
  const target = clients.get(message.targetUserId);
  if (!target || controls.drop?.(message)) return;
  try {
    if (message.type === 'offer') await target.voice.receiveOffer(message.userId, message.payload);
    if (message.type === 'answer') await target.voice.receiveAnswer(message.userId, message.payload);
    if (message.type === 'ice-candidate') await target.voice.receiveCandidate(message.userId, message.payload);
  } catch (error) { failures.push(String(error)); }
}

async function start(ids) {
  audio = new AudioContext();
  const tone = audio.createOscillator();
  const destination = audio.createMediaStreamDestination();
  tone.connect(destination);
  tone.start();
  await audio.resume();
  for (const id of ids) {
    const host = document.createElement('div');
    document.body.append(host);
    const client = { id, online: true, closed: false, volumes: {}, states: {}, status: ref(''), stream: destination.stream };
    client.voice = useVoicePeers({
      attachRemoteScreen: () => {}, currentUserId: ref(id), error: ref(''), getLocalStream: () => client.stream,
      getRemoteElementVolume: () => 0, getScreenStream: () => null, getSocketOpen: () => client.online,
      getUsers: () => ids, intentionallyClosed: () => client.closed, getScreenShareProfile: () => screenShareProfile(1080, 30),
      otherUsers: computed(() => ids.filter((other) => other !== id)), peerStates: client.states, remoteAudio: ref(host),
      removeRemoteScreen: () => {}, roomId: () => 'test', sendSignal: (message) => {
        messages.push(message);
        // Signal delivery is asynchronous, as on a real WebSocket.
        queueMicrotask(() => { void deliver(message); });
      }, speakingUsers: {}, startSpeakingDetection: () => {}, status: client.status,
      stopSpeakingDetection: () => {}, updateRemoteAudioSettings: () => {}, memberVolumes: client.volumes, screenVolumes: {},
    });
    clients.set(id, client);
  }
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      await clients.get(ids[j]).voice.ensurePeer(ids[i], false);
      await clients.get(ids[i]).voice.ensurePeer(ids[j], true);
    }
  }
}

function peer(from, to) { return clients.get(from).voice.peers.get(to); }
function fail(from, to) {
  const connection = peer(from, to);
  Object.defineProperty(connection, 'connectionState', { configurable: true, get: () => 'failed' });
  Object.defineProperty(connection, 'iceConnectionState', { configurable: true, get: () => 'failed' });
  connection.dispatchEvent(new Event('connectionstatechange'));
  return connection;
}
async function packets(from, to) {
  return [...(await peer(from, to).getStats()).values()].filter((r) => r.type === 'inbound-rtp' && r.kind === 'audio')
    .reduce((sum, r) => sum + r.packetsReceived, 0);
}
function connected() {
  return [...clients.values()].every((client) => [...client.voice.peers.values()].every((p) => p.connectionState === 'connected'));
}
window.recoveryTest = { start, clients, messages, failures, controls, peer, fail, packets, connected, deliver,
  report: () => JSON.parse(connectionDiagnosticsReport()),
  async stop() {
    for (const client of clients.values()) { client.closed = true; client.voice.closeAllPeers(); }
    await audio?.close();
  },
};
