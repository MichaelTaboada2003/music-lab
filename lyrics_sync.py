"""
lyrics_sync.py
==================
Módulo central que alinea la letra REAL de una canción (la que tú escribes
en un .txt) con las marcas de tiempo detectadas en el audio mediante
Whisper. El resultado es una estructura de estrofas/líneas/palabras con
tiempos (start/end) que tanto `lyrics.py` (vista de terminal) como
`tiktok_generator.py` (video) consumen. Esto garantiza que ambos
SIEMPRE muestren exactamente lo mismo en el mismo instante, sin tener que
ajustar delays a mano por canción.

Uso como script (genera/actualiza el cache de sincronización):
    python lyrics_sync.py cancion.txt -a cancion.mp3 -l es

Uso como librería:
    from lyrics_sync import align_lyrics_to_audio
    data = align_lyrics_to_audio("cancion.mp3", "cancion.txt", language="es")
"""

import argparse
import difflib
import json
import re
import sys
from pathlib import Path

try:
    import whisper_timestamped as whisper
except ImportError:
    whisper = None

WHISPER_SAMPLE_RATE = 16000
_WORD_RE = re.compile(r"[^\w'áéíóúñüàèìòùâêîôûäëïöü]+", re.UNICODE)

_MODEL_CACHE = {}


def normalize_word(word: str) -> str:
    """Normaliza una palabra para poder comparar letra vs. transcripción."""
    word = word.lower().strip()
    word = _WORD_RE.sub("", word)
    return word


def parse_lyrics_file(path) -> list:
    """
    Parsea un .txt de letra en una lista de estrofas, cada estrofa es una
    lista de líneas (strings). Las líneas vacías separan estrofas.
    """
    path = Path(path)
    with open(path, "r", encoding="utf-8") as f:
        raw_lines = f.read().split("\n")

    stanzas = []
    current = []
    for raw in raw_lines:
        line = raw.strip()
        if line == "":
            if current:
                stanzas.append(current)
                current = []
        else:
            current.append(line)
    if current:
        stanzas.append(current)
    return stanzas


def _get_model(model_name: str):
    if model_name not in _MODEL_CACHE:
        if whisper is None:
            raise RuntimeError(
                "whisper_timestamped no está instalado. "
                "Instálalo con: pip install whisper-timestamped"
            )
        print(f"Cargando modelo Whisper '{model_name}' (puede tardar la primera vez)...")
        _MODEL_CACHE[model_name] = whisper.load_model(model_name, device="cpu")
    return _MODEL_CACHE[model_name]


def _transcribe(audio_path: str, language: str, model_name: str, vad=None):
    model = _get_model(model_name)
    print(f"Transcribiendo {audio_path} para obtener tiempos reales...")
    audio = whisper.load_audio(audio_path)
    duration = len(audio) / WHISPER_SAMPLE_RATE
    kwargs = {}
    if vad:
        # VAD (detección de voz): descarta las zonas sin voz antes de
        # transcribir, evitando que Whisper "invente" letra sobre los
        # instrumentales. Acepta True, "silero" o "auditok".
        kwargs["vad"] = vad
    result = whisper.transcribe(model, audio, language=language, **kwargs)
    return result, duration


MAX_WORD_DURATION = 1.2   # segundos: nadie canta una sola palabra por más que esto
MAX_GAP_TO_STRETCH = 4.0  # segundos: huecos mayores a esto se tratan como instrumental,
                          # no se reparten entre las palabras sin match


def _fill_missing_times(times, total_duration):
    """Asigna tiempos a las palabras de la letra que Whisper no pudo
    emparejar (ad-libs, coros repetidos que no transcribió, errores, etc.).

    Regla clave para no romper la sincronía en los instrumentales:

    - Hueco pequeño (<= MAX_GAP_TO_STRETCH): se reparte linealmente entre
      la palabra anterior y la siguiente. Es una pausa corta cantada.

    - Hueco grande (instrumental, pausa larga) con palabra reconocida
      DESPUÉS: se empaquetan las palabras sin match HACIA ATRÁS, pegadas a
      esa siguiente palabra. El canto es contiguo y se reanuda justo antes
      de la palabra reconocida; durante el instrumental previo no debe
      avanzar nada en pantalla. (Antes se marchaban hacia adelante desde la
      palabra anterior, que es justo lo que hacía que la letra "siguiera"
      sobre la melodía instrumental.)

    - Cola final sin palabra siguiente: se empaquetan hacia adelante desde
      la última palabra conocida, con duración corta."""
    n = len(times)
    i = 0
    while i < n:
        if times[i] is not None:
            i += 1
            continue
        j = i
        while j < n and times[j] is None:
            j += 1
        gap = j - i
        prev_end = times[i - 1][1] if i > 0 else None
        next_start = times[j][0] if j < n else None

        if prev_end is None and next_start is None:
            # Ninguna palabra reconocida en toda la canción: repartir desde 0.
            step = min(total_duration / (gap + 1), MAX_WORD_DURATION)
            cursor = 0.0
            for k in range(gap):
                times[i + k] = (cursor, cursor + step)
                cursor += step
            i = j
            continue

        available = (next_start - prev_end) if (prev_end is not None and next_start is not None) else None

        if available is not None and available <= MAX_GAP_TO_STRETCH:
            # Hueco pequeño: interpolación lineal uniforme.
            step = available / (gap + 1)
            cursor = prev_end
            for k in range(gap):
                times[i + k] = (cursor, cursor + step)
                cursor += step
        elif next_start is not None:
            # Hueco grande (o palabras al inicio): empaquetar HACIA ATRÁS
            # desde la siguiente palabra reconocida.
            lower = prev_end if prev_end is not None else 0.0
            cursor = next_start
            for k in reversed(range(gap)):
                e = cursor
                s = max(e - MAX_WORD_DURATION, lower)
                times[i + k] = (s, e)
                cursor = s
        else:
            # Cola final: empaquetar hacia adelante desde la última conocida.
            cursor = prev_end
            for k in range(gap):
                e = min(cursor + MAX_WORD_DURATION, total_duration)
                times[i + k] = (cursor, e)
                cursor = e
        i = j
    return times


def _fill_line_internal(times, start, end):
    """Rellena los huecos DENTRO de una línea (tokens [start, end)) usando
    solo las palabras reconocidas de esa misma línea como anclas. Una línea
    se canta de forma contigua, así que:
      - las palabras iniciales sin match se empaquetan hacia atrás desde la
        primera palabra reconocida de la línea,
      - las finales se empaquetan hacia adelante desde la última reconocida,
      - los huecos intermedios se interpolan linealmente.
    Si la línea no tiene ninguna palabra reconocida, se deja intacta para
    resolverla luego con el contexto de las líneas vecinas."""
    matched = [k for k in range(start, end) if times[k] is not None]
    if not matched:
        return

    # Huecos intermedios entre dos palabras reconocidas de la línea.
    for a, b in zip(matched, matched[1:]):
        if b - a > 1:
            prev_end = times[a][1]
            next_start = times[b][0]
            n_gap = b - a - 1
            step = (next_start - prev_end) / (n_gap + 1)
            cursor = prev_end
            for k in range(a + 1, b):
                times[k] = (cursor, cursor + step)
                cursor += step

    # Palabras iniciales sin match: hacia atrás desde la primera reconocida.
    first = matched[0]
    if first > start:
        cursor = times[first][0]
        for k in range(first - 1, start - 1, -1):
            e = cursor
            s = max(e - MAX_WORD_DURATION, 0.0)
            times[k] = (s, e)
            cursor = s

    # Palabras finales sin match: hacia adelante desde la última reconocida.
    last = matched[-1]
    if last < end - 1:
        cursor = times[last][1]
        for k in range(last + 1, end):
            e = cursor + MAX_WORD_DURATION
            times[k] = (cursor, e)
            cursor = e


def _default_cache_path(lyrics_path) -> Path:
    return Path(lyrics_path).with_suffix("").with_name(Path(lyrics_path).stem + ".sync.json")


def align_lyrics_to_audio(
    audio_path: str,
    lyrics_path: str,
    language: str = "es",
    model_name: str = "small",
    cache_path: str = None,
    force: bool = False,
    vad="auditok",
    separate_vocals: bool = True,
    progress_cb=None,
) -> dict:
    """
    Alinea la letra real (lyrics_path) con el audio (audio_path) y devuelve:
    {
      "stanzas": [
        [
          {"text": line, "start": t0, "end": t1, "words": [{"text": w, "start": t, "end": t, "synced": bool}, ...]},
          ...
        ],
        ...
      ]
    }

    Para lograr una sincronía casi perfecta en cualquier canción:
      - separate_vocals=True aísla la voz con Demucs antes de transcribir,
        así Whisper no se confunde con la música de fondo.
      - vad="auditok" (o "silero") descarta las zonas sin voz, evitando que
        Whisper alucine letra sobre los instrumentales.
      - model_name="small" por defecto (mejor que "base" para tiempos).

    Usa un archivo cache (.sync.json) para no re-procesar cada vez.
    """
    # Rutas absolutas para no depender del directorio de trabajo (Demucs y
    # otras librerías pueden cambiarlo por debajo).
    audio_path = str(Path(audio_path).resolve())
    lyrics_path = str(Path(lyrics_path).resolve())

    cache_path = Path(cache_path) if cache_path else _default_cache_path(lyrics_path)

    # La firma de configuración: si cambia, el cache se invalida.
    config_sig = {
        "model": model_name,
        "vad": vad if isinstance(vad, (str, bool)) else True,
        "separate_vocals": bool(separate_vocals),
    }

    # Helper que reporta fases si hay callback, ignorando cualquier fallo.
    def _pc(phase, pct=None):
        if progress_cb:
            try:
                progress_cb(phase, pct)
            except Exception:
                pass

    if cache_path.is_file() and not force:
        with open(cache_path, "r", encoding="utf-8") as f:
            cached = json.load(f)
        if (
            cached.get("audio") == str(audio_path)
            and cached.get("lyrics_mtime") == Path(lyrics_path).stat().st_mtime
            and cached.get("config") == config_sig
        ):
            print(f"Usando sincronización cacheada: {cache_path}")
            _pc("Usando sincronización cacheada", 100)
            return cached

    _pc("Preparando letra", 5)
    stanzas_raw = parse_lyrics_file(lyrics_path)

    lyrics_tokens = []
    line_ranges = []  # (start_idx, end_idx) de cada línea con al menos un token
    for stanza in stanzas_raw:
        for line in stanza:
            start_idx = len(lyrics_tokens)
            for word in line.split():
                norm = normalize_word(word)
                if norm:
                    lyrics_tokens.append(norm)
            end_idx = len(lyrics_tokens)
            if end_idx > start_idx:
                line_ranges.append((start_idx, end_idx))

    # Audio que se usará para transcribir: por defecto, la voz aislada.
    transcribe_audio = audio_path
    if separate_vocals:
        _pc("Aislando voz (Demucs)", 20)
        try:
            from vocal_separator import separate_vocals as _separate
            transcribe_audio = str(_separate(audio_path))
        except Exception as e:
            print(f"Aviso: no se pudo aislar la voz ({e}). Se usará el audio completo.")
            transcribe_audio = audio_path

    _pc("Transcribiendo audio (Whisper)", 55)
    transcription, duration = _transcribe(transcribe_audio, language, model_name, vad=vad)

    whisper_words = []
    for seg in transcription.get("segments", []):
        for w in seg.get("words", []):
            norm = normalize_word(w.get("text", ""))
            if norm:
                whisper_words.append((norm, w["start"], w["end"]))
    whisper_tokens = [w[0] for w in whisper_words]

    _pc("Alineando letra con audio", 90)
    lyric_word_times = [None] * len(lyrics_tokens)
    sm = difflib.SequenceMatcher(a=whisper_tokens, b=lyrics_tokens, autojunk=False)
    for block in sm.get_matching_blocks():
        for k in range(block.size):
            lyric_word_times[block.b + k] = (
                whisper_words[block.a + k][1],
                whisper_words[block.a + k][2],
            )

    # Guardamos qué palabras reconoció Whisper (tiempos fiables) vs. cuáles
    # se rellenaron por interpolación (tiempos aproximados).
    matched_flags = [t is not None for t in lyric_word_times]

    # Pasada 1: rellenar cada línea con sus propias anclas (mantiene cada
    # línea coherente y evita arrastrar palabras a la línea siguiente).
    for start_idx, end_idx in line_ranges:
        _fill_line_internal(lyric_word_times, start_idx, end_idx)

    # Pasada 2: resolver líneas que quedaron completamente sin reconocer,
    # usando el contexto de las palabras ya ubicadas alrededor.
    _fill_missing_times(lyric_word_times, duration)

    # Reconstruir estrofas/líneas con tiempos
    idx = 0
    result_stanzas = []
    for stanza in stanzas_raw:
        result_lines = []
        for line in stanza:
            word_entries = []
            for word in line.split():
                norm = normalize_word(word)
                if not norm:
                    continue
                start, end = lyric_word_times[idx]
                word_entries.append({
                    "text": word,
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "synced": matched_flags[idx],
                })
                idx += 1
            if word_entries:
                line_start = word_entries[0]["start"]
                line_end = word_entries[-1]["end"]
            else:
                line_start = line_end = 0.0
            result_lines.append(
                {"text": line, "start": line_start, "end": line_end, "words": word_entries}
            )
        result_stanzas.append(result_lines)

    data = {
        "audio": str(audio_path),
        "lyrics": str(lyrics_path),
        "lyrics_mtime": Path(lyrics_path).stat().st_mtime,
        "language": language,
        "duration": duration,
        "config": config_sig,
        "stanzas": result_stanzas,
    }

    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"Sincronización guardada en: {cache_path}")

    return data


def flatten_lines(data: dict) -> list:
    """Devuelve todas las líneas de todas las estrofas en una sola lista plana,
    útil para recorrer secuencialmente por tiempo (ej. en el video)."""
    lines = []
    for stanza in data["stanzas"]:
        for line in stanza:
            lines.append(line)
    return lines


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Alinea una letra (.txt) con un audio y genera un cache de sincronización."
    )
    parser.add_argument("letra", help="Ruta al archivo .txt con la letra de la canción.")
    parser.add_argument("-a", "--audio", required=True, help="Ruta al archivo de audio (mp3, wav, etc).")
    parser.add_argument("-l", "--language", default="es", help="Idioma de la canción (ej. es, en).")
    parser.add_argument("-m", "--model", default="small", help="Modelo Whisper a usar (tiny, base, small, medium...).")
    parser.add_argument("-c", "--cache", default=None, help="Ruta del archivo de cache de salida.")
    parser.add_argument("--force", action="store_true", help="Fuerza re-transcripción aunque exista cache.")
    parser.add_argument("--vad", default="auditok", help="VAD a usar: auditok, silero, o 'none' para desactivar.")
    parser.add_argument("--no-separacion", action="store_true", help="No aislar la voz con Demucs (usa el audio completo).")

    args = parser.parse_args()
    vad_arg = None if str(args.vad).lower() in ("none", "no", "off", "") else args.vad
    result = align_lyrics_to_audio(
        args.audio, args.letra, language=args.language, model_name=args.model,
        cache_path=args.cache, force=args.force,
        vad=vad_arg, separate_vocals=not args.no_separacion,
    )
    total_lines = sum(len(s) for s in result["stanzas"])
    print(f"Listo. {len(result['stanzas'])} estrofas, {total_lines} líneas, duración {result['duration']:.1f}s.")
