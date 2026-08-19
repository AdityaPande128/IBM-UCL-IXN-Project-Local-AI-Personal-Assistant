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
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);

  const startRecording = useCallback(async (): Promise<true | string> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      return "this window exposes no microphone API";
    }
    try {
      chunksRef.current = [];

      // The processed capture path is the one WebKit keeps alive; asking it
      // for raw audio stalls the stream after a few buffers.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true },
      });

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      const source = audioCtx.createMediaStreamSource(stream);

      // The worklet captures off the main thread, so words no longer go
      // missing while React is busy; the deprecated in-thread tap remains
      // as the fallback.
      let tapped = false;
      try {
        await audioCtx.audioWorklet.addModule("/capture-worklet.js");
        const node = new AudioWorkletNode(audioCtx, "capture");
        node.port.onmessage = (e) => {
          chunksRef.current.push(new Float32Array(e.data));
        };
        source.connect(node);
        node.connect(audioCtx.destination);
        workletRef.current = node;
        tapped = true;
      } catch (err) {
        console.warn("AudioWorklet unavailable, falling back:", err);
      }

      if (!tapped) {
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (e) => {
          const inputData = e.inputBuffer.getChannelData(0);
          chunksRef.current.push(new Float32Array(inputData));
        };
        source.connect(processor);
        processor.connect(audioCtx.destination);
        processorRef.current = processor;
      }

      mediaStreamRef.current = stream;
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
    if (workletRef.current) {
      workletRef.current.port.onmessage = null;
      workletRef.current.disconnect();
      workletRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
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
