import { createApp } from 'vue';
import VoiceRoom from '../../src/components/VoiceRoom.vue';
import { connectionDiagnosticsReport } from '../../src/features/voice/connectionDiagnostics';

createApp(VoiceRoom, { roomId: 'recovery-test', serverUrl: 'ws://mikcort.test/ws', displayName: 'Test', roomPassword: '' }).mount('#app');
window.signalingReport = () => JSON.parse(connectionDiagnosticsReport());
