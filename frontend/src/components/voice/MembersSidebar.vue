<script setup lang="ts">
import { Headphones, MicOff, Volume2 } from 'lucide-vue-next';

defineProps<{
  activeMemberVolumeUser: string | null;
  currentUserId: string;
  displayName: (userId: string) => string;
  initials: (userId: string) => string;
  isUserSharingScreen: (userId: string) => boolean;
  memberVolumes: Record<string, number>;
  screenShareBadgeLabel: (userId: string) => string;
  speakingUsers: Record<string, boolean>;
  users: string[];
  viewingScreenUser: string | null;
  muted: boolean;
  deafened: boolean;
  compact: boolean;
}>();
defineEmits<{
  setMemberVolume: [userId: string, event: Event];
  toggleMemberVolume: [userId: string];
  toggleScreenShareView: [userId: string];
}>();
</script>

<template>
  <section :class="['deck-members', { compact }]" aria-label="Room members">
    <div class="panel-heading"><h2>In this room</h2><span class="count-badge">{{ users.length }}</span></div>
    <ul class="user-list">
      <li v-for="(userId, index) in users" :key="userId" :class="['member-card', `avatar-tone-${index % 4}`, { speaking: speakingUsers[userId], selected: activeMemberVolumeUser === userId }]">
        <button type="button" class="member-main" :disabled="userId === currentUserId" :aria-label="userId === currentUserId ? `${displayName(userId)}, you` : `Adjust volume for ${displayName(userId)}`" :aria-expanded="userId !== currentUserId ? activeMemberVolumeUser === userId : undefined" @click.stop="$emit('toggleMemberVolume', userId)">
          <span class="member-avatar-wrap"><span class="avatar">{{ initials(userId) }}</span><span v-if="speakingUsers[userId]" class="speaking-indicator" aria-hidden="true"><i></i><i></i><i></i></span><span v-else-if="userId === currentUserId && (muted || deafened)" class="member-muted" :title="deafened ? 'Audio off' : 'Microphone muted'"><Headphones v-if="deafened" :size="13" /><MicOff v-else :size="13" /></span></span>
          <strong>{{ displayName(userId) }}<span v-if="userId === currentUserId" class="you-label">you</span></strong>
          <small>{{ speakingUsers[userId] ? 'Speaking' : userId === currentUserId && muted ? 'Muted' : 'In the room' }}</small>
        </button>
        <button v-if="isUserSharingScreen(userId)" type="button" class="live-badge" :class="{ watching: viewingScreenUser === userId }" :disabled="userId === currentUserId" :title="userId === currentUserId ? 'You are sharing your screen' : viewingScreenUser === userId ? 'Stop watching stream' : 'Watch stream'" @click.stop="$emit('toggleScreenShareView', userId)"><span class="live-dot"></span>{{ screenShareBadgeLabel(userId) }}</button>
        <div v-if="activeMemberVolumeUser === userId" class="member-popover popover-panel" @click.stop>
          <strong>{{ displayName(userId) }}</strong><label class="popover-slider"><span><Volume2 :size="15" />Volume</span><input type="range" min="0" max="100" :value="memberVolumes[userId] ?? 100" @input="$emit('setMemberVolume', userId, $event)" /><small>{{ memberVolumes[userId] ?? 100 }}%</small></label>
        </div>
      </li>
    </ul>
  </section>
</template>
