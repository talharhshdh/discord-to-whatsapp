"""
tts_server.py
FastAPI server for Qwen3-TTS voice synthesis using the official `qwen-tts` package.
Runs on port 8002.

Three models are loaded lazily on first use:
  - Qwen3-TTS-12Hz-0.6B-CustomVoice  → /tts/generate  (built-in speaker presets)
  - Qwen3-TTS-12Hz-0.6B-Base         → /tts/clone     (voice cloning from ref audio)
  - Qwen3-TTS-12Hz-1.7B-VoiceDesign  → /tts/design    (natural-language style description)

GET  /health        → liveness + loaded-model state
GET  /tts/voices    → list built-in speakers for the CustomVoice model
POST /tts/generate  → standard TTS (JSON body: text, speaker, language, instruct?)
POST /tts/clone     → voice clone (multipart: text, reference_audio, ref_text, language)
POST /tts/design    → voice design (JSON body: text, style, language)
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
from fastapi.responses import Response
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("tts_server")

app = FastAPI(title="Qwen3-TTS Server", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Model IDs ─────────────────────────────────────────────────────────────────

MODEL_CUSTOM_VOICE = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
MODEL_BASE         = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
MODEL_DESIGN       = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"

# ── Model registry ────────────────────────────────────────────────────────────

_lock = threading.Lock()

class _ModelEntry:
    def __init__(self, model_id: str):
        self.model_id = model_id
        self.model = None
        self.loading = False
        self.error: Optional[str] = None

    def is_ready(self) -> bool:
        return self.model is not None

_models: dict[str, _ModelEntry] = {
    "custom_voice": _ModelEntry(MODEL_CUSTOM_VOICE),
    "base":         _ModelEntry(MODEL_BASE),
    "design":       _ModelEntry(MODEL_DESIGN),
}

def _load_model(key: str) -> None:
    entry = _models[key]
    if entry.is_ready() or entry.loading:
        return
    entry.loading = True
    try:
        import torch
        from qwen_tts import Qwen3TTSModel
        logger.info(f"Loading {entry.model_id} …")
        device = "cuda:0" if _has_cuda() else "cpu"
        kwargs = dict(
            device_map=device,
            dtype=torch.bfloat16,
        )
        # flash_attention_2 only works on CUDA
        if _has_cuda():
            kwargs["attn_implementation"] = "flash_attention_2"
        m = Qwen3TTSModel.from_pretrained(entry.model_id, **kwargs)
        entry.model = m
        entry.error = None
        logger.info(f"✅ {entry.model_id} loaded")
    except Exception as e:
        entry.error = str(e)
        logger.error(f"❌ Failed to load {entry.model_id}: {e}")
    finally:
        entry.loading = False


def _has_cuda() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


def _ensure(key: str):
    """Returns the model or raises HTTPException."""
    entry = _models[key]
    if entry.is_ready():
        return entry.model
    if entry.error:
        raise HTTPException(503, f"Model failed to load: {entry.error}")
    if not entry.loading:
        t = threading.Thread(target=_load_model, args=(key,), daemon=True)
        t.start()
    raise HTTPException(503, "Model is loading — retry in a few seconds")


def _wav_to_bytes(wav_array, sr: int) -> bytes:
    import soundfile as sf
    buf = io.BytesIO()
    sf.write(buf, wav_array, sr, format="WAV")
    buf.seek(0)
    return buf.read()


def _audio_response(wav_bytes: bytes, prefix: str) -> Response:
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={"Content-Disposition": f'attachment; filename="{prefix}_{int(time.time())}.wav"'},
    )

# ── Built-in speaker list ─────────────────────────────────────────────────────
# Official speakers from Qwen3-TTS-12Hz-1.7B-CustomVoice
# (native language shown for best quality)

CUSTOM_VOICE_SPEAKERS = [
    {"id": "Vivian",    "label": "Vivian",    "gender": "female", "lang": "Chinese",  "tone": "Expressive, emotional"},
    {"id": "Ryan",      "label": "Ryan",      "gender": "male",   "lang": "English",  "tone": "Clear, confident"},
    {"id": "Ethan",     "label": "Ethan",     "gender": "male",   "lang": "English",  "tone": "Friendly, conversational"},
    {"id": "Sophia",    "label": "Sophia",    "gender": "female", "lang": "English",  "tone": "Warm, professional"},
    {"id": "Isabella",  "label": "Isabella",  "gender": "female", "lang": "Spanish",  "tone": "Energetic, lively"},
    {"id": "Lucas",     "label": "Lucas",     "gender": "male",   "lang": "Portuguese","tone": "Deep, articulate"},
    {"id": "Mia",       "label": "Mia",       "gender": "female", "lang": "German",   "tone": "Crisp, precise"},
    {"id": "Noah",      "label": "Noah",      "gender": "male",   "lang": "French",   "tone": "Smooth, sophisticated"},
    {"id": "Yuna",      "label": "Yuna",      "gender": "female", "lang": "Korean",   "tone": "Soft, gentle"},
    {"id": "Hiroshi",   "label": "Hiroshi",   "gender": "male",   "lang": "Japanese", "tone": "Calm, measured"},
]

# ── Health ─────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "model_loaded": any(e.is_ready() for e in _models.values()),
        "loading": any(e.loading for e in _models.values()),
        "error": next((e.error for e in _models.values() if e.error), None),
        "models": {
            k: {
                "loaded": e.is_ready(),
                "loading": e.loading,
                "error": e.error,
            }
            for k, e in _models.items()
        },
    }

# ── Voices ────────────────────────────────────────────────────────────────────

@app.get("/tts/voices")
def list_voices():
    # Try to get live speaker list from the model if loaded, else return static list
    entry = _models["custom_voice"]
    if entry.is_ready():
        try:
            speakers = entry.model.get_supported_speakers()
            langs    = entry.model.get_supported_languages()
            # Build compact list from live data, augmenting with our static metadata
            static_map = {s["id"]: s for s in CUSTOM_VOICE_SPEAKERS}
            voices = []
            for sp in speakers:
                meta = static_map.get(sp, {"gender": "neutral", "lang": "Auto", "tone": "Natural"})
                voices.append({"id": sp, "label": sp, "gender": meta.get("gender", "neutral"),
                                "lang": meta.get("lang", "Auto"), "tone": meta.get("tone", "Natural")})
            return {"voices": voices, "languages": langs}
        except Exception:
            pass
    return {"voices": CUSTOM_VOICE_SPEAKERS, "languages": [
        "Auto", "Chinese", "English", "Japanese", "Korean",
        "German", "French", "Russian", "Portuguese", "Spanish", "Italian",
    ]}

# ── TTS Generate (CustomVoice) ────────────────────────────────────────────────

class TTSRequest(BaseModel):
    text: str
    speaker: str = "Vivian"
    language: str = "Auto"
    instruct: str = ""   # optional style instruction e.g. "Very happy."

@app.post("/tts/generate")
async def tts_generate(req: TTSRequest):
    if not req.text.strip():
        raise HTTPException(400, "text must not be empty")
    model = _ensure("custom_voice")
    try:
        with _lock:
            wavs, sr = model.generate_custom_voice(
                text=req.text,
                language=req.language,
                speaker=req.speaker,
                instruct=req.instruct if req.instruct.strip() else None,
                max_new_tokens=2048,
            )
        return _audio_response(_wav_to_bytes(wavs[0], sr), "tts")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"/tts/generate error: {e}")
        raise HTTPException(500, str(e))

# ── Voice Clone (Base) ─────────────────────────────────────────────────────────

@app.post("/tts/clone")
async def tts_clone(
    text: str = Form(...),
    ref_text: str = Form(...),
    language: str = Form("Auto"),
    reference_audio: UploadFile = File(...),
):
    """
    Voice cloning — synthesise `text` using the voice from the uploaded reference audio.
    `ref_text` is the transcript of the reference clip (improves quality significantly).
    """
    if not text.strip():
        raise HTTPException(400, "text must not be empty")
    if not ref_text.strip():
        raise HTTPException(400, "ref_text (transcript of the reference clip) must not be empty")

    ref_bytes = await reference_audio.read()
    if len(ref_bytes) < 1024:
        raise HTTPException(400, "Reference audio file is too small or empty")

    # Write to a temp file so the model can read it
    suffix = Path(reference_audio.filename or "ref.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(ref_bytes)
        tmp_path = tmp.name

    model = _ensure("base")
    try:
        with _lock:
            wavs, sr = model.generate_voice_clone(
                text=text,
                language=language,
                ref_audio=tmp_path,
                ref_text=ref_text,
                max_new_tokens=2048,
            )
        return _audio_response(_wav_to_bytes(wavs[0], sr), "clone")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"/tts/clone error: {e}")
        raise HTTPException(500, str(e))
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass

# ── Voice Design ──────────────────────────────────────────────────────────────

class VoiceDesignRequest(BaseModel):
    text: str
    style: str        # natural-language voice description
    language: str = "Auto"

@app.post("/tts/design")
async def tts_design(req: VoiceDesignRequest):
    if not req.text.strip():
        raise HTTPException(400, "text must not be empty")
    if not req.style.strip():
        raise HTTPException(400, "style must not be empty")
    model = _ensure("design")
    try:
        with _lock:
            wavs, sr = model.generate_voice_design(
                text=req.text,
                language=req.language,
                instruct=req.style,
                max_new_tokens=2048,
            )
        return _audio_response(_wav_to_bytes(wavs[0], sr), "design")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"/tts/design error: {e}")
        raise HTTPException(500, str(e))

# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.environ.get("TTS_SERVER_PORT", 8002))
    logger.info(f"🚀 TTS Server starting on port {port}")
    # Kick off CustomVoice model loading immediately (most commonly used)
    threading.Thread(target=_load_model, args=("custom_voice",), daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
