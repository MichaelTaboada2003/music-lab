import os
import unittest

import numpy as np

import lyrics_sync
from lyrics_sync import (
    _align_word_sequences,
    _drop_unreliable_anchors,
    _fill_missing_times,
    _quality_report,
    normalize_word,
)


class LyricsSyncAlignmentTests(unittest.TestCase):
    def test_sung_ing_normalization_matches_whisper_spelling(self):
        self.assertEqual(normalize_word("runnin'"), "running")
        self.assertEqual(normalize_word("losin’"), "losing")
        self.assertEqual(normalize_word("in"), "in")

    def test_global_alignment_keeps_repeated_choruses_in_order(self):
        lyrics = "intro starts hook one two three quiet missing words fix song hook one two three end".split()
        transcript = "intro starts hook one two three fix song hook one two three end".split()
        whisper_words = [(word, index, index + 0.4, 0.9) for index, word in enumerate(transcript)]

        aligned = _align_word_sequences(whisper_words, lyrics)

        first_hook = lyrics.index("hook")
        second_hook = lyrics.index("hook", first_hook + 1)
        self.assertEqual(aligned[first_hook], transcript.index("hook"))
        self.assertEqual(aligned[second_hook], transcript.index("hook", transcript.index("hook") + 1))
        self.assertEqual(aligned[lyrics.index("fix")], transcript.index("fix"))

    def test_long_gap_is_packed_near_next_anchor_without_destroying_it(self):
        times = [(0.0, 0.5), None, None, None, None, (8.0, 8.4)]
        tokens = ["before", "i", "hate", "to", "cry", "after"]

        _fill_missing_times(times, 10.0, tokens)

        self.assertGreater(times[1][0], 5.0)
        self.assertEqual(times[4][1], 8.0)
        self.assertEqual(times[5], (8.0, 8.4))
        self.assertTrue(all(times[index][1] <= times[index + 1][0] for index in range(len(times) - 1)))

    def test_low_confidence_anchor_before_long_silence_is_discarded(self):
        times = [(169.7, 170.75), (187.69, 188.07), (188.07, 188.35)]
        matched = [True, True, True]
        confidences = [0.1, 0.03, 0.8]

        _drop_unreliable_anchors(times, matched, confidences, [4, 4, 4])

        self.assertIsNone(times[0])
        self.assertFalse(matched[0])
        self.assertEqual(times[1], (187.69, 188.07))

    def test_sustained_word_before_real_segment_break_is_preserved(self):
        times = [(77.6, 78.04), (96.77, 97.19)]
        matched = [True, True]
        confidences = [0.09, 0.33]

        _drop_unreliable_anchors(times, matched, confidences, [8, 9])

        self.assertEqual(times[0], (77.6, 78.04))
        self.assertTrue(matched[0])

    def test_review_quality_requires_review_before_export(self):
        report = _quality_report(
            [True] * 6 + [False] * 4,
            [False] * 10,
            [0.7] * 6 + [None] * 4,
            [False] * 6 + [True] * 2 + [False] * 2,
        )

        self.assertEqual(report["label"], "revisar")
        self.assertFalse(report["playable"])


class WhisperPrecisionTests(unittest.TestCase):
    """Whisper en media precisión transcribe distinto —pierde tildes y mueve
    los tiempos hasta 20 ms—, así que la precisión completa forma parte del
    contrato de sincronía, no es un detalle de rendimiento."""

    def test_la_transcripcion_nunca_pide_media_precision(self):
        captured = {}

        class _FakeWhisper:
            @staticmethod
            def load_model(name, device="cpu"):
                return object()

            @staticmethod
            def load_audio(path):
                return np.zeros(lyrics_sync.WHISPER_SAMPLE_RATE * 2, dtype=np.float32)

            @staticmethod
            def transcribe(model, audio, **kwargs):
                captured.update(kwargs)
                return {"segments": [], "text": ""}

        original_whisper = lyrics_sync.whisper
        original_cache = dict(lyrics_sync._MODEL_CACHE)
        lyrics_sync.whisper = _FakeWhisper
        lyrics_sync._MODEL_CACHE.clear()
        try:
            lyrics_sync._transcribe("audio.flac", "es", "medium")
        finally:
            lyrics_sync.whisper = original_whisper
            lyrics_sync._MODEL_CACHE.clear()
            lyrics_sync._MODEL_CACHE.update(original_cache)

        self.assertIs(captured.get("fp16"), False)

    def test_el_dispositivo_se_puede_forzar_por_entorno(self):
        previo = os.environ.get("MUSIC_LAB_WHISPER_DEVICE")
        os.environ["MUSIC_LAB_WHISPER_DEVICE"] = "cpu"
        try:
            self.assertEqual(lyrics_sync._select_whisper_device(), "cpu")
        finally:
            if previo is None:
                os.environ.pop("MUSIC_LAB_WHISPER_DEVICE", None)
            else:
                os.environ["MUSIC_LAB_WHISPER_DEVICE"] = previo


if __name__ == "__main__":
    unittest.main()
