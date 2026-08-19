// The Kokoro voices offered by name. Every one of these ships inside the
// TTS model already on disk — picking one downloads nothing.
export const VOICE_CHOICES: { id: string; label: string }[] = [
  { id: "af_heart", label: "Heart — warm American female" },
  { id: "af_bella", label: "Bella — bright American female" },
  { id: "af_nicole", label: "Nicole — soft-spoken American female" },
  { id: "af_sky", label: "Sky — clear American female" },
  { id: "am_adam", label: "Adam — deep American male" },
  { id: "am_michael", label: "Michael — calm American male" },
  { id: "bf_emma", label: "Emma — British female" },
  { id: "bf_isabella", label: "Isabella — refined British female" },
  { id: "bm_george", label: "George — classic British male" },
  { id: "bm_daniel", label: "Daniel — steady British male" },
];
