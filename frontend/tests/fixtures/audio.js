import { computed, effectScope, ref } from 'vue';
import { createMicrophonePipeline } from '../../src/features/voice/microphoneProcessing';
import { useVoiceAudio } from '../../src/features/voice/useVoiceAudio';

const captures = [];
const worklets = [];
const NativeAudioWorkletNode = window.AudioWorkletNode;
// Capture the actual worklet to exercise its runtime error recovery.
const nativeConnect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (target, ...args) {
  if (target instanceof NativeAudioWorkletNode && !worklets.includes(target)) {
    worklets.push(target);
  }
  return nativeConnect.call(this, target, ...args);
};

navigator.mediaDevices.getUserMedia = async (constraints) => {
  // Stereo, 44.1 kHz input exercises the mono downmix and 48 kHz resampling.
  const context = new AudioContext({ sampleRate: 44_100 });
  const source = context.createBufferSource();
  const buffer = context.createBuffer(2, 44_100, 44_100);
  let seed = 13;
  for (let channel = 0; channel < 2; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      samples[i] = ((seed >>> 0) / 0x100000000 - 0.5) * 0.1;
    }
  }
  source.buffer = buffer;
  source.loop = true;
  const output = context.createMediaStreamDestination();
  source.connect(output);
  source.start();
  await context.resume();
  const appliedConstraints = [];
  output.stream.getAudioTracks()[0].applyConstraints = async (value) => { appliedConstraints.push(value); };
  captures.push({ context, constraints, stream: output.stream, appliedConstraints });
  return output.stream;
};

function createPipeline(mode = 'rnnoise', signal = new AbortController().signal) {
  const notices = [];
  return createMicrophonePipeline({
    deviceId: '', noiseSuppression: mode, echoCancellation: true, autoGainControl: true,
    signal, onNotice: (message) => notices.push(message),
  }).then((pipeline) => ({ ...pipeline, notices }));
}

function createVoice() {
  const replacements = [];
  const sender = { replaceTrack: async (track) => { replacements.push(track); } };
  const peers = new Map([['remote', { getSenders: () => [sender] }]]);
  const senderSources = new WeakMap([[sender, 'mic']]);
  const scope = effectScope();
  const audio = scope.run(() => useVoiceAudio({
    configureSender: () => {}, currentUserId: ref('local'), ensurePeer: async () => peers.get('remote'),
    error: ref(''), getViewingScreenUser: () => null, memberVolumes: {}, otherUsers: computed(() => []),
    peers, remoteAudio: ref(null), screenVolumes: {}, senderSources, speakingUsers: {},
    startSpeakingDetection: () => {}, status: ref(''), stopSpeakingDetection: () => {},
  }));
  return { audio, replacements, scope };
}

window.audioTest = { createPipeline, createVoice, captures, worklets };
