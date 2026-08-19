import { useState, useRef, useCallback } from "react";

interface UseAudioRecorderReturn {
  recording: boolean;
  startRecording: () => Promise<true | string>;
  stopRecording: () => ArrayBuffer | null;
}

export function useAudioRecorder(): UseAudioRecorderReturn {
  const [recording, setRecording] = useState(false);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);

  const startRecording = useCallback(async (): Promise<true | string> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      return "this window exposes no microphone API";
    }
    try {
      chunksRef.current = [];

      // Raw capture: macOS voice processing (echo cancellation, auto gain)
      // ducks and clips dictated speech, which whisper then never sees.
      // Nothing plays back during push-to-talk, so there is no echo to cancel.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          // Auto gain stays: without it the raw signal sits ~30x below the
          // daemon's silence gate. It levels; it does not chop.
          autoGainControl: true,
        },
      });

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      const source = audioCtx.createMediaStreamSource(stream);
      // Half-second buffers: fewer main-thread callbacks, fewer dropped
      // frames while React is busy. Latency does not matter here — the
      // audio only leaves when the user clicks stop.
      const processor = audioCtx.createScriptProcessor(8192, 1, 1);

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        chunksRef.current.push(new Float32Array(inputData));
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      mediaStreamRef.current = stream;
      processorRef.current = processor;
      audioCtxRef.current = audioCtx;
      setRecording(true);
      return true;
    } catch (err: any) {
      console.error("Microphone access error:", err);
      return `${err?.name ?? "error"}: ${err?.message ?? String(err)}`;
    }
  }, []);

  const stopRecording = useCallback((): ArrayBuffer | null => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
    }

    setRecording(false);

    const chunks = chunksRef.current;
    if (chunks.length === 0) return null;

    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    const wavBuffer = encodeWAV(merged, 16000);
    chunksRef.current = [];
    return wavBuffer;
  }, []);

  return { recording, startRecording, stopRecording };
}

export function encodeWAV(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}
