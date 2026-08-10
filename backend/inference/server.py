import asyncio
import concurrent.futures
import io
import os
import re
import tempfile
import time
import numpy as np
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import Response, StreamingResponse

app = FastAPI(title="Jarvis Inference Server")

import json

def load_config():
    try:
        possible_paths = [
            os.path.join(os.path.dirname(__file__), "..", "..", "config.json"),
            os.path.join(os.path.dirname(__file__), "..", "config.json"),
            os.path.join(os.path.dirname(__file__), "config.json")
        ]
        for p in possible_paths:
            if os.path.exists(p):
                with open(p, "r", encoding="utf-8") as f:
                    return json.load(f)
    except Exception as e:
        print(f"[Inference] Error reading config.json: {e}")
    return {
        "model_id": "mlx-community/granite-4.1-8b-4bit",
        "ports": {
            "backend": 8080,
            "inference": 8787,
            "openclaw": 18789
        }
    }

CONFIG = load_config()

def _wire_espeak_fallback():
    try:
        import espeakng_loader
        from phonemizer.backend.espeak.wrapper import EspeakWrapper
        EspeakWrapper.set_library(espeakng_loader.get_library_path())
        EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
        return True
    except Exception as e:
        print(f"[Inference] espeak fallback unavailable ({e}); "
              f"unusual words may fail to synthesise.")
        return False

ESPEAK_READY = _wire_espeak_fallback()

STT_MODEL = CONFIG.get("stt_model", "mlx-community/whisper-large-v3-turbo")
TTS_MODEL = CONFIG.get("tts_model", "mlx-community/Kokoro-82M-bf16")
EMBED_MODEL = (CONFIG.get("retrieval") or {}).get("model", "mlx-community/bge-small-en-v1.5-4bit")

_embed_model = None
_embed_tokenizer = None

stt_loaded = False
tts_loaded = False

from residency import ResidencyManager, ResidencyError, GB

DEFAULT_MODEL_PATH = CONFIG.get("model_id", "mlx-community/granite-4.1-8b-4bit")
ROUTER_MODEL_PATH = (CONFIG.get("router") or {}).get("model") or DEFAULT_MODEL_PATH
GENERATION_MODEL_PATH = (CONFIG.get("generation") or {}).get("model") or DEFAULT_MODEL_PATH

MODELS_CONFIG = CONFIG.get("models") or {}

TIERS = MODELS_CONFIG.get("tiers") or {
    "guard": {"model": ROUTER_MODEL_PATH, "policy": "pinned"},
    "smith": {"model": GENERATION_MODEL_PATH, "policy": "transient"},
}

GUARD_MODEL_PATH = (TIERS.get("guard") or {}).get("model") or ROUTER_MODEL_PATH


def _default_budget_bytes():
    """LLM budget: the Metal working set minus speech, embeddings and KV-cache margin."""
    try:
        import mlx.core as mx
        working_set = mx.device_info()["max_recommended_working_set_size"]
    except Exception:
        working_set = 16 * GB
    voice = float(MODELS_CONFIG.get("voice_reserve_gb", 1.83)) * GB
    return max(working_set - voice - 1.5 * GB, 4 * GB)


BUDGET_BYTES = (float(MODELS_CONFIG["budget_gb"]) * GB
                if MODELS_CONFIG.get("budget_gb") else _default_budget_bytes())


def _load_model(model_id: str):
    from mlx_lm import load
    return load(model_id)


RESIDENCY = ResidencyManager(
    budget_bytes=BUDGET_BYTES,
    tiers=TIERS,
    loader=_load_model,
    known_sizes={k: float(v) * GB
                 for k, v in (MODELS_CONFIG.get("measured_gb") or {}).items()},
    log=lambda msg: print(msg, flush=True),
)

llm_loaded = False


_LLM_WORKER = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="llm")
_FAST_WORKER = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="fast")


async def _run_mlx(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(_LLM_WORKER, fn, *args)


async def _run_fast(fn, *args):
    """Speech and embeddings — small, pinned, latency-critical."""
    return await asyncio.get_running_loop().run_in_executor(_FAST_WORKER, fn, *args)


@app.on_event("startup")
async def warmup():
    global stt_loaded, tts_loaded, llm_loaded
    print(f"[Inference] Loading STT model: {STT_MODEL}")
    try:
        import mlx_whisper
        stt_loaded = True
        print(f"[Inference] STT model ready.")
    except Exception as e:
        print(f"[Inference] STT model failed to load: {e}")

    print(f"[Inference] Loading TTS model: {TTS_MODEL}")
    try:
        import glob as _glob
        import shutil as _shutil
        from mlx_audio.tts.generate import generate_audio as _gen

        _probe = tempfile.mkdtemp(prefix="jarvis-tts-probe-")
        try:
            _gen(text="ready wifi", model=TTS_MODEL, voice="af_heart",
                 file_prefix=os.path.join(_probe, "probe"),
                 audio_format="wav", save=True, verbose=False)
            if _glob.glob(os.path.join(_probe, "probe*.wav")):
                tts_loaded = True
                print(f"[Inference] TTS verified: synthesis produced audio.")
            else:
                print(f"[Inference] TTS FAILED: synthesis produced no audio.")
        finally:
            _shutil.rmtree(_probe, ignore_errors=True)
    except Exception as e:
        print(f"[Inference] TTS FAILED: {e}")

    try:
        await _run_mlx(RESIDENCY.preload, "guard")
        llm_loaded = True
        state = RESIDENCY.state()
        print(f"[Inference] Guard model pinned: {GUARD_MODEL_PATH}")
        print(f"[Inference] Budget {state['budget_gb']} GB, "
              f"{state['used_gb']} GB used; on demand: "
              + ", ".join(f"{tier}={mid.split('/')[-1]}"
                          for tier, mid in state["tiers"].items() if tier != "guard"))
    except Exception as e:
        print(f"[Inference] Guard model failed to load: {e}")


def _extract_messages(req: dict):
    """Extract chat messages from either Chat Completions or Responses API format."""
    formatted_messages = []
    messages_payload = req.get("input") or req.get("messages") or []
    
    for msg in messages_payload:
        if isinstance(msg, dict) and "role" in msg:
            content = msg.get("content", "")
            if isinstance(content, list):
                parts = []
                for c in content:
                    if isinstance(c, dict):
                        if c.get("type") == "input_text":
                            parts.append(c.get("text", ""))
                        elif c.get("type") == "output_text":
                            parts.append(c.get("text", ""))
                        elif c.get("type") == "text":
                            parts.append(c.get("text", ""))
                content_str = " ".join(parts)
            else:
                content_str = str(content) if content else ""
            
            if content_str:
                formatted_messages.append({"role": msg["role"], "content": content_str})
    
    return formatted_messages


def _extract_tools(req: dict):
    """Extract tools from either Chat Completions or Responses API format."""
    tools = req.get("tools")
    if not tools:
        return None
    
    normalized = []
    for tool in tools:
        if tool.get("type") == "function":
            if "function" in tool:
                normalized.append(tool)
            elif "name" in tool:
                normalized.append({
                    "type": "function",
                    "function": {
                        "name": tool["name"],
                        "description": tool.get("description", ""),
                        "parameters": tool.get("parameters", {})
                    }
                })
    return normalized if normalized else None


_THINK_BLOCK = re.compile(r"<think>.*?</think>\s*", re.DOTALL)


def _apply_template(tokenizer, messages, thinking: bool):
    """Render the chat template, disabling reasoning mode where supported."""
    try:
        return tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True,
            enable_thinking=bool(thinking)
        )
    except TypeError:
        return tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )


def _strip_thinking(text: str) -> str:
    """Drop <think> blocks that would corrupt a response parsed as JSON."""
    if "<think>" not in text:
        return text
    stripped = _THINK_BLOCK.sub("", text)
    if "<think>" in stripped:
        stripped = stripped.split("<think>")[0]
    return stripped.strip()


def _generate_llm(req: dict):
    """Run LLM inference and return raw text response."""
    formatted_messages = _extract_messages(req)
    tools = _extract_tools(req)
    
    if tools:
        tools_desc = []
        for t in tools:
            func = t.get("function", {})
            name = func.get("name")
            desc = func.get("description", "")
            schema = func.get("parameters", {}) or {}
            tools_desc.append(
                f"- Tool: {name}\n  Description: {desc}\n"
                f"  Arguments (JSON Schema): {json.dumps(schema)}"
            )
        
        tool_system_message = (
            "You can call the tools below. Call one when it would help, and use "
            "the tools you are given rather than assuming you lack a capability.\n"
            "Here are the available tools:\n" + "\n".join(tools_desc) + "\n\n"
            "To execute a tool, output the XML tag `<tool_call>JSON</tool_call>` containing the tool name and arguments, and nothing else in that reply.\n"
            "When you already have what the user asked for, do NOT call a tool — reply in plain sentences with the answer. Calling a tool and answering are the only two things a reply can be.\n"
            "Example of the shape, using a tool that is not in your list:\n"
            "<tool_call>{\"name\": \"some_tool\", \"arguments\": {\"some_argument\": \"a value\"}}</tool_call>"
        )
        
        system_idx = -1
        for idx, msg in enumerate(formatted_messages):
            if msg["role"] == "system":
                system_idx = idx
                break
        
        if system_idx != -1:
            formatted_messages[system_idx]["content"] += "\n\n" + tool_system_message
        else:
            formatted_messages.insert(0, {"role": "system", "content": tool_system_message})
    
    requested = req.get("model")

    with RESIDENCY.use(requested) as (target_model, target_tokenizer):
        return _generate_with(target_model, target_tokenizer, req,
                              formatted_messages, tools)


def _generate_with(target_model, target_tokenizer, req, formatted_messages, tools):
    """Render the prompt and generate, with the model held against eviction."""
    from mlx_lm import generate

    prompt = ""
    if formatted_messages:
        if hasattr(target_tokenizer, "apply_chat_template"):
            prompt = _apply_template(target_tokenizer, formatted_messages,
                                     req.get("thinking", False))
        else:
            prompt = "\n".join(
                [f"{m['role']}: {m['content']}" for m in formatted_messages]
            ) + "\nassistant:"
    elif "prompt" in req:
        prompt = req["prompt"]
    
    if not prompt:
        return None
    
    print(f"[Inference LLM Prompt]\n{prompt}\n[End Inference LLM Prompt]", flush=True)
    
    max_tokens = req.get("max_tokens") or req.get("max_output_tokens") or 512

    temperature = req.get("temperature")
    top_p = req.get("top_p")

    generate_kwargs = {"max_tokens": max_tokens, "verbose": False}

    response_format = req.get("response_format") or {}
    if response_format.get("type") in ("json_object", "json"):
        try:
            from constrain import JsonConstraint
            generate_kwargs["logits_processors"] = [JsonConstraint(target_tokenizer)]
            print("[Inference] Constrained decoding: json_object", flush=True)
        except Exception as e:
            print(f"[Inference] Constrained decoding unavailable: {e}", flush=True)

    if temperature is not None or top_p is not None:
        try:
            from mlx_lm.sample_utils import make_sampler
            generate_kwargs["sampler"] = make_sampler(
                temp=float(temperature if temperature is not None else 0.0),
                top_p=float(top_p if top_p is not None else 1.0),
            )
        except ImportError:
            print("[Inference] make_sampler unavailable; falling back to default sampling.", flush=True)

    response = generate(target_model, target_tokenizer, prompt=prompt,
                        **generate_kwargs)

    response = _strip_thinking(response)

    if "<tool_call>" in response and "</tool_call>" in response:
        import re
        match = re.search(r"(<tool_call>.*?</tool_call>)", response, re.DOTALL)
        if match:
            raw_tool = match.group(1)
            try:
                json_str = raw_tool.replace("<tool_call>", "").replace("</tool_call>", "").strip()
                import json
                tool_data = json.loads(json_str)
                if isinstance(tool_data, dict) and "arguments" in tool_data:
                    args = tool_data["arguments"]
                    if isinstance(args, dict):
                        if tool_data.get("name") == "web_search":
                            if "domain_filter" in args and not isinstance(args["domain_filter"], list):
                                args["domain_filter"] = []
                            for key in ["max_tokens", "max_tokens_per_page", "count"]:
                                if key in args and not isinstance(args[key], int):
                                    try:
                                        args[key] = int(args[key])
                                    except:
                                        pass
                        tool_data["arguments"] = args
                        response = f"<tool_call>{json.dumps(tool_data)}</tool_call>"
            except Exception as e:
                print(f"[Inference Server] Argument sanitization failed: {e}")
            
    print(f"[Inference LLM Response]\n{response}\n[End Inference LLM Response]", flush=True)
    return response


@app.post("/v1/responses")
async def responses_api(req: dict):
    """OpenAI Responses API endpoint, streaming SSE in the documented event order."""
    import time
    import json
    
    print(f"[Responses API] Incoming request", flush=True)
    
    if not llm_loaded:
        return {"error": "LLM model not loaded"}
    
    try:
        content = await _run_mlx(_generate_llm, req)
        if content is None:
            return {"error": "Failed to extract prompt"}

        print(f"[Responses API] Generated: {content!r}", flush=True)
        
        resp_id = f"resp_{int(time.time())}_{os.urandom(4).hex()}"
        item_id = f"item_{int(time.time())}_{os.urandom(4).hex()}"
        model_id = req.get("model", "granite-4.1-8b-4bit")
        
        import re
        tool_call_items = []
        text_content = content
        
        tc_match = re.search(r'<tool_call>(.*?)</tool_call>', content, re.DOTALL)
        if tc_match:
            try:
                json_match = re.search(r'(\{.*\})', tc_match.group(1), re.DOTALL)
                if json_match:
                    tc_data = json.loads(json_match.group(1))
                    call_id = f"call_{int(time.time())}_{os.urandom(4).hex()}"
                    fc_item_id = f"fc_{int(time.time())}_{os.urandom(4).hex()}"
                    tool_call_items.append({
                        "call_id": call_id,
                        "item_id": fc_item_id,
                        "name": tc_data.get("name", ""),
                        "arguments": json.dumps(tc_data.get("arguments", {}))
                    })
                    text_content = content[:tc_match.start()] + content[tc_match.end():]
                    text_content = text_content.strip()
            except (json.JSONDecodeError, AttributeError) as e:
                print(f"[Responses API] Tool call parse error: {e}", flush=True)
        
        async def generate_responses_stream():
            yield _sse_event("response.created", {
                "type": "response.created",
                "response": {
                    "id": resp_id,
                    "object": "response",
                    "created_at": int(time.time()),
                    "status": "in_progress",
                    "model": model_id,
                    "output": [],
                    "usage": None
                }
            })
            
            if text_content:
                yield _sse_event("response.output_item.added", {
                    "type": "response.output_item.added",
                    "output_index": 0,
                    "item": {
                        "id": item_id,
                        "type": "message",
                        "role": "assistant",
                        "status": "in_progress",
                        "content": []
                    }
                })
                
                yield _sse_event("response.content_part.added", {
                    "type": "response.content_part.added",
                    "item_id": item_id,
                    "output_index": 0,
                    "content_index": 0,
                    "part": {
                        "type": "output_text",
                        "text": ""
                    }
                })
                
                chunk_size = 20
                for i in range(0, len(text_content), chunk_size):
                    chunk = text_content[i:i+chunk_size]
                    yield _sse_event("response.output_text.delta", {
                        "type": "response.output_text.delta",
                        "item_id": item_id,
                        "output_index": 0,
                        "content_index": 0,
                        "delta": chunk
                    })
                
                yield _sse_event("response.output_text.done", {
                    "type": "response.output_text.done",
                    "item_id": item_id,
                    "output_index": 0,
                    "content_index": 0,
                    "text": text_content
                })
                
                yield _sse_event("response.content_part.done", {
                    "type": "response.content_part.done",
                    "item_id": item_id,
                    "output_index": 0,
                    "content_index": 0,
                    "part": {
                        "type": "output_text",
                        "text": text_content
                    }
                })
                
                yield _sse_event("response.output_item.done", {
                    "type": "response.output_item.done",
                    "output_index": 0,
                    "item": {
                        "id": item_id,
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                        "content": [{
                            "type": "output_text",
                            "text": text_content
                        }]
                    }
                })
            
            for idx, tc in enumerate(tool_call_items):
                output_idx = (1 if text_content else 0) + idx
                
                yield _sse_event("response.output_item.added", {
                    "type": "response.output_item.added",
                    "output_index": output_idx,
                    "item": {
                        "id": tc["item_id"],
                        "type": "function_call",
                        "call_id": tc["call_id"],
                        "name": tc["name"],
                        "arguments": "",
                        "status": "in_progress"
                    }
                })
                
                yield _sse_event("response.function_call_arguments.delta", {
                    "type": "response.function_call_arguments.delta",
                    "item_id": tc["item_id"],
                    "output_index": output_idx,
                    "delta": tc["arguments"]
                })
                
                yield _sse_event("response.function_call_arguments.done", {
                    "type": "response.function_call_arguments.done",
                    "item_id": tc["item_id"],
                    "output_index": output_idx,
                    "arguments": tc["arguments"]
                })
                
                yield _sse_event("response.output_item.done", {
                    "type": "response.output_item.done",
                    "output_index": output_idx,
                    "item": {
                        "id": tc["item_id"],
                        "type": "function_call",
                        "call_id": tc["call_id"],
                        "name": tc["name"],
                        "arguments": tc["arguments"],
                        "status": "completed"
                    }
                })
            
            final_output = []
            if text_content:
                final_output.append({
                    "id": item_id,
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{
                        "type": "output_text",
                        "text": text_content
                    }]
                })
            for tc in tool_call_items:
                final_output.append({
                    "id": tc["item_id"],
                    "type": "function_call",
                    "call_id": tc["call_id"],
                    "name": tc["name"],
                    "arguments": tc["arguments"],
                    "status": "completed"
                })
            
            yield _sse_event("response.completed", {
                "type": "response.completed",
                "response": {
                    "id": resp_id,
                    "object": "response",
                    "created_at": int(time.time()),
                    "status": "completed",
                    "model": model_id,
                    "output": final_output,
                    "usage": {
                        "input_tokens": 100,
                        "output_tokens": 100,
                        "total_tokens": 200,
                        "input_tokens_details": {
                            "cached_tokens": 0
                        },
                        "output_tokens_details": {
                            "reasoning_tokens": 0
                        }
                    }
                }
            })
        
        return StreamingResponse(
            generate_responses_stream(),
            media_type="text/event-stream"
        )
    
    except Exception as e:
        print(f"[Responses API] Error: {e}", flush=True)
        import traceback
        traceback.print_exc()
        return {"error": str(e)}


def _sse_event(event_type: str, data: dict) -> str:
    """Format a single SSE event with event type and JSON data."""
    import json
    return f"event: {event_type}\ndata: {json.dumps(data)}\n\n"


@app.get("/v1/models")
async def list_models():
    """Advertise configured models and tiers, flagging which are resident."""
    models = []
    for entry in RESIDENCY.state()["models"]:
        model_id = entry["id"]
        base = {
            "object": "model",
            "owned_by": "organization-owner",
            "role": entry["tier"] or "auxiliary",
            "policy": entry["policy"],
            "loaded": entry["loaded"],
        }
        models.append({**base, "id": model_id})
        if "/" in model_id:
            models.append({**base, "id": model_id.split("/")[-1]})
        if entry["tier"]:
            models.append({**base, "id": entry["tier"]})

    return {"object": "list", "data": models}


@app.get("/residency")
async def residency():
    """Report what is in memory, what it cost, and how much room is left."""
    return RESIDENCY.state()


_TOOL_CALL_RE = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.DOTALL)


def _as_tool_calls(content: str):
    """Translate the model's native <tool_call> tags into structured tool_calls."""
    calls = []
    for index, raw in enumerate(_TOOL_CALL_RE.findall(content or "")):
        try:
            parsed = json.loads(raw)
        except Exception:
            continue
        if not isinstance(parsed, dict):
            continue
        name = parsed.get("name")
        if not name:
            continue
        args = parsed.get("arguments")
        if not isinstance(args, dict):
            args = {}
        calls.append({
            "id": f"call_{int(time.time() * 1000)}_{index}",
            "type": "function",
            "function": {"name": str(name), "arguments": json.dumps(args)},
        })
    return calls


@app.post("/v1/chat/completions")
@app.post("/v1/completions")
async def chat_completions(req: dict):
    """Legacy Chat Completions endpoint (kept for direct testing)."""
    import time
    import json

    if not llm_loaded:
        return {"error": "LLM model not loaded"}

    try:
        content = await _run_mlx(_generate_llm, req)
        if content is None:
            return {"error": "Failed to extract prompt"}

        print(f"[Chat Completions] Generated: {content!r}", flush=True)

        tool_calls = _as_tool_calls(content)
        message = {"role": "assistant", "content": None if tool_calls else content}
        if tool_calls:
            message["tool_calls"] = tool_calls

        return {
            "id": f"chatcmpl-{int(time.time())}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": req.get("model", "granite-4.1-8b-4bit"),
            "choices": [{
                "index": 0,
                "message": message,
                "finish_reason": "tool_calls" if tool_calls else "stop"
            }],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 100,
                "total_tokens": 200
            }
        }
    except Exception as e:
        print(f"[Chat Completions] Error: {e}")
        return {"error": str(e)}


MIN_SPEECH_SECONDS = 0.3
MIN_SPEECH_PEAK = 0.02
NO_SPEECH_THRESHOLD = 0.6


def _wav_stats(path):
    """Duration and peak amplitude of a 16-bit PCM wav; peak is None if unparseable."""
    import wave
    with wave.open(path, "rb") as w:
        frames = w.getnframes()
        rate = w.getframerate() or 16000
        width = w.getsampwidth()
        data = w.readframes(frames)
    duration = frames / float(rate)
    if width != 2 or frames == 0:
        return duration, None
    samples = np.abs(np.frombuffer(data, dtype=np.int16).astype(np.float32)) / 32768.0
    return duration, float(samples.max()) if samples.size else 0.0


@app.post("/stt")
async def speech_to_text(audio: UploadFile = File(...)):
    if not stt_loaded:
        return {"error": "STT model not loaded"}

    import mlx_whisper

    audio_bytes = await audio.read()

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    def _transcribe():
        return mlx_whisper.transcribe(
            tmp_path, path_or_hf_repo=STT_MODEL, language="en",
            condition_on_previous_text=False)

    try:
        try:
            duration, peak = _wav_stats(tmp_path)
        except Exception:
            duration, peak = None, None

        if duration is not None and duration < MIN_SPEECH_SECONDS:
            print(f"[STT] Rejected capture: {duration:.2f}s is too short to be speech.")
            return {"text": ""}
        if peak is not None and peak < MIN_SPEECH_PEAK:
            print(f"[STT] Rejected capture: peak {peak:.4f} is silence.")
            return {"text": ""}

        result = await _run_fast(_transcribe)

        segments = result.get("segments") or []
        if segments:
            kept = [s for s in segments
                    if s.get("no_speech_prob", 0.0) <= NO_SPEECH_THRESHOLD]
            dropped = len(segments) - len(kept)
            if dropped:
                print(f"[STT] Dropped {dropped} segment(s) whisper marked as non-speech.")
            transcript = " ".join(s.get("text", "").strip() for s in kept).strip()
        else:
            transcript = result.get("text", "").strip()

        print(f"[STT] Transcribed: \"{transcript}\"")
        return {"text": transcript}
    finally:
        os.unlink(tmp_path)


@app.post("/tts")
async def text_to_speech(text: str = Form(...), voice: str = Form(default="af_heart")):
    if not tts_loaded:
        return {"error": "TTS model not loaded"}

    from mlx_audio.tts.generate import generate_audio
    import glob
    import shutil

    scratch = tempfile.mkdtemp(prefix="jarvis-tts-")
    prefix = os.path.join(scratch, "chunk")

    def _synthesize():
        generate_audio(
            text=text,
            model=TTS_MODEL,
            voice=voice,
            file_prefix=prefix,
            audio_format="wav",
            join_audio=True,
            save=True,
            verbose=False
        )

    try:
        await _run_fast(_synthesize)

        produced = sorted(glob.glob(prefix + "*.wav"))
        if not produced:
            print(f"[TTS] No audio produced for: {text[:60]!r}")
            return {"error": "no audio produced"}

        with open(produced[0], "rb") as fh:
            data = fh.read()

        print(f"[TTS] Synthesized {len(data)} bytes for: {text[:50]!r}")
        return Response(content=data, media_type="audio/wav")
    except Exception as e:
        print(f"[TTS] Error: {e}")
        return {"error": str(e)}
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


@app.post("/embed")
async def embed(req: dict):
    """Sentence embeddings for skill retrieval."""
    texts = req.get("texts") or []
    if not isinstance(texts, list) or not texts:
        return {"error": "texts must be a non-empty array"}

    def _embed_texts():
        global _embed_model, _embed_tokenizer
        if _embed_model is None:
            from mlx_embeddings import load as _eload
            print(f"[Inference] Loading embedding model: {EMBED_MODEL}", flush=True)
            _embed_model, _embed_tokenizer = _eload(EMBED_MODEL)

        from mlx_embeddings import generate as _egen
        out = _egen(_embed_model, _embed_tokenizer, texts=[str(t) for t in texts])
        return out.text_embeds.tolist()

    try:
        return {"embeddings": await _run_fast(_embed_texts)}
    except Exception as e:
        print(f"[Embed] Error: {e}", flush=True)
        return {"error": str(e)}


@app.get("/health")
async def health():
    state = RESIDENCY.state()
    return {
        "status": "ok" if (stt_loaded and tts_loaded and llm_loaded) else "degraded",
        "stt": {"loaded": stt_loaded, "model": STT_MODEL},
        "tts": {"loaded": tts_loaded, "model": TTS_MODEL, "espeak_fallback": ESPEAK_READY},
        "llm": {
            "loaded": llm_loaded,
            "tiers": state["tiers"],
            "resident": sorted(m["id"] for m in state["models"] if m["loaded"]),
            "budget_gb": state["budget_gb"],
            "used_gb": state["used_gb"],
            "free_gb": state["free_gb"],
        }
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("INFERENCE_PORT", CONFIG.get("ports", {}).get("inference", 8787)))
    print(f"[Inference] Starting on port {port}")
    uvicorn.run(app, host="127.0.0.1", port=port)
