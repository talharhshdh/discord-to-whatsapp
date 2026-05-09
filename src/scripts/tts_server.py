"""
tts_server.py
FastAPI server for Qwen3-TTS voice synthesis.
Runs on port 8002. Provides three capabilities:
  POST /tts/generate  — standard TTS (text → speech with optional voice preset)
  POST /tts/clone     — voice cloning (text + reference audio → speech)
  POST /tts/design    — voice design (text + style description → speech)
  GET  /tts/voices    — list built-in voice presets
  GET  /health        — liveness check
"""

import io
import os
import sys
import logging
import tempfile
import time
import threading
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("tts_server")

app = FastAPI(title="Qwen3-TTS Server", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Model state ──────────────────────────────────────────────────────────────

_lock = threading.Lock()
_pipeline = None          # Qwen3-TTS pipeline instance
_pipeline_loading = False
_pipeline_error: Optional[str] = None

# Qwen3-TTS model id on Hugging Face
TTS_MODEL_ID = "Qwen/Qwen3-TTS"

# Built-in voice presets shipped with Qwen3-TTS
# Each value maps to either a preset name accepted by the model or a
# plain-text style instruction understood by the voice-design capability.
VOICE_PRESETS: dict[str, dict] = {
    "alloy":   {"label": "Alloy",   "gender": "neutral", "tone": "warm, balanced"},
    "echo":    {"label": "Echo",    "gender": "male",    "tone": "deep, resonant"},
    "fable":   {"label": "Fable",   "gender": "female",  "tone": "bright, expressive"},
    "onyx":    {"label": "Onyx",    "gender": "male",    "tone": "authoritative, calm"},
    "nova":    {"label": "Nova",    "gender": "female",  "tone": "friendly, energetic"},
    "shimmer": {"label": "Shimmer", "gender": "female",  "tone": "soft, soothing"},
}

# ── Pipeline loader (lazy, background) ───────────────────────────────────────

def _load_pipeline() -> None:
    global _pipeline, _pipeline_loading, _pipeline_error
    try:
        logger.info("Loading Qwen3-TTS pipeline… (this may take a few minutes on first run)")
        _pipeline_loading = True

        # Import here so the server starts even if torch isn't ready yet
        import torch
        from transformers import AutoProcessor, Qwen2AudioForConditionalGeneration

        # Detect best available device
        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype  = torch.float16 if device == "cuda" else torch.float32
        logger.info(f"Using device={device} dtype={dtype}")

        # Try the official Qwen3-TTS pipeline approach
        # Qwen3-TTS is built on the Qwen2-Audio backbone + TTS head
        try:
            from transformers import pipeline as hf_pipeline
            pipe = hf_pipeline(
                "text-to-speech",
                model=TTS_MODEL_ID,
                device=device,
                torch_dtype=dtype,
            )
            _pipeline = pipe
            logger.info("✅ Qwen3-TTS pipeline loaded via transformers pipeline API")
        except Exception as e1:
            logger.warning(f"Pipeline API failed ({e1}), trying manual load…")
            # Fallback: load processor + model manually
            from transformers import AutoTokenizer, AutoModelForCausalLM
            processor = AutoProcessor.from_pretrained(TTS_MODEL_ID, trust_remote_code=True)
            model = AutoModelForCausalLM.from_pretrained(
                TTS_MODEL_ID,
                torch_dtype=dtype,
                trust_remote_code=True,
            ).to(device)
            model.eval()
            _pipeline = {"processor": processor, "model": model, "device": device, "dtype": dtype}
            logger.info("✅ Qwen3-TTS loaded via manual processor+model")

        _pipeline_loading = False
        _pipeline_error = None
    except Exception as e:
        _pipeline_loading = False
        _pipeline_error = str(e)
        logger.error(f"❌ Failed to load Qwen3-TTS: {e}")


def _ensure_pipeline():
    """Start lazy load if not started yet; raise if still loading or errored."""
    global _pipeline_loading
    if _pipeline is not None:
        return  # already loaded
    if _pipeline_error:
        raise RuntimeError(f"Model failed to load: {_pipeline_error}")
    if not _pipeline_loading:
        t = threading.Thread(target=_load_pipeline, daemon=True)
        t.start()
        _pipeline_loading = True
    raise HTTPException(
        status_code=503,
        detail="Model is still loading — retry in a few seconds"
    )


def _synthesise_audio(text: str, voice_style: str = "", reference_audio: Optional[bytes] = None) -> bytes:
    """
    Core synthesis function.
    Returns raw WAV bytes.
    Works with either the pipeline API or the manual processor+model object.
    """
    import numpy as np
    import soundfile as sf

    _ensure_pipeline()

    pipe = _pipeline  # local reference (avoids repeated global lookup)

    with _lock:
        if isinstance(pipe, dict):
            # Manual processor+model path
            processor = pipe["processor"]
            model     = pipe["model"]
            device    = pipe["device"]

            # Build prompt — Qwen3-TTS understands plain-text style instructions
            # prepended inside the system/user turns.
            system_prompt = "You are a high-quality text-to-speech synthesizer."
            if voice_style:
                system_prompt += f" Voice style: {voice_style}."

            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": text},
            ]

            if reference_audio is not None:
                # If a reference clip is provided, pass it as audio context
                import torchaudio
                import torch
                audio_buf = io.BytesIO(reference_audio)
                waveform, sr = torchaudio.load(audio_buf)
                inputs = processor(
                    text=messages,
                    audios=[(waveform, sr)],
                    return_tensors="pt",
                    padding=True,
                ).to(device)
            else:
                import torch
                inputs = processor(
                    text=messages,
                    return_tensors="pt",
                    padding=True,
                ).to(device)

            with torch.no_grad():
                output = model.generate(**inputs, max_new_tokens=2048)

            # Decode audio tokens → waveform
            audio_np = processor.batch_decode(output, skip_special_tokens=True)[0]
            if isinstance(audio_np, str):
                # Some model versions return text instead of audio; handle gracefully
                raise RuntimeError("Model returned text instead of audio — ensure TTS head is installed")

        else:
            # transformers pipeline API path
            import torch
            kwargs: dict = {}
            if voice_style:
                kwargs["forward_params"] = {"voice_description": voice_style}
            if reference_audio is not None:
                import torchaudio
                audio_buf = io.BytesIO(reference_audio)
                waveform, sr = torchaudio.load(audio_buf)
                kwargs["forward_params"] = {
                    **(kwargs.get("forward_params") or {}),
                    "reference_audio": (waveform.numpy(), sr),
                }

            result = pipe(text, **kwargs)
            # pipeline returns {"audio": np.ndarray, "sampling_rate": int}
            audio_np     = result["audio"].squeeze()
            sampling_rate = result["sampling_rate"]

    # Write to WAV in-memory
    buf = io.BytesIO()
    if isinstance(pipe, dict):
        sf.write(buf, audio_np, 22050, format="WAV")
    else:
        sf.write(buf, audio_np, sampling_rate, format="WAV")
    buf.seek(0)
    return buf.read()


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class TTSRequest(BaseModel):
    text: str
    voice: str = "alloy"          # one of VOICE_PRESETS keys
    speed: float = 1.0            # 0.5 – 2.0
    format: str = "wav"           # wav | mp3


class VoiceDesignRequest(BaseModel):
    text: str
    style: str                    # free-text style description
    format: str = "wav"


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    global _pipeline, _pipeline_loading, _pipeline_error
    return {
        "status": "ok",
        "model_loaded": _pipeline is not None,
        "loading": _pipeline_loading,
        "error": _pipeline_error,
    }


@app.get("/tts/voices")
def list_voices():
    return {"voices": [
        {"id": k, "label": v["label"], "gender": v["gender"], "tone": v["tone"]}
        for k, v in VOICE_PRESETS.items()
    ]}


@app.post("/tts/generate")
async def tts_generate(req: TTSRequest):
    """Standard TTS: text → speech with a built-in voice preset."""
    if not req.text.strip():
        raise HTTPException(400, "text must not be empty")

    preset = VOICE_PRESETS.get(req.voice, VOICE_PRESETS["alloy"])
    voice_style = f"{preset['tone']}, {preset['gender']} voice"

    try:
        wav_bytes = _synthesise_audio(req.text, voice_style=voice_style)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"/tts/generate error: {e}")
        raise HTTPException(500, str(e))

    media_type = "audio/wav" if req.format == "wav" else "audio/mpeg"
    return Response(
        content=wav_bytes,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="tts_{int(time.time())}.{req.format}"'},
    )


@app.post("/tts/clone")
async def tts_clone(
    text: str = Form(...),
    reference_audio: UploadFile = File(...),
    format: str = Form("wav"),
):
    """Voice cloning: synthesise `text` using a reference audio clip as the target voice."""
    if not text.strip():
        raise HTTPException(400, "text must not be empty")

    ref_bytes = await reference_audio.read()
    if len(ref_bytes) < 1024:
        raise HTTPException(400, "Reference audio file is too small or empty")

    try:
        wav_bytes = _synthesise_audio(text, reference_audio=ref_bytes)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"/tts/clone error: {e}")
        raise HTTPException(500, str(e))

    media_type = "audio/wav" if format == "wav" else "audio/mpeg"
    return Response(
        content=wav_bytes,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="clone_{int(time.time())}.{format}"'},
    )


@app.post("/tts/design")
async def tts_design(req: VoiceDesignRequest):
    """Voice design: synthesise `text` with a custom style described in plain text."""
    if not req.text.strip():
        raise HTTPException(400, "text must not be empty")
    if not req.style.strip():
        raise HTTPException(400, "style must not be empty")

    try:
        wav_bytes = _synthesise_audio(req.text, voice_style=req.style)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"/tts/design error: {e}")
        raise HTTPException(500, str(e))

    media_type = "audio/wav" if req.format == "wav" else "audio/mpeg"
    return Response(
        content=wav_bytes,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="design_{int(time.time())}.{req.format}"'},
    )


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.environ.get("TTS_SERVER_PORT", 8002))
    logger.info(f"🚀 TTS Server starting on port {port}")
    # Kick off background model load immediately so it's ready sooner
    t = threading.Thread(target=_load_pipeline, daemon=True)
    t.start()
    _pipeline_loading = True
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
