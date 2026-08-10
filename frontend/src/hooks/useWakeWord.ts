import { useState, useRef, useCallback, useEffect } from "react";
import { encodeWAV } from "./useAudioRecorder";

// The always-on front-end's client half: an energy gate finds utterances and
// ships each one to the daemon, where the wake service decides whether it was
// a summons. The mic-privacy contract lives here: nothing is captured until
// the user turns listening on, the indicator is bound to the same state that
// opens the stream, and audio never accumulates beyond the utterance buffer.

const SAMPLE_RATE = 16000;
const FRAME = 2048;
const START_RMS = 0.015;
const KEEP_FRAMES_BEFORE = 4;
const HANG_MS = 700;
const MIN_UTTERANCE_MS = 400;
const MAX_UTTERANCE_MS = 8000;

interface UseWakeWordReturn {
  listening: boolean;
  startListening: () => Promise<boolean>;
  stopListening: () => void;
}

export function useWakeWord(sendBinary: (data: ArrayBuffer) => void): UseWakeWordReturn {
  const [listening, setListening] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const stopListening = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    processorRef.current?.disconnect();
    ctxRef.current?.close();
    streamRef.current = null;
    processorRef.current = null;
    ctxRef.current = null;
    setListening(false);
  }, []);

  const startListening = useCallback(async (): Promise<boolean> => {
    if (streamRef.current) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true },
      });
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(FRAME, 1, 1);

      const recent: Float32Array[] = [];
      let utterance: Float32Array[] | null = null;
      let quietMs = 0;

      const frameMs = (FRAME / SAMPLE_RATE) * 1000;

      const shipUtterance = () => {
        if (!utterance) return;
        const frames = utterance;
        utterance = null;
        const totalMs = frames.length * frameMs;
        if (totalMs < MIN_UTTERANCE_MS) return;

        const total = frames.reduce((n, f) => n + f.length, 0);
        const merged = new Float32Array(total);
        let at = 0;
        for (const frame of frames) {
          merged.set(frame, at);
          at += frame.length;
        }
        sendBinary(encodeWAV(merged, SAMPLE_RATE));
      };

      processor.onaudioprocess = (event) => {
        const frame = new Float32Array(event.inputBuffer.getChannelData(0));
        let energy = 0;
        for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
        const rms = Math.sqrt(energy / frame.length);

        if (utterance) {
          utterance.push(frame);
          quietMs = rms < START_RMS ? quietMs + frameMs : 0;
          if (quietMs >= HANG_MS || utterance.length * frameMs > MAX_UTTERANCE_MS) {
            shipUtterance();
          }
          return;
        }

        recent.push(frame);
        if (recent.length > KEEP_FRAMES_BEFORE) recent.shift();

        if (rms >= START_RMS) {
          utterance = [...recent];
          recent.length = 0;
          quietMs = 0;
        }
      };

      source.connect(processor);
      processor.connect(ctx.destination);

      streamRef.current = stream;
      ctxRef.current = ctx;
      processorRef.current = processor;
      setListening(true);
      return true;
    } catch (err) {
      console.error("Wake listening failed:", err);
      return false;
    }
  }, [sendBinary]);

  useEffect(() => stopListening, [stopListening]);

  return { listening, startListening, stopListening };
}
