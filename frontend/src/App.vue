<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { ArrowRight, ChevronDown, Headphones, LockKeyhole, Plus, RefreshCw, Settings2, X } from 'lucide-vue-next';
import BrandMark from './components/BrandMark.vue';
import VoiceRoom from './components/VoiceRoom.vue';
import { usePersistentString } from './composables/usePersistentStorage';
import { buildRoomsEndpoint, fetchLiveRooms } from './features/rooms/api';
import type { RoomSummary } from './features/rooms/types';

const roomId = ref('');
const roomPassword = ref('');
const serverUrl = usePersistentString('mikcort:server-url', 'ws://localhost:8080/ws', { trim: true });
const displayName = usePersistentString('mikcort:display-name', '', { trim: true });
const activeRoomId = ref('');
const activeRoomPassword = ref('');
const updateMessage = ref('');
const updateTone = ref<'info' | 'success' | 'error'>('info');
const rooms = ref<RoomSummary[]>([]);
const roomsLoading = ref(true);
const roomsError = ref('');
const roomJoinHint = ref('');
const createMenuOpen = ref(false);
const passwordDialog = ref<HTMLDialogElement | null>(null);
const connectionDialog = ref<HTMLDialogElement | null>(null);
const passwordInput = ref<HTMLInputElement | null>(null);
const passwordAction = ref<'create' | 'join'>('join');
const serverDraft = ref('');
const connectionError = ref('');
let roomRefreshTimer: number | undefined;
let updateTimer: number | undefined;
let roomRequest = 0;

const canCreate = computed(() => serverUrl.value.trim().length > 0 && displayName.value.trim().length > 0);
const nameInitial = computed(() => displayName.value.trim().slice(0, 1).toUpperCase() || '?');
const connectionLabel = computed(() => roomsLoading.value ? 'Connecting' : roomsError.value ? 'Offline' : 'Ready to talk');

onMounted(() => {
  window.addEventListener('mikcort:update-status', handleUpdateStatus);
  void loadRooms();
  roomRefreshTimer = window.setInterval(() => { if (!activeRoomId.value) void loadRooms(true); }, 5000);
});
onBeforeUnmount(() => {
  roomRequest++;
  window.removeEventListener('mikcort:update-status', handleUpdateStatus);
  window.clearInterval(roomRefreshTimer);
  window.clearTimeout(updateTimer);
});

function createRoom() {
  roomId.value = crypto.randomUUID().slice(0, 8);
  roomPassword.value = '';
  joinRoom();
}
function joinRoom() {
  if (!canCreate.value || !roomId.value.trim()) return;
  createMenuOpen.value = false;
  roomJoinHint.value = '';
  passwordDialog.value?.close();
  activeRoomId.value = roomId.value.trim();
  activeRoomPassword.value = roomPassword.value.trim();
}
function joinExistingRoom(room: RoomSummary) {
  roomId.value = room.id;
  roomPassword.value = '';
  if (room.locked) {
    openPasswordDialog('join');
  } else {
    joinRoom();
  }
}
function openPasswordDialog(action: 'create' | 'join') {
  passwordAction.value = action;
  if (action === 'create') roomId.value = crypto.randomUUID().slice(0, 8);
  roomPassword.value = '';
  roomJoinHint.value = '';
  createMenuOpen.value = false;
  passwordDialog.value?.showModal();
  void nextTick(() => passwordInput.value?.focus());
}
function submitPassword() {
  if (roomPassword.value.trim()) joinRoom();
}
function leaveRoom() {
  activeRoomId.value = '';
  activeRoomPassword.value = '';
  roomPassword.value = '';
  void loadRooms();
}
function handleJoinRejected(message: string) {
  activeRoomId.value = '';
  activeRoomPassword.value = '';
  roomPassword.value = '';
  roomJoinHint.value = message;
  passwordAction.value = 'join';
  void nextTick(() => {
    passwordDialog.value?.showModal();
    passwordInput.value?.focus();
  });
  void loadRooms();
}
function openConnectionSettings() {
  serverDraft.value = serverUrl.value;
  connectionError.value = '';
  connectionDialog.value?.showModal();
}
function saveConnection() {
  try {
    const url = new URL(serverDraft.value.trim());
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Invalid protocol');
    serverUrl.value = url.toString();
    connectionDialog.value?.close();
    rooms.value = [];
    void loadRooms();
  } catch {
    connectionError.value = 'Enter a valid ws:// or wss:// server address.';
  }
}
function handleUpdateStatus(event: Event) {
  const detail = (event as CustomEvent<{ status: string; message: string }>).detail;
  window.clearTimeout(updateTimer);
  updateMessage.value = detail.message;
  updateTone.value = detail.status === 'error' ? 'error' : detail.status === 'installed' ? 'success' : 'info';
  if (detail.status === 'not-available') updateTimer = window.setTimeout(() => { updateMessage.value = ''; }, 5000);
}
async function loadRooms(quiet = false) {
  const request = ++roomRequest;
  const endpoint = buildRoomsEndpoint(serverUrl.value);
  if (!quiet) roomsLoading.value = true;
  try {
    if (!endpoint) throw new Error('Invalid server');
    const nextRooms = await fetchLiveRooms(endpoint);
    if (request !== roomRequest) return;
    rooms.value = nextRooms;
    roomsError.value = '';
  } catch {
    if (request !== roomRequest) return;
    roomsError.value = "Can't reach your server.";
  } finally {
    if (request === roomRequest) roomsLoading.value = false;
  }
}
</script>

<template>
  <main class="app-shell" @click="createMenuOpen = false">
    <div v-if="updateMessage" :class="['update-toast', updateTone]" role="status">{{ updateMessage }}</div>
    <section v-if="!activeRoomId" class="home">
      <header class="app-header">
        <div class="wordmark"><BrandMark /><span>mikcort<span class="brand-period">.</span></span></div>
        <button type="button" class="icon-button quiet-button" aria-label="Connection settings" title="Connection settings" @click="openConnectionSettings"><Settings2 :size="19" /></button>
      </header>
      <div class="home-panel">
        <div class="home-copy"><h1>Good to hear you.</h1><p>Pick a room. Make yourself at home.</p></div>
        <label class="name-field">
          <span class="name-avatar" aria-hidden="true">{{ nameInitial }}</span>
          <span class="name-input"><span>Your name</span><input v-model="displayName" aria-label="Your name" autocomplete="name" maxlength="40" placeholder="What should we call you?" /></span>
        </label>
        <div class="room-browser">
          <div class="room-browser-heading"><h2>Rooms<span v-if="rooms.length" class="count-badge">{{ rooms.length }}</span></h2><button type="button" class="icon-button quiet-button compact-button" aria-label="Refresh rooms" title="Refresh rooms" :disabled="roomsLoading" @click="loadRooms()"><RefreshCw :size="16" :class="{ spinning: roomsLoading }" /></button></div>
          <div class="room-list">
            <div v-if="roomsLoading && !rooms.length" class="room-empty"><span class="loading-dot"></span>Finding your rooms…</div>
            <div v-else-if="roomsError && !rooms.length" class="room-empty"><Headphones :size="28" /><strong>Let's get you connected.</strong><p>{{ roomsError }}</p><button type="button" class="text-button" @click="openConnectionSettings">Connection settings <ArrowRight :size="14" /></button></div>
            <div v-else-if="!rooms.length" class="room-empty"><Headphones :size="28" /><strong>A little quiet in here.</strong><p>Create a room and bring your people.</p></div>
            <button v-for="room in rooms" :key="room.id" type="button" class="room-row" :disabled="!canCreate" @click="joinExistingRoom(room)">
              <span :class="['room-row-mark', { private: room.locked }]"><LockKeyhole v-if="room.locked" :size="20" /><Headphones v-else :size="20" /></span>
              <span class="room-row-body"><strong>Room {{ room.id }}</strong><small>{{ room.locked ? 'Password required' : room.users.join(', ') }}</small></span>
              <span v-if="!room.locked" class="room-row-count">{{ room.users.length }} here</span><ArrowRight :size="17" class="room-row-arrow" />
            </button>
          </div>
          <p v-if="roomsError && rooms.length" class="list-notice" role="status">{{ roomsError }} <button class="text-button" type="button" @click="loadRooms()">Retry</button></p>
        </div>
        <div class="create-room-actions" @click.stop>
          <div class="create-room-group"><button type="button" class="primary create-room-button" :disabled="!canCreate" @click="createRoom"><Plus :size="18" /> Create room</button><button type="button" class="primary create-options-button" :disabled="!canCreate" aria-label="Room options" :aria-expanded="createMenuOpen" @click="createMenuOpen = !createMenuOpen"><ChevronDown :size="17" /></button></div>
          <div v-if="createMenuOpen" class="create-menu popover-panel"><button type="button" class="menu-action" @click="openPasswordDialog('create')"><LockKeyhole :size="16" />Create private room</button></div>
        </div>
        <p class="name-hint">{{ displayName.trim() ? 'No account. Just good company.' : 'Add your name to join the conversation.' }}</p>
      </div>
      <footer class="home-footer"><span class="connection-state"><span :class="['dot', { online: !roomsError && !roomsLoading }]"></span>{{ connectionLabel }}</span><span>A room for your people.</span></footer>
    </section>
    <VoiceRoom v-else :room-id="activeRoomId" :server-url="serverUrl.trim()" :display-name="displayName.trim()" :room-password="activeRoomPassword" @join-rejected="handleJoinRejected" @left="leaveRoom" />

    <dialog ref="passwordDialog" class="app-dialog" aria-labelledby="password-dialog-title" @click="(event) => { if (event.target === passwordDialog) passwordDialog?.close(); }">
      <form @submit.prevent="submitPassword">
        <div class="dialog-heading"><span class="dialog-symbol"><LockKeyhole :size="22" /></span><button type="button" class="icon-button quiet-button" aria-label="Close password dialog" @click="passwordDialog?.close()"><X :size="18" /></button></div>
        <h2 id="password-dialog-title">{{ passwordAction === 'create' ? 'Keep it between friends.' : 'You’re invited.' }}</h2>
        <p>{{ passwordAction === 'create' ? 'Set a password for your private room.' : `Enter the password for room ${roomId}.` }}</p>
        <label>Password<input ref="passwordInput" v-model="roomPassword" type="password" autocomplete="off" placeholder="Room password" required @input="roomJoinHint = ''" /></label>
        <p v-if="roomJoinHint" class="field-error" role="alert">{{ roomJoinHint }}</p>
        <button type="submit" class="primary dialog-submit" :disabled="!roomPassword.trim()">{{ passwordAction === 'create' ? 'Create private room' : 'Join room' }}<ArrowRight :size="16" /></button>
      </form>
    </dialog>
    <dialog ref="connectionDialog" class="app-dialog" aria-labelledby="connection-dialog-title" @click="(event) => { if (event.target === connectionDialog) connectionDialog?.close(); }">
      <form @submit.prevent="saveConnection">
        <div class="dialog-heading"><span class="dialog-symbol"><Settings2 :size="22" /></span><button type="button" class="icon-button quiet-button" aria-label="Close connection settings" @click="connectionDialog?.close()"><X :size="18" /></button></div>
        <h2 id="connection-dialog-title">Your connection.</h2><p>Use the same server as your friends.</p>
        <label>Server address<input v-model="serverDraft" type="text" spellcheck="false" autocomplete="off" placeholder="wss://your-server/ws" required /></label>
        <p v-if="connectionError" class="field-error" role="alert">{{ connectionError }}</p>
        <button type="submit" class="primary dialog-submit">Save connection<ArrowRight :size="16" /></button>
      </form>
    </dialog>
  </main>
</template>
