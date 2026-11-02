<script setup lang="ts">
import { Headphones, Mic, MicOff, MonitorUp, PhoneOff, Settings, VolumeX } from 'lucide-vue-next';

const selectedScreenFps = defineModel<number>('selectedScreenFps', { required: true });
const selectedScreenResolution = defineModel<number>('selectedScreenResolution', { required: true });

defineProps<{
  deafened: boolean;
  micStarted: boolean;
  micStarting: boolean;
  muted: boolean;
  screenShareMenuOpen: boolean;
  screenShareCaptureLabel: string;
  screenStarting: boolean;
  settingsOpen: boolean;
  sharingScreen: boolean;
  userDisplayName: string;
  userInitials: string;
  voiceState: string;
}>();

defineEmits<{
  leave: [];
  startMicrophone: [];
  startScreenShare: [];
  toggleDeafen: [];
  toggleMute: [];
  toggleScreenShare: [];
  toggleSettings: [];
}>();
</script>

<template>
  <div class="voice-dock">
    <div class="dock-user">
      <span class="avatar">{{ userInitials }}</span>
      <div>
        <strong>{{ userDisplayName }}</strong>
        <small>{{ sharingScreen ? `Sharing · ${screenShareCaptureLabel}` : deafened ? 'Audio off' : voiceState }}</small>
      </div>
    </div>

    <div class="dock-actions" aria-label="Voice controls">
      <button
        type="button"
        class="icon-button"
        :class="{ active: micStarted && !muted, danger: muted }"
        :aria-pressed="micStarted && !muted"
        :data-tooltip="micStarting ? 'Opening mic' : micStarted ? (muted ? 'Unmute mic' : 'Mute mic') : 'Start mic'"
        :title="micStarting ? 'Opening microphone' : micStarted ? (muted ? 'Unmute microphone' : 'Mute microphone') : 'Start microphone'"
        :disabled="micStarting"
        @click="micStarted ? $emit('toggleMute') : $emit('startMicrophone')"
      >
        <MicOff v-if="muted" :size="20" />
        <Mic v-else :size="20" />
      </button>

      <button
        type="button"
        class="icon-button"
        :class="{ danger: deafened }"
        :aria-pressed="deafened"
        :data-tooltip="deafened ? 'Enable audio' : 'Deafen'"
        :title="deafened ? 'Turn output on' : 'Deafen output'"
        @click="$emit('toggleDeafen')"
      >
        <VolumeX v-if="deafened" :size="20" />
        <Headphones v-else :size="20" />
      </button>



      <div class="share-control">
        <button
          type="button"
          class="icon-button"
          :class="{ active: sharingScreen, selected: screenShareMenuOpen }"
          :data-tooltip="sharingScreen ? 'Stop sharing' : 'Share screen'"
          :title="sharingScreen ? 'Stop screen share' : 'Share screen'"
          :disabled="screenStarting"
          @click.stop="$emit('toggleScreenShare')"
        >
          <MonitorUp :size="20" />
        </button>
        <div v-if="screenShareMenuOpen" class="share-menu popover-panel" @click.stop>
          <strong>Share screen</strong>
          <label>
            Resolution
            <select v-model.number="selectedScreenResolution" aria-label="Screen share resolution">
              <option :value="720">720p</option>
              <option :value="1080">1080p</option>
            </select>
          </label>
          <label>
            Frame rate
            <select v-model.number="selectedScreenFps" aria-label="Screen share frame rate">
              <option :value="30">30 FPS · Sharper text</option>
              <option :value="60">60 FPS · Smoother motion</option>
            </select>
          </label>
          <button type="button" class="share-start-button" @click="$emit('startScreenShare')">
            <MonitorUp :size="16" />
            Start sharing
          </button>
        </div>
      </div>

      <button type="button" class="icon-button" :class="{ selected: settingsOpen }" :aria-pressed="settingsOpen" data-tooltip="Settings" title="Audio settings" @click="$emit('toggleSettings')"><Settings :size="20" /></button>
      <button type="button" class="icon-button leave-button" data-tooltip="Leave room" title="Leave room" @click="$emit('leave')">
        <PhoneOff :size="20" />
      </button>
    </div>
  </div>
</template>
