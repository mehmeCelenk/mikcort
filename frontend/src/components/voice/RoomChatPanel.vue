<script setup lang="ts">
import { MessageSquare, Send, X } from 'lucide-vue-next';
import type { ComponentPublicInstance } from 'vue';
import { normalizedChatText, chatTime } from '../../features/voice/chat';
import type { ChatMessage } from '../../features/voice/types';

const draft = defineModel<string>('draft', { required: true });

defineProps<{
  currentUserId: string;
  displayName: (userId: string) => string;
  messages: ChatMessage[];
  setLogElement: (element: Element | ComponentPublicInstance | null) => void;
  wsOpen: boolean;
}>();

defineEmits<{
  send: [];
  close: [];
}>();
</script>

<template>
  <section class="room-chat" aria-label="Room chat" @click.stop>
    <div class="chat-header">
      <h2>Chat</h2>
      <button type="button" class="icon-button quiet-button compact-button" aria-label="Close chat" @click="$emit('close')"><X :size="17" /></button>
    </div>
    <div :ref="setLogElement" class="chat-messages">
      <div v-if="!messages.length" class="chat-empty"><MessageSquare :size="25" /><strong>A little side conversation.</strong><span>Messages stay in this room.</span></div>
      <article
        v-for="message in messages"
        :key="message.id"
        :class="['chat-message', { mine: message.userId === currentUserId }]"
      >
        <div class="chat-meta">
          <strong>{{ message.userId === currentUserId ? 'You' : displayName(message.userId) }}</strong>
          <time>{{ chatTime(message.sentAt) }}</time>
        </div>
        <p>{{ message.text }}</p>
      </article>
    </div>
    <form class="chat-form" @submit.prevent="$emit('send')">
      <input v-model="draft" aria-label="Message room" maxlength="500" autocomplete="off" placeholder="Say something…" />
      <button
        type="submit"
        class="icon-button compact-button"
        data-tooltip="Send"
        title="Send message"
        :disabled="!normalizedChatText(draft) || !wsOpen"
      >
        <Send :size="17" />
      </button>
    </form>
  </section>
</template>
