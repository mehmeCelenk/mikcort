import type { ComputedRef, Ref } from 'vue';
import type { SenderSource, SignalMessage } from './types';
import type { ScreenShareProfile } from './screenShareQuality';
import { connectionErrorDetails, peerDiagnosticId, recordConnectionEvent } from './connectionDiagnostics';

type PeerDescription = RTCSessionDescriptionInit & { sessionId?: string; offerId?: string };
type PeerCandidate = RTCIceCandidateInit & { sessionId?: string };

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
  const queuedCandidates = new Map<string, PeerCandidate[]>();
  const sessions = new WeakMap<RTCPeerConnection, string>();
  const outstandingOffers = new WeakMap<RTCPeerConnection, string>();
  const retiredSessions = new Map<string, Set<string>>();
  const operations = new Map<string, Promise<unknown>>();
  const monitors = new Map<string, number>();
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

  function diagnostic(userId: string, event: string, details: Record<string, unknown> = {}) {
    const peer = peers.get(userId);
    recordConnectionEvent(event, { peer: peerDiagnosticId(userId), session: peer ? sessions.get(peer) : undefined, connection: peer?.connectionState,
      ice: peer?.iceConnectionState, signaling: peer?.signalingState, ...details });
  }

  function isCurrent(userId: string, peer: RTCPeerConnection) {
    return !intentionallyClosed() && peers.get(userId) === peer && peer.signalingState !== 'closed';
  }

  // SDP and ICE operations must not overlap with an offer/answer or rollback.
  function serialize<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const next = (operations.get(userId) ?? Promise.resolve()).catch(() => {}).then(operation);
    operations.set(userId, next);
    void next.finally(() => {
      if (operations.get(userId) === next) operations.delete(userId);
    }).catch(() => {});
    return next;
  }

  function retireSession(userId: string, sessionId: string) {
    const retired = retiredSessions.get(userId) ?? new Set<string>();
    retired.add(sessionId);
    if (retired.size > 32) retired.delete(retired.values().next().value!);
    retiredSessions.set(userId, retired);
  }

  async function ensurePeer(userId: string, makeOffer: boolean) {
    let peer = peers.get(userId);
    if (peer?.signalingState === 'closed' || peer?.connectionState === 'closed') {
      closePeer(userId);
      peer = undefined;
    }
    if (!peer) {
      peer = createPeer(userId);
      peers.set(userId, peer);
      startPeerMonitor(userId, peer);
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
    const offerSent = await serialize(userId, () => sendOffer(userId, peer, options));
    if (!offerSent && isCurrent(userId, peer)) {
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

  async function receiveAnswer(userId: string, answer: PeerDescription) {
    await serialize(userId, async () => {
      const peer = peers.get(userId);
      if (!peer || !isCurrent(userId, peer) || peer.signalingState !== 'have-local-offer') return;
      if ((answer.sessionId && answer.sessionId !== sessions.get(peer)) ||
          (answer.offerId && answer.offerId !== outstandingOffers.get(peer))) {
        diagnostic(userId, 'stale-answer');
        return;
      }
      try {
        await peer.setRemoteDescription(answer);
        if (!isCurrent(userId, peer)) return;
        outstandingOffers.delete(peer);
        ignoredOfferUsers.delete(userId);
        diagnostic(userId, 'answer-received');
        await flushQueuedCandidates(userId, peer);
      } catch (cause) { signalFailure(userId, peer, 'answer-error', cause); }
    });
    const peer = peers.get(userId);
    if (peer) await flushPendingOffer(userId, peer);
  }

  async function flushPendingOffer(userId: string, peer: RTCPeerConnection) {
    if (!isCurrent(userId, peer) || peer.signalingState !== 'stable' || !getSocketOpen() || !pendingOffers.has(userId)) {
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
    if (!isCurrent(userId, peer) || !getSocketOpen() || makingOffers.has(userId) || peer.signalingState !== 'stable') {
      return false;
    }

    makingOffers.add(userId);
    try {
      const offer = await peer.createOffer(options);
      if (!isCurrent(userId, peer) || peer.signalingState !== 'stable' || !getSocketOpen()) {
        return false;
      }

      await peer.setLocalDescription(offer);
      if (!isCurrent(userId, peer)) return false;
      const offerId = crypto.randomUUID();
      outstandingOffers.set(peer, offerId);
      sendSignal({
        type: 'offer',
        roomId: roomId(),
        userId: currentUserId.value,
        targetUserId: userId,
        payload: { ...offer, sessionId: sessions.get(peer), offerId },
      });
      diagnostic(userId, 'offer-sent', { iceRestart: !!options?.iceRestart });
      return true;
    } catch (cause) {
      signalFailure(userId, peer, 'offer-error', cause);
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
    sessions.set(peer, crypto.randomUUID());

    // Either endpoint may send the initial offer, so both need an SCTP section.
    // Every channel answers pings; only one drives the local watchdog.
    setupPeerHeartbeat(userId, peer, peer.createDataChannel('heartbeat', { ordered: false, maxRetransmits: 0 }));
    peer.ondatachannel = (event) => {
      if (isCurrent(userId, peer) && event.channel.label === 'heartbeat') {
        setupPeerHeartbeat(userId, peer, event.channel);
      }
    };

    peerStates[userId] = 'new';

    peer.onicecandidate = (event) => {
      if (event.candidate && isCurrent(userId, peer)) {
        sendSignal({
          type: 'ice-candidate',
          roomId: roomId(),
          userId: currentUserId.value,
          targetUserId: userId,
          payload: { ...event.candidate.toJSON(), sessionId: sessions.get(peer) },
        });
      }
    };

    peer.onconnectionstatechange = () => handlePeerConnectionState(userId, peer);
    peer.oniceconnectionstatechange = () => handlePeerConnectionState(userId, peer);
    peer.onicecandidateerror = (event) => {
      if (isCurrent(userId, peer)) diagnostic(userId, 'ice-candidate-error', { code: event.errorCode });
    };

    peer.ontrack = (event) => {
      if (!isCurrent(userId, peer)) return;
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
    if (!isCurrent(userId, peer)) return;
    const state = [peer.connectionState, peer.iceConnectionState].includes('failed') ? 'failed'
      : [peer.connectionState, peer.iceConnectionState].includes('disconnected') ? 'disconnected'
      : peer.connectionState === 'new' ? peer.iceConnectionState : peer.connectionState;
    peerStates[userId] = state;
    diagnostic(userId, 'peer-state');

    if (isPeerHealthy(peer) && !microphoneTrackStalled(userId)) {
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

  function schedulePeerRecovery(userId: string, peer: RTCPeerConnection, delay: number, force = false) {
    if (!isCurrent(userId, peer) || peerRecoveryTimers.has(userId)) {
      return;
    }

    if (delay === 0) {
      status.value = 'Reconnecting voice...';
    }
    const timer = window.setTimeout(() => {
      peerRecoveryTimers.delete(userId);
      if (!isCurrent(userId, peer)) {
        return;
      }
      if (!force && isPeerHealthy(peer)) {
        return;
      }
      status.value = 'Reconnecting voice...';
      void serialize(userId, () => recoverPeer(userId, peer)).catch((cause) => {
        signalFailure(userId, peer, 'recovery-error', cause);
      });
    }, delay);
    peerRecoveryTimers.set(userId, timer);
  }

  async function recoverPeer(userId: string, peer: RTCPeerConnection) {
    if (!isCurrent(userId, peer) || !getUsers().includes(userId)) return;
    // Waiting for signaling is not a failed recovery attempt.
    if (!getSocketOpen()) {
      diagnostic(userId, 'recovery-waiting-for-signaling');
      schedulePeerRecovery(userId, peer, 3000, true);
      return;
    }
    const attempts = (peerRecoveryAttempts.get(userId) ?? 0) + 1;
    peerRecoveryAttempts.set(userId, attempts);
    diagnostic(userId, 'recovery-start', { attempts });

    if (attempts >= 3 || peer.signalingState === 'have-remote-offer') {
      await rebuildPeer(userId);
      return;
    }

    if (peer.signalingState === 'have-local-offer') {
      // A lost answer must not leave the peer permanently waiting for it.
      await peer.setLocalDescription({ type: 'rollback' });
    }
    if (!isCurrent(userId, peer)) return;
    peer.restartIce();
    await sendOffer(userId, peer, { iceRestart: true });

    if (!isPeerHealthy(peer)) {
      schedulePeerRecovery(userId, peer, 15_000);
    }
  }

  async function rebuildPeer(userId: string) {
    if (intentionallyClosed() || !getSocketOpen() || !getUsers().includes(userId)) {
      return;
    }

    diagnostic(userId, 'peer-rebuild');
    closePeer(userId, true);
    status.value = 'Reconnecting voice...';
    // Either endpoint can initiate. The session ID tells the other endpoint to
    // replace its transport too; polite/impolite roles resolve simultaneous offers.
    const peer = await ensurePeer(userId, false);
    await sendOffer(userId, peer);
    schedulePeerRecovery(userId, peer, 20_000);
  }

  function isPolitePeer(userId: string) {
    return currentUserId.value > userId;
  }

  function isPeerHealthy(peer: RTCPeerConnection) {
    return peer.connectionState === 'connected' && (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed');
  }

  function microphoneTrackStalled(userId: string) {
    const audio = remoteAudio.value?.querySelector(`[data-user-id="${userId}"][data-source="mic"]`) as HTMLAudioElement | null;
    const stream = audio?.srcObject as MediaStream | null;
    return stream?.getAudioTracks().some((track) => track.muted || track.readyState === 'ended') ?? false;
  }

  function signalFailure(userId: string, peer: RTCPeerConnection, event: string, cause: unknown) {
    if (!isCurrent(userId, peer)) return;
    diagnostic(userId, event, connectionErrorDetails(cause));
    schedulePeerRecovery(userId, peer, 3000, true);
  }

  function startPeerMonitor(userId: string, peer: RTCPeerConnection) {
    let lastProgress = performance.now();
    let lastSignalingState = peer.signalingState;
    let signalingSince = lastProgress;
    let sampling = false;
    let sampleCount = 0;
    let previousPackets = -1;
    let stalledSince = lastProgress;
    let mutedSince = lastProgress;
    const timer = window.setInterval(async () => {
      if (!isCurrent(userId, peer) || sampling) return;
      const now = performance.now();
      if (peer.signalingState !== lastSignalingState) {
        lastSignalingState = peer.signalingState;
        signalingSince = now;
      }
      if (isPeerHealthy(peer)) lastProgress = now;
      if (!microphoneTrackStalled(userId)) mutedSince = now;
      else if (now - mutedSince > 15_000) {
        diagnostic(userId, 'microphone-track-stalled');
        schedulePeerRecovery(userId, peer, 0, true);
        mutedSince = now;
      }
      if (now - lastProgress > 20_000 || (peer.signalingState !== 'stable' && now - signalingSince > 20_000)) {
        diagnostic(userId, 'connection-timeout');
        schedulePeerRecovery(userId, peer, 0, true);
        lastProgress = signalingSince = now;
      }
      if (getSocketOpen() && peer.signalingState === 'stable' && pendingOffers.has(userId)) {
        void flushPendingOffer(userId, peer);
      }
      sampling = true;
      try {
        const stats = await peer.getStats();
        if (!isCurrent(userId, peer)) return;
        const audio: Record<string, unknown>[] = [];
        let packets = 0;
        let hasInbound = false;
        let selectedPair: Record<string, unknown> | undefined;
        stats.forEach((report) => {
          if ((report.type === 'inbound-rtp' || report.type === 'outbound-rtp') && report.kind === 'audio') {
            audio.push({ direction: report.type, packetsReceived: report.packetsReceived, packetsSent: report.packetsSent,
              packetsLost: report.packetsLost, bytesReceived: report.bytesReceived, bytesSent: report.bytesSent, jitter: report.jitter });
            if (report.type === 'inbound-rtp') { hasInbound = true; packets += report.packetsReceived ?? 0; }
          }
          if (report.type === 'transport' && report.selectedCandidatePairId) {
            const pair = stats.get(report.selectedCandidatePairId);
            if (pair) selectedPair = { state: pair.state, rtt: pair.currentRoundTripTime,
              bytesSent: pair.bytesSent, bytesReceived: pair.bytesReceived,
              localType: stats.get(pair.localCandidateId)?.candidateType,
              remoteType: stats.get(pair.remoteCandidateId)?.candidateType,
              protocol: stats.get(pair.localCandidateId)?.protocol };
          }
        });
        if (packets !== previousPackets) { previousPackets = packets; stalledSince = now; }
        // Packet silence alone can be DTX/mute. Log it, but don't tear down a
        // working call without a transport/track/heartbeat failure as well.
        if (++sampleCount % 2 === 0) diagnostic(userId, 'peer-stats', {
          audio, selectedPair, inboundStalledMs: hasInbound ? Math.round(now - stalledSince) : undefined,
          tracks: peer.getReceivers().map(({ track }) => ({ kind: track.kind, muted: track.muted, state: track.readyState })),
          senders: peer.getSenders().map(({ track }) => ({ kind: track?.kind, enabled: track?.enabled, state: track?.readyState })),
          playback: Array.from(remoteAudio.value?.querySelectorAll<HTMLAudioElement>(`[data-user-id="${userId}"]`) ?? [])
            .map((element) => ({ source: element.dataset.source, paused: element.paused, muted: element.muted,
              volume: element.volume, readyState: element.readyState })),
        });
      } catch (cause) { diagnostic(userId, 'stats-error', connectionErrorDetails(cause)); }
      finally { sampling = false; }
    }, 5000);
    monitors.set(userId, timer);
  }

  function setupPeerHeartbeat(userId: string, peer: RTCPeerConnection, channel: RTCDataChannel) {
    const existing = peerHeartbeats.get(userId);
    if (existing?.channel === channel) {
      return;
    }
    clearPeerHeartbeat(userId);

    peerHeartbeats.set(userId, { channel, lastSeen: performance.now() });
    channel.addEventListener('message', (event) => {
      if (!isCurrent(userId, peer)) return;
      // Respond on every incoming channel, including one from an older client
      // which also created a channel. Only one channel drives our watchdog.
      if (event.data === 'ping' && channel.readyState === 'open') {
        try { channel.send('pong'); } catch (cause) { diagnostic(userId, 'heartbeat-send-error', connectionErrorDetails(cause)); }
      }
      if (peerHeartbeats.get(userId)?.channel === channel) handlePeerHeartbeatMessage(userId, channel, event);
    });
    channel.addEventListener('open', () => startPeerHeartbeat(userId, channel));
    channel.addEventListener('close', () => {
      if (peerHeartbeats.get(userId)?.channel === channel) {
        clearPeerHeartbeat(userId);
        if (isCurrent(userId, peer)) {
          diagnostic(userId, 'heartbeat-closed');
          peerRecoveryAttempts.set(userId, 2);
          schedulePeerRecovery(userId, peer, 10_000, true);
        }
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
      if (staleFor > 40_000) {
        diagnostic(userId, 'heartbeat-timeout', { staleFor: Math.round(staleFor) });
        const peer = peers.get(userId);
        if (peer) schedulePeerRecovery(userId, peer, 0, true);
        heartbeat.lastSeen = performance.now();
      }
      try { channel.send('ping'); } catch (cause) { diagnostic(userId, 'heartbeat-send-error', connectionErrorDetails(cause)); }
    }, 10_000);
  }

  function handlePeerHeartbeatMessage(userId: string, channel: RTCDataChannel, event: MessageEvent) {
    const heartbeat = peerHeartbeats.get(userId);
    if (!heartbeat || heartbeat.channel !== channel) {
      return;
    }

    if (event.data === 'ping' || event.data === 'pong') heartbeat.lastSeen = performance.now();
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
    const peer = peers.get(userId);
    if (!peer) return;
    const key = remoteTrackRecoveryKey(userId, source);
    if (remoteTrackRecoveryTimers.has(key)) {
      return;
    }

    const timer = window.setTimeout(() => {
      remoteTrackRecoveryTimers.delete(key);
      if (isCurrent(userId, peer)) {
        diagnostic(userId, 'remote-track-timeout', { source });
        // Stopping screen sharing can intentionally mute its remote track.
        if (source === 'mic') schedulePeerRecovery(userId, peer, 0, true);
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

  async function receiveOffer(userId: string, offer: PeerDescription) {
    await serialize(userId, async () => {
      if (intentionallyClosed() || !getUsers().includes(userId)) return;
      if (offer.sessionId && retiredSessions.get(userId)?.has(offer.sessionId)) {
        diagnostic(userId, 'stale-offer');
        return;
      }
      let peer = await ensurePeer(userId, false);
      if (!isCurrent(userId, peer)) return;
      const offerCollision = makingOffers.has(userId) || peer.signalingState !== 'stable';
      if (offerCollision && !isPolitePeer(userId)) {
        ignoredOfferUsers.add(userId);
        diagnostic(userId, 'offer-collision-ignored');
        return;
      }
      try {
        if (offer.sessionId && offer.sessionId !== sessions.get(peer)) {
          // Reset both ends of a rebuilt transport, not just the endpoint that
          // noticed the failure. Keep candidates that arrived before this offer.
          const candidates = (queuedCandidates.get(userId) ?? []).filter((item) => item.sessionId === offer.sessionId);
          if (peer.localDescription || peer.remoteDescription) {
            closePeer(userId, true);
            peer = await ensurePeer(userId, false);
          } else {
            retireSession(userId, sessions.get(peer)!);
          }
          sessions.set(peer, offer.sessionId);
          queuedCandidates.set(userId, candidates);
        } else if (offerCollision) {
          pendingOffers.set(userId, mergeOfferOptions(pendingOffers.get(userId), undefined));
          await peer.setLocalDescription({ type: 'rollback' });
        }
        ignoredOfferUsers.delete(userId);
        outstandingOffers.delete(peer);
        await peer.setRemoteDescription(offer);
        if (!isCurrent(userId, peer)) return;
        await flushQueuedCandidates(userId, peer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        if (!isCurrent(userId, peer)) return;
        sendSignal({ type: 'answer', roomId: roomId(), userId: currentUserId.value, targetUserId: userId,
          payload: { ...answer, sessionId: offer.sessionId, offerId: offer.offerId } });
        diagnostic(userId, 'offer-answered', { collision: offerCollision });
      } catch (cause) { signalFailure(userId, peer, 'remote-offer-error', cause); }
    });
    const peer = peers.get(userId);
    if (peer) await flushPendingOffer(userId, peer);
    await flushQueuedScreenShareOffer(userId);
  }

  async function receiveCandidate(userId: string, candidate: PeerCandidate) {
    await serialize(userId, async () => {
      if (intentionallyClosed() || !getUsers().includes(userId)) return;
      if (candidate.sessionId && retiredSessions.get(userId)?.has(candidate.sessionId)) return;
      if (!candidate.sessionId && ignoredOfferUsers.has(userId)) return;
      const peer = peers.get(userId);
      if (!peer || !peer.remoteDescription || (candidate.sessionId && candidate.sessionId !== sessions.get(peer))) {
        const queued = queuedCandidates.get(userId) ?? [];
        queued.push(candidate);
        queuedCandidates.set(userId, queued.slice(-128));
        return;
      }
      await addCandidate(userId, peer, candidate);
    });
  }

  async function addCandidate(userId: string, peer: RTCPeerConnection, candidate: PeerCandidate) {
    if (!isCurrent(userId, peer)) return;
    // ICE restarts share a session but have new ICE credentials. Late candidates
    // for an old offer must not be applied to the new negotiation.
    if (candidate.usernameFragment && !peer.remoteDescription?.sdp.split(/\r?\n/).includes(`a=ice-ufrag:${candidate.usernameFragment}`)) {
      // A candidate may beat its restart offer over signaling. Keep it until
      // that description arrives; the bounded queue also tolerates stale ICE.
      const queued = queuedCandidates.get(userId) ?? [];
      queuedCandidates.set(userId, [...queued, candidate].slice(-128));
      return;
    }
    try { await peer.addIceCandidate(candidate); }
    catch (cause) { diagnostic(userId, 'ice-candidate-rejected', connectionErrorDetails(cause)); }
  }

  async function flushQueuedCandidates(userId: string, peer: RTCPeerConnection) {
    const queued = queuedCandidates.get(userId) ?? [];
    queuedCandidates.delete(userId);
    for (const candidate of queued) {
      if (!candidate.sessionId || candidate.sessionId === sessions.get(peer)) await addCandidate(userId, peer, candidate);
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
    const peer = peers.get(userId);
    const active = () => !!peer && isCurrent(userId, peer) && audio.srcObject === stream && audio.isConnected;
    stream.getTracks().forEach((track) => {
      track.addEventListener('mute', () => {
        if (active()) { diagnostic(userId, 'remote-track-muted', { source }); scheduleRemoteTrackRecovery(userId, source); }
      });
      track.addEventListener('unmute', () => { if (active()) clearRemoteTrackRecovery(userId, source); });
      track.addEventListener('ended', () => {
        if (!active()) return;
        diagnostic(userId, 'remote-track-ended', { source });
        clearRemoteTrackRecovery(userId, source);
        audio.remove();
        if (source === 'mic') {
          stopSpeakingDetection(userId);
          peerRecoveryAttempts.set(userId, 2);
          schedulePeerRecovery(userId, peer!, 3000, true);
        }
      });
      if (track.muted) scheduleRemoteTrackRecovery(userId, source);
    });
  }

  function startRemoteAudioPlayback(userId: string, source: 'mic' | 'screen', audio: HTMLAudioElement) {
    const tryPlay = () => {
      if (!audio.isConnected) {
        return;
      }
      void audio.play().then(
        () => {
          const stream = audio.srcObject as MediaStream | null;
          if (stream?.getAudioTracks().every((track) => !track.muted)) clearRemoteTrackRecovery(userId, source);
        },
        (cause) => diagnostic(userId, 'audio-playback-error', { source, ...connectionErrorDetails(cause) }),
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

  function closePeer(userId: string, preserveSettings = false) {
    clearPeerRecovery(userId);
    clearPeerHeartbeat(userId);
    clearQueuedScreenShareOffer(userId);
    const peer = peers.get(userId);
    peers.delete(userId);
    if (peer) {
      retireSession(userId, sessions.get(peer)!);
      peer.close();
    }
    window.clearInterval(monitors.get(userId));
    monitors.delete(userId);
    queuedCandidates.delete(userId);
    makingOffers.delete(userId);
    pendingOffers.delete(userId);
    ignoredOfferUsers.delete(userId);
    peerRecoveryAttempts.delete(userId);
    clearRemoteTrackRecovery(userId);
    delete peerStates[userId];
    if (!preserveSettings) {
      delete memberVolumes[userId];
      delete screenVolumes[userId];
    }
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
