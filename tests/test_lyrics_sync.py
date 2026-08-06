import unittest

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


if __name__ == "__main__":
    unittest.main()
