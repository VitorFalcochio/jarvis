"""
JARVIS - serviço de voz.

Pipeline:  microfone -> wake word ("hey jarvis") -> gravação até silêncio
           -> faster-whisper (pt) -> transcrição enviada ao Electron.
TTS:       edge-tts -> mp3 (base64) enviado ao Electron, que toca o áudio.

Protocolo WebSocket (JSON) em ws://127.0.0.1:8765
  Electron -> Python: {"cmd": "listen", "timeout": 6}   escuta sem wake word
                      {"cmd": "pause"} / {"cmd": "resume"} ignora/volta a ouvir o mic
                      {"cmd": "speak", "id": n, "text": "..."}
                      {"cmd": "config", "voice": "...", "wake_threshold": 0.5}
                      mensagem binária: PCM 16 kHz mono int16 do microfone do fone (substitui o mic do PC)
  Python -> Electron: {"event": "ready"} / "wake" / "listening" / "processing"
                      {"event": "transcript", "text": "..."}
                      {"event": "no_speech"}
                      {"event": "level", "value": 0..1}
                      {"event": "audio", "id": n, "data": "<base64 mp3>"}
                      {"event": "error", "message": "..."}
"""
import asyncio
import io
import base64
import json
import os
import queue
import sys
import threading
import time

import numpy as np
import sounddevice as sd

# Modelos do Whisper ficam dentro do projeto (não no cache do disco C:)
os.environ.setdefault("HF_HOME", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

SAMPLE_RATE = 16000
FRAME = 1280  # 80 ms, tamanho que o openwakeword espera
HOST, PORT = "127.0.0.1", int(os.environ.get("JARVIS_PORT", "8765"))
WHISPER_MODEL = os.environ.get("JARVIS_WHISPER", "base")

state = {
    "voice": "pt-BR-AntonioNeural",
    "wake_threshold": 0.5,
    "mode": "wake",  # wake | record | paused | watch (JARVIS falando; você pode interromper)
    "barge_sensitivity": 1.0,  # maior = precisa falar mais alto para interromper
    "record_timeout": None,
    "ext_at": 0.0,  # último bloco de áudio vindo de fora (microfone do fone no celular)
}
EXT_HOLD = 0.5  # enquanto o celular manda áudio, o microfone do PC é ignorado (e volta sozinho se parar)

clients = set()
ready = False
loop: asyncio.AbstractEventLoop = None
audio_q: "queue.Queue[np.ndarray]" = queue.Queue()
control_q: "queue.Queue[dict]" = queue.Queue()


def log(*a):
    print("[voice]", *a, file=sys.stderr, flush=True)


def emit(event: str, **data):
    msg = json.dumps({"event": event, **data})
    if loop is None:
        return

    async def _send():
        for ws in list(clients):
            try:
                await ws.send(msg)
            except Exception:
                clients.discard(ws)

    asyncio.run_coroutine_threadsafe(_send(), loop)


# ---------------------------------------------------------------- áudio

def open_stream():
    """Abre o microfone a 16 kHz; se o driver não aceitar, captura na taxa nativa e reamostra."""
    def make_cb(ratio):
        def cb(indata, frames, t, status):
            if time.time() - state["ext_at"] < EXT_HOLD:
                return  # o microfone do fone (pelo celular) está no lugar do microfone do PC
            mono = indata[:, 0].astype(np.float32)
            if ratio != 1.0:
                n = int(len(mono) / ratio)
                mono = np.interp(np.linspace(0, len(mono) - 1, n), np.arange(len(mono)), mono)
            audio_q.put(mono.astype(np.int16))
        return cb

    try:
        s = sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16",
                           blocksize=FRAME, callback=make_cb(1.0))
        s.start()
        return s
    except Exception as e:
        native = int(sd.query_devices(kind="input")["default_samplerate"])
        log(f"16 kHz indisponível ({e}); usando {native} Hz com reamostragem")
        s = sd.InputStream(samplerate=native, channels=1, dtype="int16",
                           blocksize=int(FRAME * native / SAMPLE_RATE),
                           callback=make_cb(native / SAMPLE_RATE))
        s.start()
        return s


def frames():
    """Gera blocos de exatamente FRAME amostras."""
    buf = np.zeros(0, dtype=np.int16)
    while True:
        buf = np.concatenate([buf, audio_q.get()])
        while len(buf) >= FRAME:
            yield buf[:FRAME]
            buf = buf[FRAME:]


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean((x.astype(np.float32) / 32768.0) ** 2)) + 1e-9)


def audio_worker():
    from openwakeword.model import Model
    from openwakeword.utils import download_models
    from faster_whisper import WhisperModel

    emit("status", message="Carregando modelos de voz...")
    download_models(["hey_jarvis"])
    oww = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")
    log(f"carregando whisper '{WHISPER_MODEL}'...")
    whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)
    log("modelos prontos")

    global ready, shared_whisper
    shared_whisper = whisper
    stream = open_stream()
    ready = True
    emit("ready")

    noise = 0.01          # piso de ruído adaptativo
    watch_buf = []        # últimos quadros no modo watch (o começo da fala não se perde)
    watch_streak = 0
    recording = []
    speech_started = False
    silence_frames = 0
    record_start = 0.0
    level_tick = 0

    for frame in frames():
        # comandos vindos do Electron
        while not control_q.empty():
            c = control_q.get()
            if c["cmd"] == "listen":
                state["mode"] = "record"
                state["record_timeout"] = c.get("timeout", 8)
                recording, speech_started, silence_frames = [], False, 0
                record_start = time.time()
                emit("listening")
            elif c["cmd"] == "pause":
                state["mode"] = "paused"
            elif c["cmd"] == "watch":
                state["mode"] = "watch"
                watch_buf.clear()
                watch_streak = 0
            elif c["cmd"] == "resume":
                state["mode"] = "wake"
                oww.reset()

        level = rms(frame)
        level_tick += 1
        if level_tick % 2 == 0:
            emit("level", value=min(1.0, level * 12))

        mode = state["mode"]
        if mode == "paused":
            continue

        if mode == "watch":
            # O JARVIS está falando: se o usuário falar por ~0,3 s, interrompe e já começa a gravar
            watch_buf.append(frame)
            if len(watch_buf) > 6:
                watch_buf.pop(0)
            limit = max(0.035, noise * 4) * state["barge_sensitivity"]
            watch_streak = watch_streak + 1 if level > limit else 0
            if watch_streak >= 4:
                log("interrompido pelo usuário")
                state["mode"] = "record"
                state["record_timeout"] = 8
                recording, speech_started, silence_frames = list(watch_buf), True, 0
                record_start = time.time()
                watch_streak = 0
                emit("barge_in")
                emit("listening")
            continue

        if mode == "wake":
            noise = 0.95 * noise + 0.05 * level if level < noise * 3 else noise
            score = oww.predict(frame).get("hey_jarvis", 0.0)
            if score >= state["wake_threshold"]:
                log(f"wake word ({score:.2f})")
                oww.reset()
                state["mode"] = "record"
                state["record_timeout"] = 8
                recording, speech_started, silence_frames = [], False, 0
                record_start = time.time()
                emit("wake")
                emit("listening")
            continue

        # mode == "record"
        recording.append(frame)
        threshold = max(0.015, noise * 2.5)
        if level > threshold:
            speech_started = True
            silence_frames = 0
        else:
            silence_frames += 1

        elapsed = time.time() - record_start
        ended = speech_started and silence_frames >= 10            # ~0,8 s de silêncio
        timed_out = not speech_started and elapsed > state["record_timeout"]
        too_long = elapsed > 30

        if timed_out:
            state["mode"] = "wake"
            oww.reset()
            emit("no_speech")
        elif ended or too_long:
            state["mode"] = "paused"  # o Electron manda "resume" depois de responder
            emit("processing")
            audio = np.concatenate(recording).astype(np.float32) / 32768.0
            try:
                with transcribe_lock:
                    segments, _ = whisper.transcribe(
                        audio, language="pt", beam_size=1, vad_filter=True,
                        initial_prompt="Jarvis, assistente pessoal. Português do Brasil.")
                    text = " ".join(s.text.strip() for s in segments).strip()
            except Exception as e:
                log("erro no whisper:", e)
                text = ""
            log("transcrição:", text)
            if text:
                emit("transcript", text=text)
            else:
                state["mode"] = "wake"
                emit("no_speech")


# ---------------------------------------------------------------- TTS

# ---------------------------------------------------------------- áudio vindo de fora (celular, Telegram)

shared_whisper = None
transcribe_lock = threading.Lock()


def decode_audio(data: bytes) -> np.ndarray:
    """Decodifica qualquer formato (webm/opus do celular, ogg do Telegram, mp4/aac do iPhone) para 16 kHz mono."""
    import io
    import av
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    pcm = []
    with av.open(io.BytesIO(data)) as container:
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                pcm.append(out.to_ndarray().flatten())
    if not pcm:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(pcm).astype(np.float32) / 32768.0


def transcribe_bytes(data: bytes) -> str:
    audio = decode_audio(data)
    if len(audio) < SAMPLE_RATE * 0.3:
        return ""
    with transcribe_lock:  # o mesmo modelo atende o microfone do PC; um de cada vez
        segments, _ = shared_whisper.transcribe(
            audio, language="pt", beam_size=1, vad_filter=True,
            initial_prompt="Jarvis, assistente pessoal. Português do Brasil.")
        return " ".join(s.text.strip() for s in segments).strip()


async def transcribe(msg_id, b64):
    if shared_whisper is None:
        emit("transcription", id=msg_id, text="", error="modelos ainda carregando")
        return
    try:
        text = await asyncio.get_running_loop().run_in_executor(None, transcribe_bytes, base64.b64decode(b64))
        emit("transcription", id=msg_id, text=text)
    except Exception as e:
        log("erro ao transcrever:", repr(e))
        emit("transcription", id=msg_id, text="", error=str(e))


async def speak(msg_id, text, timed=False, rate="+8%"):
    """timed=True também devolve o instante de cada palavra (o documentário sincroniza a tela com a voz)."""
    import edge_tts
    try:
        kw = {"boundary": "WordBoundary"} if timed else {}
        com = edge_tts.Communicate(text, state["voice"], rate=rate, pitch="-4Hz", **kw)
        chunks, words = [], []
        async for part in com.stream():
            if part["type"] == "audio":
                chunks.append(part["data"])
            elif part["type"] == "WordBoundary":
                # offset/duration vêm em unidades de 100 ns
                words.append({"t": part["offset"] / 1e7, "d": part["duration"] / 1e7, "w": part["text"]})
        data = base64.b64encode(b"".join(chunks)).decode()
        if timed:
            emit("audio", id=msg_id, data=data, words=words)
        else:
            emit("audio", id=msg_id, data=data)
    except Exception as e:
        log("erro no TTS:", e)
        emit("audio", id=msg_id, data="", error=str(e))


def encode_ogg(pcm_b64):
    """PCM 16 bits, 48 kHz, mono -> OGG/Opus (o formato das mensagens de voz do Telegram)."""
    import av
    pcm = np.frombuffer(base64.b64decode(pcm_b64), dtype=np.int16).reshape(1, -1)
    buf = io.BytesIO()
    out = av.open(buf, "w", format="ogg")
    st = out.add_stream("libopus", rate=48000)
    st.layout = "mono"
    st.bit_rate = 48000
    frame = av.AudioFrame.from_ndarray(pcm, format="s16", layout="mono")
    frame.sample_rate = 48000
    for p in st.encode(frame):
        out.mux(p)
    for p in st.encode(None):
        out.mux(p)
    out.close()
    return base64.b64encode(buf.getvalue()).decode()


async def ogg(msg_id, pcm_b64):
    try:
        data = await asyncio.get_running_loop().run_in_executor(None, encode_ogg, pcm_b64)
        emit("ogg", id=msg_id, data=data)
    except Exception as e:
        log("erro ao gerar OGG:", repr(e))
        emit("ogg", id=msg_id, data="", error=str(e))


# ---------------------------------------------------------------- servidor

async def handler(ws):
    clients.add(ws)
    if ready:
        await ws.send(json.dumps({"event": "ready"}))
    try:
        async for raw in ws:
            if isinstance(raw, bytes):
                # binário = microfone do fone pelo celular: PCM 16 bits, 16 kHz, mono (o Electron já reamostra)
                if time.time() - state["ext_at"] >= EXT_HOLD:
                    log("microfone do fone (celular) assumiu; o do PC fica em espera")
                state["ext_at"] = time.time()
                audio_q.put(np.frombuffer(raw, dtype=np.int16).copy())
                continue
            try:
                c = json.loads(raw)
            except ValueError:
                continue
            cmd = c.get("cmd")
            if cmd == "transcribe":
                asyncio.create_task(transcribe(c.get("id"), c.get("data", "")))
            elif cmd == "speak":
                asyncio.create_task(speak(c.get("id"), c.get("text", ""), bool(c.get("timed")), c.get("rate") or "+8%"))
            elif cmd == "ogg":
                asyncio.create_task(ogg(c.get("id"), c.get("pcm", "")))
            elif cmd == "config":
                if c.get("voice"):
                    state["voice"] = c["voice"]
                if c.get("wake_threshold"):
                    state["wake_threshold"] = float(c["wake_threshold"])
                if c.get("barge_sensitivity"):
                    state["barge_sensitivity"] = float(c["barge_sensitivity"])
            elif cmd in ("listen", "pause", "resume", "watch"):
                control_q.put(c)
    finally:
        clients.discard(ws)


async def main():
    global loop
    import websockets
    loop = asyncio.get_running_loop()
    async with websockets.serve(handler, HOST, PORT, max_size=None):
        log(f"WebSocket em ws://{HOST}:{PORT}")
        threading.Thread(target=audio_thread, daemon=True).start()
        await asyncio.Future()


def audio_thread():
    try:
        audio_worker()
    except Exception as e:
        log("falha no áudio:", repr(e))
        emit("error", message=f"Falha no microfone/modelos: {e}")


if __name__ == "__main__":
    asyncio.run(main())
