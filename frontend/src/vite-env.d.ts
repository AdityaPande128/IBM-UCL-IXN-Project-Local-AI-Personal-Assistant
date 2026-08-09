declare const __JARVIS_CONFIG__: {
  model_id: string;
  stt_model: string;
  tts_model: string;
  ports: {
    backend: number;
    inference: number;
    openclaw: number;
  };
  security?: {
    enforce_capabilities?: string;
    socket_token_path?: string;
  };
  services?: Record<string, { argv: string[]; cwd: string }>;
};
