import { computed, createApp, effectScope, h, ref } from 'vue';
import { usePersistentNumber } from '../../src/composables/usePersistentStorage';
import VoiceDock from '../../src/components/voice/VoiceDock.vue';
import { useScreenShare } from '../../src/features/voice/useScreenShare';
import { useVoicePeers } from '../../src/features/voice/useVoicePeers';
import { screenShareProfile } from '../../src/features/voice/screenShareQuality';
import '../../src/styles.css';

const NativePeerConnection = window.RTCPeerConnection;
// Test peers stay on this device and do not use public STUN servers.
window.RTCPeerConnection = class extends NativePeerConnection {
  constructor(options) { super({ ...options, iceServers: [] }); }
};

const captures = [];
const controls = { delay: null, senderDelay: null, failCaptureConstraints: false, failSenderParameters: false, sourceHeight: null };
const nativeSetParameters = RTCRtpSender.prototype.setParameters;
RTCRtpSender.prototype.setParameters = function (parameters) {
  if (controls.senderDelay) return controls.senderDelay.then(() => nativeSetParameters.call(this, parameters));
  return controls.failSenderParameters ? Promise.reject(new Error('Test sender failure')) : nativeSetParameters.call(this, parameters);
};
navigator.mediaDevices.getDisplayMedia = async (constraints) => {
  if (controls.delay) await controls.delay;
  const height = controls.sourceHeight || constraints.video.height.ideal;
  const canvas = document.createElement('canvas');
  canvas.width = height * 16 / 9;
  canvas.height = height;
  const context = canvas.getContext('2d');
  let frame = 0;
  function draw() {
    context.fillStyle = '#151719';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#9df2c6';
    context.font = '32px sans-serif';
    context.fillText('Mikcort — readable screen sharing', 30, 60);
    context.fillRect((frame++ * 7) % canvas.width, 100, 120, 120);
  }
  draw();
  const timer = setInterval(draw, 1000 / constraints.video.frameRate.ideal);
  const stream = canvas.captureStream(constraints.video.frameRate.ideal);
  const audioContext = new AudioContext();
  const oscillator = audioContext.createOscillator();
  const destination = audioContext.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  await audioContext.resume();
  stream.addTrack(destination.stream.getAudioTracks()[0]);
  const track = stream.getVideoTracks()[0];
  const apply = track.applyConstraints.bind(track);
  track.applyConstraints = (value) => controls.failCaptureConstraints ? Promise.reject(new Error('Test constraint failure')) : apply(value);
  captures.push({ constraints, stream, cleanup: () => {
    clearInterval(timer);
    if (audioContext.state !== 'closed') void audioContext.close();
  } });
  return stream;
};

function createVoice(mount = false) {
  const scope = effectScope();
  const state = scope.run(() => {
    const selectedScreenFps = usePersistentNumber('mikcort:screen:fps', 30, 30, 60);
    const selectedScreenResolution = usePersistentNumber('mikcort:screen:resolution', 1080, 720, 1080);
    const currentUserId = ref('local');
    const otherUsers = computed(() => ['remote']);
    const error = ref('');
    const status = ref('');
    let screen;
    const peers = useVoicePeers({
      attachRemoteScreen: () => {}, currentUserId, error, getLocalStream: () => null,
      getRemoteElementVolume: () => 1, getScreenStream: () => screen.screenStream.value,
      getSocketOpen: () => true, getUsers: () => ['local', 'remote'], intentionallyClosed: () => false,
      getScreenShareProfile: () => screenShareProfile(selectedScreenResolution.value, selectedScreenFps.value),
      otherUsers, peerStates: {}, remoteAudio: ref(null), removeRemoteScreen: () => {},
      roomId: () => 'test', sendSignal: () => {}, speakingUsers: {}, startSpeakingDetection: () => {},
      status, stopSpeakingDetection: () => {}, updateRemoteAudioSettings: () => {}, memberVolumes: {}, screenVolumes: {},
    });
    screen = useScreenShare({
      activeMemberVolumeUser: ref(null), clearRemoteTrackRecovery: () => {}, currentUserId, error, micStarted: ref(true),
      otherUsers, peers: peers.peers, playVoiceFeedback: () => {}, remoteAudio: ref(null),
      requestPeerOffer: peers.requestPeerOffer, screenVolumes: {}, selectedScreenFps, selectedScreenResolution,
      senderSources: peers.senderSources, status, updateRemoteAudioSettings: () => {}, ensurePeer: peers.ensurePeer,
    });
    return { screen, peers, error, status, selectedScreenFps, selectedScreenResolution };
  });
  let app;
  if (mount) {
    const { screen, selectedScreenFps, selectedScreenResolution } = state;
    app = createApp({ render: () => h('aside', { style: 'position:fixed;left:0;right:0;bottom:0' }, [h(VoiceDock, {
      deafened: false, micStarted: true, micStarting: false, muted: false, settingsOpen: false,
      screenShareMenuOpen: screen.screenShareMenuOpen.value, sharingScreen: screen.sharingScreen.value,
      screenShareCaptureLabel: screen.screenShareCaptureLabel.value, screenStarting: screen.screenStarting.value,
      selectedScreenFps: selectedScreenFps.value, selectedScreenResolution: selectedScreenResolution.value,
      'onUpdate:selectedScreenFps': (value) => { selectedScreenFps.value = value; },
      'onUpdate:selectedScreenResolution': (value) => { selectedScreenResolution.value = value; },
      onToggleScreenShare: screen.toggleScreenShare, onStartScreenShare: screen.startScreenShare,
      userDisplayName: 'Mehmet', userInitials: 'MC', voiceState: 'Live',
    })]) });
    app.mount('#app');
  }
  const result = { ...state, async cleanup() {
    await state.screen.stopScreenShare();
    state.peers.closeAllPeers();
    captures.forEach((capture) => capture.cleanup());
    app?.unmount();
    scope.stop();
  } };
  window.screenTest.current = result;
  return result;
}

window.screenTest = { createVoice, captures, controls, NativePeerConnection };
