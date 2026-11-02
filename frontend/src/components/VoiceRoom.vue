<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch, type ComponentPublicInstance } from 'vue';
import {
  Check, Copy, MonitorUp,
  MessageSquare,
} from 'lucide-vue-next';
import { usePersistentNumber, usePersistentString } from '../composables/usePersistentStorage';
import BrandMark from './BrandMark.vue';
import AudioSettingsDrawer from './voice/AudioSettingsDrawer.vue';
import MembersSidebar from './voice/MembersSidebar.vue';
import RoomChatPanel from './voice/RoomChatPanel.vue';
import ScreenShareStage from './voice/ScreenShareStage.vue';
import VoiceDock from './voice/VoiceDock.vue';
import { isTypingTarget, keyboardShortcut } from '../features/voice/keyboard';
import { useRoomChat } from '../features/voice/useRoomChat';
import { useScreenShare } from '../features/voice/useScreenShare';
import { useVoiceAudio } from '../features/voice/useVoiceAudio';
import { useVoicePeers } from '../features/voice/useVoicePeers';
import { screenShareProfile } from '../features/voice/screenShareQuality';
import type {
  ChatPayload,
  ErrorPayload,
  RoomUsersPayload,
  ShortcutAction,
  SignalMessage,
  UserSummary,
} from '../features/voice/types';
import { displayNameForUser, initialsForName, registerUserName, unique } from '../features/voice/users';

const props = defineProps<{
  roomId: string;
  serverUrl: string;
  displayName: string;
  roomPassword: string;
}>();

const emit = defineEmits<{
  left: [];
  joinRejected: [message: string];
}>();

const currentUserId = ref<string>(crypto.randomUUID());
const users = ref<string[]>([]);
const status = ref('Connecting to signaling server...');
const error = ref('');
const settingsOpen = ref(false);
const roomCopied = ref(false);
let copyTimer: number | undefined;
const wsOpen = ref(false);
const remoteAudio = ref<HTMLDivElement | null>(null);
const {
  chatDraft,
  chatLog,
  chatMessages,
  chatOpen,
  unreadChatCount,
  appendChatMessage,
  sendChatMessage,
  toggleChat,
} = useRoomChat({
  roomId: () => props.roomId,
  currentUserId,
  wsOpen,
  sendSignal: send,
});
const selectedScreenFps = usePersistentNumber('mikcort:screen:fps', 30, 30, 60);
const selectedScreenResolution = usePersistentNumber('mikcort:screen:resolution', 1080, 720, 1080);
const muteShortcut = usePersistentString('mikcort:shortcut:mute', '', { removeWhenEmpty: true });
const deafenShortcut = usePersistentString('mikcort:shortcut:deafen', '', { removeWhenEmpty: true });
const capturingShortcut = ref<ShortcutAction | null>(null);
const peerStates = reactive<Record<string, string>>({});
const userNames = reactive<Record<string, string>>({});
const memberVolumes = reactive<Record<string, number>>({});
const screenVolumes = reactive<Record<string, number>>({});
const speakingUsers = reactive<Record<string, boolean>>({});
const activeMemberVolumeUser = ref<string | null>(null);

let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let heartbeatTimer: number | undefined;
let errorTimer: number | undefined;
let intentionallyClosed = false;
const remoteAnalyzers = new Map<string, { context: AudioContext; timer: number }>();
const speakingUntil = new Map<string, number>();
const otherUsers = computed(() => users.value.filter((userId) => userId !== currentUserId.value));
const connectionLabel = computed(() => (wsOpen.value ? 'Connected' : 'Offline'));
const {
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
} = useVoicePeers({
  attachRemoteScreen: (userId, stream) => attachRemoteScreen(userId, stream),
  currentUserId,
  error,
  getLocalStream: () => localStream.value,
  getRemoteElementVolume: (audio) => remoteElementVolume(audio),
  getScreenStream: () => screenStream.value,
  getSocketOpen: () => socket?.readyState === WebSocket.OPEN,
  getUsers: () => users.value,
  intentionallyClosed: () => intentionallyClosed,
  getScreenShareProfile: () => screenShareProfile(selectedScreenResolution.value, selectedScreenFps.value),
  otherUsers,
  peerStates,
  remoteAudio,
  removeRemoteScreen: (userId) => removeRemoteScreen(userId),
  roomId: () => props.roomId,
  sendSignal: send,
  speakingUsers,
  startSpeakingDetection,
  status,
  stopSpeakingDetection,
  updateRemoteAudioSettings: () => updateRemoteAudioSettings(),
  memberVolumes,
  screenVolumes,
});
const {
  autoGainControl,
  deafened,
  echoCancellation,
  inputDevices,
  inputGain,
  inputSensitivity,
  loadDevices,
  localStream,
  micStarted,
  micStarting,
  muted,
  noiseSuppressionMode,
  noiseSuppressionNotice,
  outputDevices,
  outputVolume,
  playVoiceFeedback,
  remoteElementVolume,
  selectedInputId,
  selectedOutputId,
  startMicrophone,
  stopLocalAudio,
  toggleDeafen,
  toggleMute,
  updateMicGain,
  updateRemoteAudioSettings,
  applyAudioSettings,
} = useVoiceAudio({
  configureSender,
  currentUserId,
  ensurePeer,
  error,
  getViewingScreenUser: () => viewingScreenUser.value,
  memberVolumes,
  otherUsers,
  peers,
  remoteAudio,
  screenVolumes,
  senderSources,
  speakingUsers,
  startSpeakingDetection,
  status,
  stopSpeakingDetection,
});
const {
  activeScreenMenuUser,
  attachRemoteScreen,
  fullscreenScreenUser,
  isUserSharingScreen,
  removeRemoteScreen,
  screenShareBadgeLabel,
  screenShareCaptureLabel,
  screenShareMenuOpen,
  screenStream,
  screenStarting,
  setScreenVideoElement,
  sharingScreen,
  startScreenShare,
  stopScreenShare,
  stopViewingScreenShare,
  toggleScreenFullscreen,
  toggleScreenShare,
  toggleScreenShareView,
  viewedScreenUserId,
  viewingScreenUser,
} = useScreenShare({
  activeMemberVolumeUser,
  clearRemoteTrackRecovery,
  currentUserId,
  error,
  micStarted,
  otherUsers,
  peers,
  playVoiceFeedback,
  remoteAudio,
  requestPeerOffer,
  screenVolumes,
  selectedScreenFps,
  selectedScreenResolution,
  senderSources,
  status,
  updateRemoteAudioSettings,
  ensurePeer,
});
const voiceState = computed(() => {
  if (!micStarted.value) {
    return micStarting.value ? 'Opening microphone…' : 'Microphone off';
  }
  return muted.value ? 'Microphone muted' : 'Microphone on';
});

onMounted(() => {
  connect();
  void startMicrophone();
  void loadDevices();
  window.addEventListener('keydown', handleKeydown);
  navigator.mediaDevices?.addEventListener('devicechange', loadDevices);
});
onBeforeUnmount(cleanup);

watch(error, (message) => {
  clearErrorTimer();
  if (!message) {
    return;
  }
  errorTimer = window.setTimeout(() => {
    error.value = '';
    errorTimer = undefined;
  }, 2000);
});

function connect() {
  clearReconnectTimer();
  clearHeartbeat();
  intentionallyClosed = false;
  socket = new WebSocket(props.serverUrl);

  socket.addEventListener('open', () => {
    wsOpen.value = true;
    error.value = '';
    status.value = micStarted.value ? 'Microphone is on.' : 'Joined room. Microphone is opening...';
    startHeartbeat();
    send({
      type: 'join-room',
      roomId: props.roomId,
      userId: currentUserId.value,
      payload: {
        displayName: props.displayName,
        password: props.roomPassword.trim() || undefined,
      },
    });
  });

  socket.addEventListener('message', (event: MessageEvent<string>) => {
    try {
      void handleSignal(JSON.parse(event.data) as SignalMessage);
    } catch {
      error.value = 'Received invalid signaling message.';
    }
  });

  socket.addEventListener('close', () => {
    clearHeartbeat();
    wsOpen.value = false;
    status.value = 'Disconnected from signaling server. Reconnecting...';
    if (!intentionallyClosed) {
      scheduleReconnect();
    }
  });

  socket.addEventListener('error', () => {
    error.value = 'Could not connect to the signaling server.';
  });
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectTimer = window.setTimeout(() => {
    connect();
  }, 1500);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
}

function startHeartbeat() {
  clearHeartbeat();
  heartbeatTimer = window.setInterval(() => {
    send({ type: 'ping', roomId: props.roomId, userId: currentUserId.value });
  }, 20_000);
}

function clearHeartbeat() {
  if (heartbeatTimer) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

function clearErrorTimer() {
  if (errorTimer) {
    window.clearTimeout(errorTimer);
    errorTimer = undefined;
  }
}

function leave() {
  cleanup();
  emit('left');
}

async function handleSignal(message: SignalMessage) {
  switch (message.type) {
    case 'room-users': {
      const payload = message.payload as RoomUsersPayload;
      if (message.userId) {
        const previousUserId = currentUserId.value;
        currentUserId.value = message.userId;
        if (previousUserId !== currentUserId.value && localStream.value) {
          stopSpeakingDetection(previousUserId);
          startSpeakingDetection(currentUserId.value, localStream.value);
        }
      }
      userNames[currentUserId.value] = payload.self?.displayName || props.displayName;
      const existingUsers = (payload.users ?? []).map(registerUser);
      users.value = unique([currentUserId.value, ...existingUsers]);
      if (localStream.value) {
        for (const userId of otherUsers.value) {
          await ensurePeer(userId, true);
        }
      }
      break;
    }
    case 'user-joined':
      if (message.userId && message.userId !== currentUserId.value) {
        if (users.value.includes(message.userId)) {
          closePeer(message.userId);
        }
        registerUser((message.payload as UserSummary | undefined) ?? message.userId);
        users.value = unique([...users.value, message.userId]);
        playVoiceFeedback('user-join');
        if (localStream.value) {
          await ensurePeer(message.userId, false);
        }
        queueScreenShareOffer(message.userId);
      }
      break;
    case 'user-left':
      if (message.userId) {
        users.value = users.value.filter((userId) => userId !== message.userId);
        closePeer(message.userId);
        if (message.userId !== currentUserId.value) {
          playVoiceFeedback('user-leave');
        }
      }
      break;
    case 'offer':
      if (message.userId) {
        await receiveOffer(message.userId, message.payload as RTCSessionDescriptionInit);
      }
      break;
    case 'answer':
      if (message.userId) {
        await receiveAnswer(message.userId, message.payload as RTCSessionDescriptionInit);
      }
      break;
    case 'ice-candidate':
      if (message.userId) {
        await receiveCandidate(message.userId, message.payload as RTCIceCandidateInit);
      }
      break;
    case 'chat-message':
      if (message.userId) {
        appendChatMessage(message.userId, message.payload as ChatPayload);
      }
      break;
    case 'pong':
      break;
    case 'error': {
      const payload = message.payload as ErrorPayload;
      error.value = payload.message ?? 'Signaling error.';
      if (error.value.toLowerCase().includes('password')) {
        const rejectedMessage = error.value;
        cleanup();
        emit('joinRejected', rejectedMessage);
      }
      break;
    }
  }
}

function setMemberVolume(userId: string, value: number) {
  memberVolumes[userId] = value;
  updateRemoteAudioSettings();
}

function setMemberVolumeFromEvent(userId: string, event: Event) {
  setMemberVolume(userId, Number((event.target as HTMLInputElement).value));
}

function toggleMemberVolumePopover(userId: string) {
  if (userId === currentUserId.value) {
    return;
  }
  activeScreenMenuUser.value = null;
  screenShareMenuOpen.value = false;
  activeMemberVolumeUser.value = activeMemberVolumeUser.value === userId ? null : userId;
}

function setScreenVolume(userId: string, value: number) {
  screenVolumes[userId] = value;
  updateRemoteAudioSettings();
}

function setScreenVolumeFromEvent(userId: string, event: Event) {
  setScreenVolume(userId, Number((event.target as HTMLInputElement).value));
}

function openScreenMenu(userId: string) {
  activeMemberVolumeUser.value = null;
  screenShareMenuOpen.value = false;
  activeScreenMenuUser.value = userId;
}

function closePopovers() {
  activeMemberVolumeUser.value = null;
  activeScreenMenuUser.value = null;
  screenShareMenuOpen.value = false;
}

function handleKeydown(event: KeyboardEvent) {
  if (capturingShortcut.value) {
    event.preventDefault();
    if (event.key === 'Escape') {
      capturingShortcut.value = null;
      return;
    }
    const shortcut = keyboardShortcut(event);
    if (shortcut) {
      setShortcut(capturingShortcut.value, shortcut);
    }
    return;
  }

  if (event.key === 'Escape') {
    fullscreenScreenUser.value = null;
    closePopovers();
    settingsOpen.value = false;
    return;
  }

  if (event.repeat || isTypingTarget(event.target)) {
    return;
  }

  const shortcut = keyboardShortcut(event);
  if (muteShortcut.value && shortcut === muteShortcut.value) {
    event.preventDefault();
    toggleMute();
  } else if (deafenShortcut.value && shortcut === deafenShortcut.value) {
    event.preventDefault();
    toggleDeafen();
  }
}

function startShortcutCapture(action: ShortcutAction) {
  capturingShortcut.value = action;
}

function setShortcut(action: ShortcutAction, shortcut: string) {
  if (action === 'mute') {
    muteShortcut.value = shortcut;
  } else {
    deafenShortcut.value = shortcut;
  }
  capturingShortcut.value = null;
}

function clearShortcut(action: ShortcutAction) {
  if (action === 'mute') {
    muteShortcut.value = '';
  } else {
    deafenShortcut.value = '';
  }
}

function setChatLogElement(element: Element | ComponentPublicInstance | null) {
  chatLog.value = element instanceof HTMLDivElement ? element : null;
}

async function copyRoomId() {
  try {
    await navigator.clipboard.writeText(props.roomId);
    roomCopied.value = true;
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => { roomCopied.value = false; }, 2000);
  } catch {
    error.value = 'Could not copy the room ID.';
  }
}
function cleanup() {
  intentionallyClosed = true;
  window.clearTimeout(copyTimer);
  clearErrorTimer();
  clearHeartbeat();
  clearReconnectTimer();
  window.removeEventListener('keydown', handleKeydown);
  navigator.mediaDevices?.removeEventListener('devicechange', loadDevices);
  closeAllPeers();
  stopLocalAudio();
  void stopScreenShare();
  micStarted.value = false;
  socket?.close();
  socket = null;
}

function startSpeakingDetection(userId: string, stream: MediaStream) {
  stopSpeakingDetection(userId);
  const track = stream.getAudioTracks()[0];
  if (!track) {
    return;
  }

  const context = new AudioContext();
  void context.resume();
  const source = context.createMediaStreamSource(new MediaStream([track]));
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.35;
  const samples = new Uint8Array(analyser.fftSize);
  source.connect(analyser);
  let noiseFloor = 1.8;

  const timer = window.setInterval(() => {
    if (track.readyState !== 'live' || track.muted || (userId === currentUserId.value && muted.value)) {
      speakingUsers[userId] = false;
      return;
    }

    analyser.getByteTimeDomainData(samples);
    let total = 0;
    for (const sample of samples) {
      const centered = sample - 128;
      total += centered * centered;
    }
    const rms = Math.sqrt(total / samples.length);
    noiseFloor = Math.min(12, noiseFloor * 0.96 + rms * 0.04);
    const threshold = Math.max(3.2, noiseFloor + 1.6);
    const now = performance.now();
    if (rms > threshold) {
      speakingUntil.set(userId, now + 520);
    }
    speakingUsers[userId] = (speakingUntil.get(userId) ?? 0) > now;
  }, 70);

  remoteAnalyzers.set(userId, { context, timer });
  track.addEventListener('ended', () => stopSpeakingDetection(userId), { once: true });
}

function stopSpeakingDetection(userId: string) {
  const analyzer = remoteAnalyzers.get(userId);
  if (!analyzer) {
    return;
  }
  window.clearInterval(analyzer.timer);
  void analyzer.context.close();
  remoteAnalyzers.delete(userId);
  speakingUntil.delete(userId);
  speakingUsers[userId] = false;
}

function send(message: SignalMessage) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function registerUser(user: string | UserSummary) {
  return registerUserName(user, userNames);
}

function displayName(userId: string) {
  return displayNameForUser(userId, currentUserId.value, props.displayName, userNames);
}

function initials(userId: string) {
  return initialsForName(displayName(userId));
}
</script>

<template>
  <section class="room-shell" @click="closePopovers">
    <header class="room-header">
      <div class="room-heading">
        <div class="wordmark room-wordmark"><BrandMark /><span>mikcort<span class="brand-period">.</span></span></div>
        <span class="header-divider"></span>
        <div class="room-identity"><span class="eyebrow">VOICE ROOM</span><h1>{{ roomId }}</h1></div>
        <button type="button" class="icon-button quiet-button compact-button" :aria-label="roomCopied ? 'Room ID copied' : 'Copy room ID'" :title="roomCopied ? 'Copied' : 'Copy room ID'" @click.stop="copyRoomId"><Check v-if="roomCopied" :size="16" /><Copy v-else :size="15" /></button>
      </div>
      <div class="stage-actions">
        <span class="connection-state" :title="status"><span :class="['dot', { online: wsOpen }]"></span>{{ connectionLabel }}</span>
        <button type="button" class="chat-toggle" :class="{ active: chatOpen }" :aria-pressed="chatOpen" :aria-label="chatOpen ? 'Close chat' : 'Open chat'" :title="chatOpen ? 'Close chat' : 'Open chat'" @click.stop="toggleChat"><MessageSquare :size="18" /><span>Chat</span><strong v-if="unreadChatCount">{{ unreadChatCount }}</strong></button>
      </div>
    </header>
    <p v-if="error" class="error room-error" role="alert">{{ error }}</p>
    <div v-if="sharingScreen" class="screen-status"><MonitorUp :size="16" /><span>Your screen is live</span><strong>{{ screenShareCaptureLabel }}</strong><button type="button" class="text-button" @click.stop="stopScreenShare">Stop sharing</button></div>
    <div :class="['room-body', { 'chat-is-open': chatOpen }]">
      <main :class="['room-canvas', { 'watching-screen': viewedScreenUserId }]">
        <ScreenShareStage v-if="viewedScreenUserId" :active-screen-menu-user="activeScreenMenuUser" :display-name="displayName" :fullscreen-screen-user="fullscreenScreenUser" :screen-volumes="screenVolumes" :viewed-screen-user-id="viewedScreenUserId" @close-popovers="closePopovers" @open-screen-menu="openScreenMenu" @set-screen-video-element="setScreenVideoElement" @set-screen-volume="setScreenVolumeFromEvent" @stop-viewing="stopViewingScreenShare" @toggle-fullscreen="toggleScreenFullscreen" />
        <div class="people-stage">
          <MembersSidebar :active-member-volume-user="activeMemberVolumeUser" :current-user-id="currentUserId" :display-name="displayName" :initials="initials" :is-user-sharing-screen="isUserSharingScreen" :member-volumes="memberVolumes" :screen-share-badge-label="screenShareBadgeLabel" :speaking-users="speakingUsers" :users="users" :viewing-screen-user="viewingScreenUser" :muted="muted" :deafened="deafened" :compact="!!viewedScreenUserId" @set-member-volume="setMemberVolumeFromEvent" @toggle-member-volume="toggleMemberVolumePopover" @toggle-screen-share-view="toggleScreenShareView" />
          <p v-if="users.length === 1 && !viewedScreenUserId" class="solo-hint">Just you for now. Friends can join from the room list.</p>
          <p v-if="!users.length" class="solo-hint">Joining your room…</p>
        </div>
      </main>
      <RoomChatPanel v-if="chatOpen" v-model:draft="chatDraft" :current-user-id="currentUserId" :display-name="displayName" :messages="chatMessages" :set-log-element="setChatLogElement" :ws-open="wsOpen" @close="toggleChat" @send="sendChatMessage" />
    </div>
    <VoiceDock v-model:selected-screen-fps="selectedScreenFps" v-model:selected-screen-resolution="selectedScreenResolution" :deafened="deafened" :mic-started="micStarted" :mic-starting="micStarting" :muted="muted" :screen-share-menu-open="screenShareMenuOpen" :screen-share-capture-label="screenShareCaptureLabel" :screen-starting="screenStarting" :settings-open="settingsOpen" :sharing-screen="sharingScreen" :user-display-name="displayName(currentUserId)" :user-initials="initials(currentUserId)" :voice-state="voiceState" @leave="leave" @start-microphone="startMicrophone" @start-screen-share="startScreenShare" @toggle-deafen="toggleDeafen" @toggle-mute="toggleMute" @toggle-screen-share="toggleScreenShare" @toggle-settings="settingsOpen = !settingsOpen" />
    <AudioSettingsDrawer v-if="settingsOpen" v-model:auto-gain-control="autoGainControl" v-model:deafen-shortcut="deafenShortcut" v-model:echo-cancellation="echoCancellation" v-model:input-gain="inputGain" v-model:input-sensitivity="inputSensitivity" v-model:mute-shortcut="muteShortcut" v-model:noise-suppression-mode="noiseSuppressionMode" v-model:output-volume="outputVolume" v-model:selected-input-id="selectedInputId" v-model:selected-output-id="selectedOutputId" :capturing-shortcut="capturingShortcut" :deafened="deafened" :input-devices="inputDevices" :microphone-busy="micStarting" :noise-suppression-notice="noiseSuppressionNotice" :output-devices="outputDevices" @apply-audio-settings="applyAudioSettings" @clear-shortcut="clearShortcut" @close="settingsOpen = false" @start-shortcut-capture="startShortcutCapture" @update-mic-gain="updateMicGain" @update-remote-audio-settings="updateRemoteAudioSettings" />
    <div ref="remoteAudio" class="remote-audio" aria-hidden="true"></div>
  </section>
</template>
