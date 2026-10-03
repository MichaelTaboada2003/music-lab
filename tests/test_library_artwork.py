import tempfile
from pathlib import Path
import pytest

from library_metadata import _clean, split_artists
from library_artwork import _match_score, _normalize_tokens, search_catalog_covers


def test_clean_metadata_noise():
    assert _clean("Volando Remix (Video Oficial)") == "Volando Remix"
    assert _clean("Gata Negra De La Maldad (Video Oficial)") == "Gata Negra De La Maldad"
    assert _clean("Inmortal [Official Video]") == "Inmortal"
    assert _clean("Moscow Mule (Video Oficial) ｜ Un Verano Sin Ti") == "Moscow Mule"
    assert _clean("Volverte A Ver (Audio)") == "Volverte A Ver"
    assert _clean("Cancion (En Vivo)") == "Cancion"
    assert _clean("Tema (Remasterizado)") == "Tema"


def test_split_artists():
    assert split_artists("Mora x Bad Bunny x Sech") == ["Mora", "Bad Bunny", "Sech"]
    assert split_artists("Bad Bunny (ft Bomba Estéreo)") == ["Bad Bunny", "Bomba Estéreo"]
    assert split_artists("Kanye West ft. Pusha T, Chief Keef") == ["Kanye West", "Pusha T", "Chief Keef"]
    assert split_artists("Tainy, Álvaro Díaz") == ["Tainy", "Álvaro Díaz"]


def test_match_score_rejection():
    # Volando Remix vs Volando (Remix) -> Coincidencia alta
    score_match = _match_score("Volando Remix", "Mora x Bad Bunny x Sech", "Volando (Remix)", "Mora")
    assert score_match >= 0.7

    # Volando Remix vs LA CANCIÓN (OASIS) -> Debe dar 0.0 y ser descartado inmediatamente
    score_wrong = _match_score("Volando Remix", "Mora x Bad Bunny x Sech", "LA CANCIÓN", "J Balvin & Bad Bunny")
    assert score_wrong == 0.0


def test_search_catalog_covers_relevance():
    candidates = search_catalog_covers("Volando Remix", "Mora x Bad Bunny x Sech", limit=5)
    assert len(candidates) > 0
    # El primer candidato debe ser Volando (Remix) y nunca OASIS o LA CANCIÓN
    top = candidates[0]
    assert "volando" in top["title"].lower()
    for cand in candidates:
        assert cand["title"].lower() != "la canción"
        assert cand["album"].lower() != "oasis"


def test_match_score_penaliza_mismo_titulo_de_otro_artista():
    from library_artwork import _match_score
    bueno = _match_score("LA DROGA", "BAD BUNNY", "LA DROGA", "Bad Bunny")
    otro = _match_score("LA DROGA", "BAD BUNNY", "La Droga", "Charlie Chimi")
    assert bueno == 1.0
    assert otro < 0.45


def test_match_score_penaliza_palabras_extra_del_candidato():
    from library_artwork import _match_score
    exacto = _match_score("La Droga", "", "La Droga", "X")
    extra = _match_score("La Droga", "", "La Droga (Adicto A Ti)", "X")
    assert exacto > extra


def test_nombre_todo_mayusculas_se_lee_artista_titulo():
    from library_metadata import _infer_from_filename
    assert _infer_from_filename(
        "BAD BUNNY - LA DROGA ｜ EL ÚLTIMO TOUR DEL MUNDO [Visualizer]"
    ) == ("LA DROGA", "BAD BUNNY")
    assert _infer_from_filename("MOJABI GHOST - Tainy, Bad Bunny") == ("MOJABI GHOST", "Tainy, Bad Bunny")


def test_clip_info_detecta_recortes_sin_lanzar_ffprobe(monkeypatch, tmp_path):
    import library_metadata

    def boom(*args, **kwargs):
        raise AssertionError("clip_info no debe invocar ffprobe")

    monkeypatch.setattr(library_metadata.subprocess, "run", boom)
    monkeypatch.setattr(library_metadata, "_METADATA_PATH", tmp_path / "meta.json")
    assert library_metadata.clip_info(tmp_path / "Tema (recorte).mp3") == (True, "")
    assert library_metadata.clip_info(tmp_path / "Tema (recorte) (2).mp3")[0] is True
    assert library_metadata.clip_info(tmp_path / "Tema.mp3") == (False, "")
    library_metadata.mark_as_clip("Otro", "Tema")
    assert library_metadata.clip_info(tmp_path / "Otro.mp3") == (True, "Tema")
