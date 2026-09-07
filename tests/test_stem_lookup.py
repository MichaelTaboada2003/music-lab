import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.utils import find_cached_stem, instrumental_path_for, vocals_path_for
import vocal_separator


class TestStemLookup(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.vocals_dir = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_lookup_prefers_flac_then_mp3_then_wav(self):
        with patch("app.utils.VOCALS_DIR", self.vocals_dir), \
             patch("vocal_separator.VOCALS_DIR", self.vocals_dir):

            stem = "test_song"
            
            # Default without files: .flac
            self.assertEqual(vocals_path_for(stem), self.vocals_dir / f"{stem}.vocals.flac")
            self.assertEqual(instrumental_path_for(stem), self.vocals_dir / f"{stem}.instrumental.flac")

            # With WAV
            wav_file = self.vocals_dir / f"{stem}.vocals.wav"
            wav_file.touch()
            self.assertEqual(vocals_path_for(stem), wav_file)
            self.assertEqual(vocal_separator._cached_vocals_path(Path(f"{stem}.mp3")), wav_file)

            # With MP3 (should take precedence over WAV)
            mp3_file = self.vocals_dir / f"{stem}.vocals.mp3"
            mp3_file.touch()
            self.assertEqual(vocals_path_for(stem), mp3_file)

            # With FLAC (should take highest precedence)
            flac_file = self.vocals_dir / f"{stem}.vocals.flac"
            flac_file.touch()
            self.assertEqual(vocals_path_for(stem), flac_file)
            self.assertEqual(vocal_separator._cached_vocals_path(Path(f"{stem}.mp3")), flac_file)


if __name__ == "__main__":
    unittest.main()
