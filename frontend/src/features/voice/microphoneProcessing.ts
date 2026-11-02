import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

export type NoiseSuppressionMode = 'off' | 'standard' | 'rnnoise';

export function normalizeNoiseSuppressionMode(value: string): NoiseSuppressionMode {
  return value === 'off' || value === 'standard' ? value : 'rnnoise';
}

let rnnoiseBinary: Promise<ArrayBuffer> | undefined;

function loadRnnoiseBinary() {
  if (rnnoiseBinary) {
    return rnnoiseBinary;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  rnnoiseBinary = loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }, {
    signal: controller.signal,
  }).then((binary) => {
    // Catch invalid assets and CSP failures before the worklet's async initialization.
    if (!WebAssembly.validate(binary)) {
      throw new Error('Invalid RNNoise WebAssembly binary.');
    }
    return binary;
  }).catch((error: unknown) => {
    rnnoiseBinary = undefined;
    throw error;
  }).finally(() => {
    clearTimeout(timeout);
  });
  return rnnoiseBinary;
}

interface MicrophoneOptions {
  deviceId: string;
  noiseSuppression: NoiseSuppressionMode;
  echoCancellation: boolean;
  autoGainControl: boolean;
  signal: AbortSignal;
  onNotice: (message: string) => void;
}

export type MicrophonePipeline = Awaited<ReturnType<typeof createMicrophonePipeline>>;

export async function createMicrophonePipeline(options: MicrophoneOptions) {
  let rawStream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let rnnoise: RnnoiseWorkletNode | undefined;
  let destroyed = false;

  function throwIfAborted() {
    if (options.signal.aborted) {
      throw new DOMException('Microphone setup was cancelled.', 'AbortError');
    }
  }

  function destroy() {
    destroyed = true;
    options.signal.removeEventListener('abort', destroy);
    rawStream?.getTracks().forEach((track) => track.stop());
    destination?.stream.getTracks().forEach((track) => track.stop());
    if (rnnoise) {
      rnnoise.destroy();
      rnnoise.disconnect();
      rnnoise.port.close();
      rnnoise = undefined;
    }
    if (context && context.state !== 'closed') {
      void context.close().catch(() => {});
    }
  }

  throwIfAborted();
  options.signal.addEventListener('abort', destroy, { once: true });

  try {
    rawStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48_000 },
        noiseSuppression: options.noiseSuppression === 'standard',
        echoCancellation: options.echoCancellation,
        autoGainControl: options.autoGainControl,
      },
    });
    throwIfAborted();

    // RNNoise expects 480-sample frames at 48 kHz. Web Audio resamples the input.
    context = new AudioContext({ sampleRate: 48_000 });
    const source = context.createMediaStreamSource(rawStream);
    const sensitivityGain = context.createGain();
    const analyser = context.createAnalyser();
    const gain = context.createGain();
    destination = context.createMediaStreamDestination();
    analyser.fftSize = 1024;

    const connectInput = (input: AudioNode) => {
      input.connect(analyser);
      input.connect(sensitivityGain);
    };

    async function enableStandardFallback() {
      throwIfAborted();
      try {
        await rawStream!.getAudioTracks()[0].applyConstraints({ noiseSuppression: true });
        if (!destroyed) {
          options.onNotice('RNNoise is unavailable. Standard noise suppression is active.');
        }
      } catch {
        throwIfAborted();
        if (!destroyed) {
          options.onNotice('RNNoise is unavailable. Noise suppression is off. Try Standard mode.');
        }
      }
    }

    if (options.noiseSuppression === 'rnnoise') {
      try {
        if (!context.audioWorklet || context.sampleRate !== 48_000) {
          throw new Error('RNNoise requires AudioWorklet at 48 kHz.');
        }
        const wasmBinary = await loadRnnoiseBinary();
        throwIfAborted();
        await context.audioWorklet.addModule(rnnoiseWorkletUrl);
        throwIfAborted();
        rnnoise = new RnnoiseWorkletNode(context, { wasmBinary, maxChannels: 1 });
        rnnoise.channelCount = 1;
        rnnoise.channelCountMode = 'explicit';
        const node = rnnoise;
        node.addEventListener('processorerror', () => {
          if (destroyed || rnnoise !== node) {
            return;
          }
          source.disconnect(node);
          node.disconnect();
          node.destroy();
          node.port.close();
          rnnoise = undefined;
          connectInput(source);
          void enableStandardFallback().catch(() => {});
        }, { once: true });
        source.connect(node);
        connectInput(node);
      } catch {
        throwIfAborted();
        if (rnnoise) {
          source.disconnect();
          rnnoise.destroy();
          rnnoise.disconnect();
          rnnoise.port.close();
          rnnoise = undefined;
        }
        await enableStandardFallback();
        connectInput(source);
      }
    } else {
      connectInput(source);
    }

    sensitivityGain.connect(gain);
    gain.connect(destination);
    await context.resume();
    throwIfAborted();

    return { rawStream, stream: destination.stream, context, gain, sensitivityGain, analyser, destroy };
  } catch (error) {
    destroy();
    throw error;
  }
}
