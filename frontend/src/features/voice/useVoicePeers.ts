import type { ComputedRef, Ref } from 'vue';
import type { SenderSource, SignalMessage } from './types';
import type { ScreenShareProfile } from './screenShareQuality';

interface UseVoicePeersOptions {
  attachRemoteScreen: (userId: string, stream: MediaStream) => void;
  currentUserId: Ref<string>;
  error: Ref<string>;
  getLocalStream: () => MediaStream | null;
  getRemoteElementVolume: (audio: HTMLAudioElement) => number;
  getScreenStream: () => MediaStream | null;
  getSocketOpen: () => boolean;
  getUsers: () => string[];
  intentionallyClosed: () => boolean;
  getScreenShareProfile: () => ScreenShareProfile;
  otherUsers: ComputedRef<string[]>;
  peerStates: Record<string, string>;
  remoteAudio: Ref<HTMLDivElement | null>;
  removeRemoteScreen: (userId: string) => void;
  roomId: () => string;
  sendSignal: (message: SignalMessage) => void;
  speakingUsers: Record<string, boolean>;
  startSpeakingDetection: (userId: string, stream: MediaStream) => void;
  status: Ref<string>;
  stopSpeakingDetection: (userId: string) => void;
  updateRemoteAudioSettings: () => void;
  memberVolumes: Record<string, number>;
  screenVolumes: Record<string, number>;
}

export function useVoicePeers({
  attachRemoteScreen,
  currentUserId,
  error,
  getLocalStream,
  getRemoteElementVolume,
  getScreenStream,
  getSocketOpen,
  getUsers,
  intentionallyClosed,
  getScreenShareProfile,
  peerStates,
  remoteAudio,
  removeRemoteScreen,
  roomId,
  sendSignal,
  speakingUsers,
  startSpeakingDetection,
  status,
  stopSpeakingDetection,
  updateRemoteAudioSettings,
  memberVolumes,
  screenVolumes,
}: UseVoicePeersOptions) {
  const peers = new Map<string, RTCPeerConnection>();
  const queuedCandidates = new Map<string, RTCIceCandidateInit[]>();
  const senderSources = new WeakMap<RTCRtpSender, SenderSource>();
  const makingOffers = new Set<string>();
  const peerRecoveryTimers = new Map<string, number>();
  const peerHeartbeats = new Map<string, { channel: RTCDataChannel; timer?: number; lastSeen: number }>();
  const peerRecoveryAttempts = new Map<string, number>();
  const remoteTrackRecoveryTimers = new Map<string, number>();
  const pendingOffers = new Map<string, RTCOfferOptions | undefined>();
  const queuedScreenShareOffers = new Set<string>();
  const queuedScreenShareOfferTimers = new Map<string, number>();
  const ignoredOfferUsers = new Set<string>();

  async function ensurePeer(userId: string, makeOffer: boolean) {
    let peer = peers.get(userId);
    if (peer?.signalingState === 'closed' || peer?.connectionState === 'closed') {
      closePeer(userId);
      peer = undefined;
    }
    if (!peer) {
      peer = createPeer(userId);
      peers.set(userId, peer);
    }

    const localStream = getLocalStream();
    if (localStream) {
      for (const track of localStream.getAudioTracks()) {
        if (!peer.getSenders().some((sender) => senderSources.get(sender) === 'mic')) {
          await addSender(peer, track, localStream, 'mic');
        }
      }
    }

    const screenStream = getScreenStream();
    if (screenStream) {
      for (const track of screenStream.getTracks()) {
        // Applying sender parameters yields; sharing may stop before the next track.
        if (getScreenStream() !== screenStream || track.readyState !== 'live' || peer.signalingState === 'closed') {
          break;
        }
        if (!peer.getSenders().some((sender) => sender.track === track)) {
          await addSender(peer, track, screenStream, 'screen');
        }
      }
    }

    if (makeOffer) {
      await requestPeerOffer(userId, peer);
    }

    return peer;
  }

  async function requestPeerOffer(userId: string, peer: RTCPeerConnection, options?: RTCOfferOptions) {
    const offerSent = await sendOffer(userId, peer, options);
    if (!offerSent && peer.signalingState !== 'closed') {
      pendingOffers.set(userId, mergeOfferOptions(pendingOffers.get(userId), options));
    }
    return offerSent;
  }

  function queueScreenShareOffer(userId: string) {
    if (!hasLiveScreenStream()) {
      return;
    }

    queuedScreenShareOffers.add(userId);
    if (queuedScreenShareOfferTimers.has(userId)) {
      return;
    }

    const timer = window.setTimeout(() => {
      queuedScreenShareOfferTimers.delete(userId);
      void flushQueuedScreenShareOffer(userId);
    }, 1500);
    queuedScreenShareOfferTimers.set(userId, timer);
  }

  async function flushQueuedScreenShareOffer(userId: string) {
    if (!queuedScreenShareOffers.has(userId) || !hasLiveScreenStream() || !getSocketOpen()) {
      queuedScreenShareOffers.delete(userId);
      return;
    }

    const peer = peers.get(userId);
    if (!peer || peer.signalingState !== 'stable' || peer.connectionState === 'closed') {
      return;
    }

    await ensurePeer(userId, false);
    const currentPeer = peers.get(userId);
    if (!currentPeer || currentPeer.signalingState !== 'stable') {
      return;
    }

    queuedScreenShareOffers.delete(userId);
    await requestPeerOffer(userId, currentPeer);
  }

  async function receiveAnswer(userId: string, answer: RTCSessionDescriptionInit) {
    const peer = peers.get(userId);
    if (peer && peer.signalingState === 'have-local-offer') {
      await peer.setRemoteDescription(answer).catch(() => undefined);
      await flushQueuedCandidates(userId, peer);
      await flushPendingOffer(userId, peer);
    }
  }

  async function flushPendingOffer(userId: string, peer: RTCPeerConnection) {
    if (peer.signalingState !== 'stable' || !getSocketOpen() || !pendingOffers.has(userId)) {
      return;
    }

    const options = pendingOffers.get(userId);
    pendingOffers.delete(userId);
    await requestPeerOffer(userId, peer, options);
  }

  function mergeOfferOptions(current: RTCOfferOptions | undefined, next: RTCOfferOptions | undefined) {
    if (!current) {
      return next;
    }
    if (!next) {
      return current;
    }
    return {
      ...current,
      ...next,
      iceRestart: Boolean(current.iceRestart || next.iceRestart),
    };
  }

  async function sendOffer(userId: string, peer: RTCPeerConnection, options?: RTCOfferOptions) {
    if (makingOffers.has(userId) || peer.signalingState !== 'stable') {
      return false;
    }

    makingOffers.add(userId);
    try {
      const offer = await peer.createOffer(options);
      if (peer.signalingState !== 'stable') {
        return false;
      }

      await peer.setLocalDescription(offer);
      sendSignal({
        type: 'offer',
        roomId: roomId(),
        userId: currentUserId.value,
        targetUserId: userId,
        payload: offer,
      });
      return true;
    } catch {
      return false;
    } finally {
      makingOffers.delete(userId);
    }
  }

  function createPeer(userId: string) {
    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
      ],
      iceCandidatePoolSize: 4,
    });

    setupPeerHeartbeat(userId, peer.createDataChannel('heartbeat', { ordered: false, maxRetransmits: 0 }));
    peer.ondatachannel = (event) => {
      if (event.channel.label === 'heartbeat') {
        setupPeerHeartbeat(userId, event.channel);
      }
    };

    peerStates[userId] = 'new';

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          type: 'ice-candidate',
          roomId: roomId(),
          userId: currentUserId.value,
          targetUserId: userId,
          payload: event.candidate.toJSON(),
        });
      }
    };

    peer.onconnectionstatechange = () => handlePeerConnectionState(userId, peer);
    peer.oniceconnectionstatechange = () => handlePeerConnectionState(userId, peer);
    peer.onsignalingstatechange = () => {
      void flushPendingOffer(userId, peer);
    };

    peer.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      if (event.track.kind === 'audio') {
        const source = stream.getVideoTracks().length ? 'screen' : 'mic';
        attachRemoteAudio(userId, stream, source);
      } else if (event.track.kind === 'video') {
        attachRemoteScreen(userId, stream);
      }
    };

    return peer;
  }

  function handlePeerConnectionState(userId: string, peer: RTCPeerConnection) {
    const state = peer.connectionState === 'new' ? peer.iceConnectionState : peer.connectionState;
    peerStates[userId] = state;

    if (isPeerHealthy(peer)) {
      clearPeerRecovery(userId);
      peerRecoveryAttempts.delete(userId);
      if (status.value === 'Reconnecting voice...') {
        status.value = 'Microphone is on.';
      }
      return;
    }

    if (state === 'disconnected' || state === 'failed') {
      schedulePeerRecovery(userId, peer, state === 'failed' ? 0 : 10_000);
    }
  }

  function schedulePeerRecovery(userId: string, peer: RTCPeerConnection, delay: number) {
    if (intentionallyClosed() || peerRecoveryTimers.has(userId)) {
      return;
    }

    if (delay === 0) {
      status.value = 'Reconnecting voice...';
    }
    const timer = window.setTimeout(() => {
      peerRecoveryTimers.delete(userId);
      if (intentionallyClosed() || peer.connectionState === 'closed') {
        return;
      }
      if (isPeerHealthy(peer)) {
        return;
      }
      status.value = 'Reconnecting voice...';
      void recoverPeer(userId, peer);
    }, delay);
    peerRecoveryTimers.set(userId, timer);
  }

  async function recoverPeer(userId: string, peer: RTCPeerConnection) {
    const attempts = (peerRecoveryAttempts.get(userId) ?? 0) + 1;
    peerRecoveryAttempts.set(userId, attempts);

    if (attempts >= 2) {
      await rebuildPeer(userId);
      return;
    }

    if (!getSocketOpen() || peer.signalingState !== 'stable') {
      schedulePeerRecovery(userId, peer, 3000);
      return;
    }

    await requestPeerOffer(userId, peer, { iceRestart: true });

    if (!isPeerHealthy(peer)) {
      schedulePeerRecovery(userId, peer, 5000);
    }
  }

  async function rebuildPeer(userId: string) {
    if (intentionallyClosed() || !getSocketOpen() || !getUsers().includes(userId)) {
      return;
    }

    closePeer(userId);
    peerRecoveryAttempts.delete(userId);
    status.value = 'Reconnecting voice...';
    await ensurePeer(userId, shouldInitiatePeerRecovery(userId));
  }

  function shouldInitiatePeerRecovery(userId: string) {
    return currentUserId.value.localeCompare(userId) > 0;
  }

  function isPolitePeer(userId: string) {
    return currentUserId.value.localeCompare(userId) > 0;
  }

  function isPeerHealthy(peer: RTCPeerConnection) {
    return peer.connectionState === 'connected' || peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed';
  }

  function setupPeerHeartbeat(userId: string, channel: RTCDataChannel) {
    const existing = peerHeartbeats.get(userId);
    if (existing?.channel === channel) {
      return;
    }
    clearPeerHeartbeat(userId);

    peerHeartbeats.set(userId, { channel, lastSeen: performance.now() });
    channel.addEventListener('message', (event) => handlePeerHeartbeatMessage(userId, channel, event));
    channel.addEventListener('open', () => startPeerHeartbeat(userId, channel));
    channel.addEventListener('close', () => {
      if (peerHeartbeats.get(userId)?.channel === channel) {
        clearPeerHeartbeat(userId);
      }
    });

    if (channel.readyState === 'open') {
      startPeerHeartbeat(userId, channel);
    }
  }

  function startPeerHeartbeat(userId: string, channel: RTCDataChannel) {
    const heartbeat = peerHeartbeats.get(userId);
    if (!heartbeat || heartbeat.channel !== channel || heartbeat.timer) {
      return;
    }

    heartbeat.timer = window.setInterval(() => {
      if (channel.readyState !== 'open') {
        clearPeerHeartbeat(userId);
        return;
      }
      const staleFor = performance.now() - heartbeat.lastSeen;
      if (staleFor > 120_000) {
        clearPeerHeartbeat(userId);
        return;
      }
      channel.send('ping');
    }, 10_000);
  }

  function handlePeerHeartbeatMessage(userId: string, channel: RTCDataChannel, event: MessageEvent) {
    const heartbeat = peerHeartbeats.get(userId);
    if (!heartbeat || heartbeat.channel !== channel) {
      return;
    }

    heartbeat.lastSeen = performance.now();
    if (event.data === 'ping' && channel.readyState === 'open') {
      channel.send('pong');
    }
  }

  function clearPeerHeartbeat(userId: string) {
    const heartbeat = peerHeartbeats.get(userId);
    if (!heartbeat) {
      return;
    }
    if (heartbeat.timer) {
      window.clearInterval(heartbeat.timer);
    }
    peerHeartbeats.delete(userId);
  }

  function clearPeerRecovery(userId: string) {
    const timer = peerRecoveryTimers.get(userId);
    if (!timer) {
      return;
    }
    window.clearTimeout(timer);
    peerRecoveryTimers.delete(userId);
  }

  function scheduleRemoteTrackRecovery(userId: string, source: 'mic' | 'screen') {
    const key = remoteTrackRecoveryKey(userId, source);
    if (remoteTrackRecoveryTimers.has(key)) {
      return;
    }

    const timer = window.setTimeout(() => {
      remoteTrackRecoveryTimers.delete(key);
      const peer = peers.get(userId);
      if (peer && !intentionallyClosed()) {
        schedulePeerRecovery(userId, peer, 0);
      }
    }, 8_000);
    remoteTrackRecoveryTimers.set(key, timer);
  }

  function clearRemoteTrackRecovery(userId: string, source?: 'mic' | 'screen') {
    for (const [key, timer] of remoteTrackRecoveryTimers) {
      if (key === remoteTrackRecoveryKey(userId, source ?? 'mic') || key === remoteTrackRecoveryKey(userId, source ?? 'screen')) {
        window.clearTimeout(timer);
        remoteTrackRecoveryTimers.delete(key);
      }
    }
  }

  function remoteTrackRecoveryKey(userId: string, source: 'mic' | 'screen') {
    return `${userId}:${source}`;
  }

  async function receiveOffer(userId: string, offer: RTCSessionDescriptionInit) {
    const peer = await ensurePeer(userId, false);
    const offerCollision = makingOffers.has(userId) || peer.signalingState !== 'stable';
    if (offerCollision && !isPolitePeer(userId)) {
      ignoredOfferUsers.add(userId);
      return;
    }

    ignoredOfferUsers.delete(userId);
    if (offerCollision) {
      pendingOffers.set(userId, mergeOfferOptions(pendingOffers.get(userId), undefined));
      await peer.setLocalDescription({ type: 'rollback' }).catch(() => undefined);
    }

    await peer.setRemoteDescription(offer).catch(() => undefined);
    const remoteOfferState = peer.signalingState as string;
    if (remoteOfferState !== 'have-remote-offer') {
      return;
    }
    await flushQueuedCandidates(userId, peer);

    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer).catch(() => undefined);
    const answeredState = peer.signalingState as string;
    if (answeredState !== 'stable') {
      return;
    }
    sendSignal({
      type: 'answer',
      roomId: roomId(),
      userId: currentUserId.value,
      targetUserId: userId,
      payload: answer,
    });
    await flushPendingOffer(userId, peer);
    await flushQueuedScreenShareOffer(userId);
  }

  async function receiveCandidate(userId: string, candidate: RTCIceCandidateInit) {
    if (ignoredOfferUsers.has(userId)) {
      return;
    }

    const peer = peers.get(userId);
    if (!peer || !peer.remoteDescription) {
      const queued = queuedCandidates.get(userId) ?? [];
      queued.push(candidate);
      queuedCandidates.set(userId, queued);
      return;
    }
    await peer.addIceCandidate(candidate).catch(() => undefined);
  }

  async function flushQueuedCandidates(userId: string, peer: RTCPeerConnection) {
    const queued = queuedCandidates.get(userId) ?? [];
    queuedCandidates.delete(userId);
    for (const candidate of queued) {
      await peer.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  function attachRemoteAudio(userId: string, stream: MediaStream | undefined, source: 'mic' | 'screen') {
    const host = remoteAudio.value;
    if (!host || !stream) {
      return;
    }

    const existing = host.querySelector(`[data-user-id="${userId}"][data-source="${source}"]`) as HTMLAudioElement | null;
    if (existing) {
      if (existing.srcObject !== stream) {
        existing.srcObject = stream;
        attachRemoteTrackRecovery(userId, stream, source, existing);
        if (source === 'mic') {
          startSpeakingDetection(userId, stream);
        }
      }
      startRemoteAudioPlayback(userId, source, existing);
      updateRemoteAudioSettings();
      return;
    }

    const audio = document.createElement('audio');
    audio.dataset.userId = userId;
    audio.dataset.source = source;
    audio.autoplay = true;
    audio.volume = getRemoteElementVolume(audio);
    audio.srcObject = stream;
    host.appendChild(audio);
    if (source === 'mic') {
      startSpeakingDetection(userId, stream);
    }
    attachRemoteTrackRecovery(userId, stream, source, audio);
    startRemoteAudioPlayback(userId, source, audio);
    updateRemoteAudioSettings();
  }

  function attachRemoteTrackRecovery(userId: string, stream: MediaStream, source: 'mic' | 'screen', audio: HTMLAudioElement) {
    stream.getTracks().forEach((track) => {
      track.addEventListener('mute', () => scheduleRemoteTrackRecovery(userId, source));
      track.addEventListener('unmute', () => clearRemoteTrackRecovery(userId, source));
      track.addEventListener('ended', () => {
        clearRemoteTrackRecovery(userId, source);
        audio.remove();
        if (source === 'mic') {
          stopSpeakingDetection(userId);
        }
      });
    });
  }

  function startRemoteAudioPlayback(userId: string, source: 'mic' | 'screen', audio: HTMLAudioElement) {
    const tryPlay = () => {
      if (!audio.isConnected) {
        return;
      }
      void audio.play().then(
        () => clearRemoteTrackRecovery(userId, source),
        () => undefined,
      );
    };

    audio.addEventListener('canplay', tryPlay, { once: true });
    tryPlay();
  }

  async function addSender(peer: RTCPeerConnection, track: MediaStreamTrack, stream: MediaStream, source: SenderSource) {
    const sender = peer.addTrack(track, stream);
    senderSources.set(sender, source);
    await configureSender(sender, track, source);
    return sender;
  }

  async function configureSender(sender: RTCRtpSender, track: MediaStreamTrack, source: SenderSource) {
    if (source !== 'screen') {
      return;
    }
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];

    if (track.kind === 'video') {
      const profile = getScreenShareProfile();
      parameters.degradationPreference = profile.degradationPreference;
      parameters.encodings[0] = {
        ...parameters.encodings[0],
        maxBitrate: profile.maxBitrate,
        maxFramerate: profile.fps,
        scaleResolutionDownBy: 1,
      };
    } else if (track.kind === 'audio' && source === 'screen') {
      parameters.encodings[0] = {
        ...parameters.encodings[0],
        maxBitrate: 128_000,
      };
    }

    try {
      await sender.setParameters(parameters);
    } catch {
      if (track.readyState === 'live' && !intentionallyClosed()) {
        error.value = 'Screen sharing is active, but the selected streaming quality could not be applied.';
      }
    }
  }

  function closePeer(userId: string) {
    clearPeerRecovery(userId);
    clearPeerHeartbeat(userId);
    clearQueuedScreenShareOffer(userId);
    peers.get(userId)?.close();
    peers.delete(userId);
    queuedCandidates.delete(userId);
    makingOffers.delete(userId);
    pendingOffers.delete(userId);
    ignoredOfferUsers.delete(userId);
    peerRecoveryAttempts.delete(userId);
    clearRemoteTrackRecovery(userId);
    delete peerStates[userId];
    delete memberVolumes[userId];
    delete screenVolumes[userId];
    delete speakingUsers[userId];
    stopSpeakingDetection(userId);
    removeRemoteScreen(userId);
    remoteAudio.value?.querySelectorAll(`[data-user-id="${userId}"]`).forEach((element) => element.remove());
  }

  function clearQueuedScreenShareOffer(userId: string) {
    const timer = queuedScreenShareOfferTimers.get(userId);
    if (timer) {
      window.clearTimeout(timer);
    }
    queuedScreenShareOfferTimers.delete(userId);
    queuedScreenShareOffers.delete(userId);
  }

  function hasLiveScreenStream() {
    return getScreenStream()?.getTracks().some((track) => track.readyState === 'live') ?? false;
  }

  function closeAllPeers() {
    for (const userId of peers.keys()) {
      closePeer(userId);
    }
  }

  return {
    clearRemoteTrackRecovery,
    closeAllPeers,
    closePeer,
    configureSender,
    ensurePeer,
    peers,
    queueScreenShareOffer,
    receiveAnswer,
    receiveCandidate,
    receiveOffer,
    requestPeerOffer,
    senderSources,
  };
}
