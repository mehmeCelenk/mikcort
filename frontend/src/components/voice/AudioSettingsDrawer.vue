<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { ChevronDown, X } from 'lucide-vue-next';
import { formatShortcut } from '../../features/voice/keyboard';
import type { ShortcutAction } from '../../features/voice/types';

const autoGainControl = defineModel<boolean>('autoGainControl', { required: true });
const deafenShortcut = defineModel<string>('deafenShortcut', { required: true });
const echoCancellation = defineModel<boolean>('echoCancellation', { required: true });
const inputGain = defineModel<number>('inputGain', { required: true });
const inputSensitivity = defineModel<number>('inputSensitivity', { required: true });
const muteShortcut = defineModel<string>('muteShortcut', { required: true });
const noiseSuppressionMode = defineModel<string>('noiseSuppressionMode', { required: true });
const outputVolume = defineModel<number>('outputVolume', { required: true });
const selectedInputId = defineModel<string>('selectedInputId', { required: true });
const selectedOutputId = defineModel<string>('selectedOutputId', { required: true });

defineProps<{
  capturingShortcut: ShortcutAction | null;
  deafened: boolean;
  inputDevices: MediaDeviceInfo[];
  microphoneBusy: boolean;
  noiseSuppressionNotice: string;
  outputDevices: MediaDeviceInfo[];
}>();

defineEmits<{
  applyAudioSettings: [];
  clearShortcut: [action: ShortcutAction];
  close: [];
  startShortcutCapture: [action: ShortcutAction];
  updateMicGain: [];
  updateRemoteAudioSettings: [];
}>();
const drawer = ref<HTMLDialogElement | null>(null);
onMounted(() => drawer.value?.showModal());
onBeforeUnmount(() => drawer.value?.close());
</script>

<template>
  <dialog ref="drawer" class="settings-drawer" aria-label="Audio settings" @cancel.prevent="$emit('close')" @click.stop="(event) => { if (event.target === drawer) $emit('close'); }">
    <div class="drawer-header"><div><span class="eyebrow">MAKE YOURSELF HEARD</span><h2>Sound settings.</h2></div><button type="button" class="icon-button quiet-button compact-button" title="Close settings" aria-label="Close settings" @click="$emit('close')"><X :size="18" /></button></div>
    <div class="settings-sections">
      <section class="settings-section" aria-label="Audio devices">
        <label class="setting-item"><span class="setting-label">Microphone</span><select v-model="selectedInputId" :disabled="microphoneBusy" @change="$emit('applyAudioSettings')"><option v-if="!inputDevices.length" value="">Default microphone</option><option v-for="device in inputDevices" :key="device.deviceId" :value="device.deviceId">{{ device.label || 'Microphone' }}</option></select></label>
        <label class="setting-item"><span class="setting-label">Speakers or headphones</span><select v-model="selectedOutputId" @change="$emit('applyAudioSettings')"><option v-if="!outputDevices.length" value="">Default output</option><option v-for="device in outputDevices" :key="device.deviceId" :value="device.deviceId">{{ device.label || 'Speaker' }}</option></select></label>
        <label class="setting-item slider-setting"><span class="setting-label">Output volume</span><small>{{ deafened ? 'Muted' : `${outputVolume}%` }}</small><input v-model.number="outputVolume" type="range" min="0" max="100" @input="$emit('updateRemoteAudioSettings')" /></label>
      </section>
      <section class="settings-section" aria-label="Noise reduction"><label class="setting-item"><span class="setting-label">Noise suppression</span><select v-model="noiseSuppressionMode" :disabled="microphoneBusy" @change="$emit('applyAudioSettings')"><option value="off">Off</option><option value="standard">Standard</option><option value="rnnoise">RNNoise (AI)</option></select><small>Less background noise. More you.</small></label><p v-if="noiseSuppressionNotice" class="processing-notice" role="status">{{ noiseSuppressionNotice }}</p></section>
      <details class="settings-advanced"><summary>Fine-tune your microphone<ChevronDown :size="16" /></summary><div class="settings-list">
        <label class="setting-item slider-setting"><span class="setting-label">Mic gain</span><small>{{ inputGain }}%</small><input v-model.number="inputGain" type="range" min="0" max="100" @input="$emit('updateMicGain')" /></label>
        <label class="setting-item slider-setting"><span class="setting-label">Input sensitivity</span><small>{{ inputSensitivity > 0 ? `${inputSensitivity}%` : 'Off' }}</small><input v-model.number="inputSensitivity" type="range" min="0" max="10" step="0.5" /></label>
        <label class="setting-toggle"><span>Echo cancellation</span><input v-model="echoCancellation" :disabled="microphoneBusy" type="checkbox" @change="$emit('applyAudioSettings')" /></label><label class="setting-toggle"><span>Automatic gain</span><input v-model="autoGainControl" :disabled="microphoneBusy" type="checkbox" @change="$emit('applyAudioSettings')" /></label>
      </div></details>
      <details class="settings-advanced"><summary>Keyboard shortcuts<ChevronDown :size="16" /></summary><div class="settings-list">
        <div class="setting-item"><span class="setting-label">Mute microphone</span><div class="shortcut-control"><button type="button" class="shortcut-button" @click="$emit('startShortcutCapture', 'mute')">{{ capturingShortcut === 'mute' ? 'Press keys…' : muteShortcut ? formatShortcut(muteShortcut) : 'Set shortcut' }}</button><button v-if="muteShortcut" type="button" class="icon-button quiet-button compact-button" title="Clear mute shortcut" @click="$emit('clearShortcut', 'mute')"><X :size="15" /></button></div></div>
        <div class="setting-item"><span class="setting-label">Deafen</span><div class="shortcut-control"><button type="button" class="shortcut-button" @click="$emit('startShortcutCapture', 'deafen')">{{ capturingShortcut === 'deafen' ? 'Press keys…' : deafenShortcut ? formatShortcut(deafenShortcut) : 'Set shortcut' }}</button><button v-if="deafenShortcut" type="button" class="icon-button quiet-button compact-button" title="Clear deafen shortcut" @click="$emit('clearShortcut', 'deafen')"><X :size="15" /></button></div></div>
      </div></details>
      <p class="settings-footnote">Your preferences are saved automatically.</p>
    </div>
  </dialog>
</template>