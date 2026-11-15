import unittest

import clip_lyrics
import lyrics_catalog


def _line(text, start, step=0.5):
    words = []
    cursor = start
    for word in text.split():
        words.append({"text": word, "start": cursor, "end": cursor + step, "synced": True})
        cursor += step
    return {"text": text, "start": words[0]["start"], "end": words[-1]["end"], "words": words}


class ClipLyricsTests(unittest.TestCase):
    def test_sync_keeps_only_lines_inside_and_shifts_clock(self):
        data = {"stanzas": [
            [_line("antes del corte", 2.0), _line("primer verso dentro", 10.0)],
            [_line("segundo verso dentro", 14.0), _line("despues del corte", 30.0)],
        ]}
        stanzas = clip_lyrics._stanzas_from_sync(data, 9.0, 20.0)
        self.assertEqual(
            [[line["text"] for line in stanza] for stanza in stanzas],
            [["primer verso dentro"], ["segundo verso dentro"]],
        )
        first = stanzas[0][0]["words"][0]
        self.assertAlmostEqual(first["start"], 1.0)
        self.assertAlmostEqual(first["end"], 1.5)

    def test_sync_times_stay_ordered_at_the_cut_edge(self):
        # El verso empieza un poco antes del corte: sus palabras no pueden
        # quedar con tiempos negativos ni duración cero.
        data = {"stanzas": [[_line("uno dos tres cuatro cinco", 9.6, step=0.4)]]}
        words = clip_lyrics._stanzas_from_sync(data, 10.0, 20.0)[0][0]["words"]
        previous_end = 0.0
        for word in words:
            self.assertGreaterEqual(word["start"], previous_end)
            self.assertGreater(word["end"], word["start"])
            previous_end = word["end"]

    def test_lrc_picks_lines_in_range_and_splits_on_pauses(self):
        lrc = "\n".join([
            "[00:05.00] fuera",
            "[00:12.00] dentro uno",
            "[00:16.00] dentro dos",
            "[00:19.00] ",
            "[00:21.00] dentro tres",
            "[00:40.00] fuera otra vez",
        ])
        self.assertEqual(
            clip_lyrics._stanzas_from_lrc(lrc, 11.0, 30.0),
            [["dentro uno", "dentro dos"], ["dentro tres"]],
        )

    def test_parse_lrc_ignores_metadata_tags(self):
        parsed = lyrics_catalog.parse_lrc("[ar:Artista]\n[01:02.50] Hola\nsin tiempo")
        self.assertEqual(parsed, [(62.5, "Hola")])


if __name__ == "__main__":
    unittest.main()
