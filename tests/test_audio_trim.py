import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import audio_trim


def _imagen(destino: Path) -> Path:
    """Portada de prueba, también generada al vuelo."""
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", str(destino)],
        check=True,
    )
    return destino


def _tiene_caratula(audio: Path) -> bool:
    salida = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", str(audio)],
        stdout=subprocess.PIPE, text=True, check=True,
    ).stdout
    return "DISPOSITION:attached_pic=1" in salida


def _tono(destino: Path, segundos: float) -> Path:
    """Genera un wav de prueba con ffmpeg para no versionar audio en el repo."""
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"sine=frequency=440:duration={segundos}",
         str(destino)],
        check=True,
    )
    return destino


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "requiere ffmpeg")
class AudioTrimTests(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.dir = Path(self._temp.name)
        self.fuente = _tono(self.dir / "tema.wav", 10)
        self.addCleanup(self._temp.cleanup)

    def test_recorta_el_tramo_pedido_y_conserva_el_original(self):
        recorte = audio_trim.trim_audio(self.fuente, start=2, end=5, output_dir=self.dir)

        self.assertAlmostEqual(audio_trim.probe_duration(recorte), 3.0, delta=0.1)
        self.assertAlmostEqual(audio_trim.probe_duration(self.fuente), 10.0, delta=0.1)
        self.assertEqual(recorte.name, "tema (recorte).wav")

    def test_sin_fin_recorta_hasta_el_final(self):
        recorte = audio_trim.trim_audio(self.fuente, start=7, output_dir=self.dir)

        self.assertAlmostEqual(audio_trim.probe_duration(recorte), 3.0, delta=0.1)

    def test_no_pisa_un_recorte_anterior(self):
        primero = audio_trim.trim_audio(self.fuente, start=0, end=2, output_dir=self.dir)
        segundo = audio_trim.trim_audio(self.fuente, start=0, end=2, output_dir=self.dir)

        self.assertNotEqual(primero, segundo)
        self.assertTrue(primero.is_file())
        self.assertEqual(segundo.name, "tema (recorte) (2).wav")

    def test_los_fundidos_no_alargan_el_fragmento(self):
        recorte = audio_trim.trim_audio(
            self.fuente, start=0, end=2, output_dir=self.dir,
            fade_in=5, fade_out=5, filename="con fundidos",
        )

        self.assertAlmostEqual(audio_trim.probe_duration(recorte), 2.0, delta=0.1)

    def test_rechaza_fragmentos_demasiado_cortos_o_invertidos(self):
        for start, end in ((3, 3.2), (6, 4), (100, None)):
            with self.subTest(start=start, end=end):
                with self.assertRaises(ValueError):
                    audio_trim.trim_audio(self.fuente, start=start, end=end, output_dir=self.dir)

    def test_no_deja_temporales_cuando_falla(self):
        with self.assertRaises(ValueError):
            audio_trim.trim_audio(self.fuente, start=1, end=1.1, output_dir=self.dir)

        self.assertEqual([p.name for p in self.dir.iterdir()], ["tema.wav"])

    def test_sanitize_name_quita_separadores_de_ruta(self):
        self.assertEqual(audio_trim.sanitize_name(" ../mi   recorte?.. "), "mi recorte")

    def test_el_recorte_incrusta_la_caratula_recibida(self):
        fuente = _tono(self.dir / "tema.mp3", 6)
        portada = _imagen(self.dir / "portada.jpg")

        recorte = audio_trim.trim_audio(
            fuente, start=1, end=4, output_dir=self.dir, cover=portada,
        )

        self.assertTrue(_tiene_caratula(recorte))
        self.assertAlmostEqual(audio_trim.probe_duration(recorte), 3.0, delta=0.1)

    def test_una_caratula_inexistente_no_rompe_el_recorte(self):
        fuente = _tono(self.dir / "tema.mp3", 6)

        recorte = audio_trim.trim_audio(
            fuente, start=1, end=4, output_dir=self.dir,
            cover=self.dir / "no-existe.jpg",
        )

        self.assertTrue(recorte.is_file())
        self.assertFalse(_tiene_caratula(recorte))


if __name__ == "__main__":
    unittest.main()
