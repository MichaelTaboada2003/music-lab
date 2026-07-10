# Music Lab

Music Lab es una aplicación full-stack (FastAPI + Vanilla JS) que permite descargar audio, sincronizar letras automáticamente con Inteligencia Artificial y generar videos interactivos. 

Cuenta con una interfaz de usuario hiper-premium basada en "Glassmorphism", un visualizador de espectro de audio mediante la API Web Audio de HTML5, y tecnología de renderizado de video en backend.

## 🚀 Características Principales

*   **🎧 Reproductor Inmersivo:** Reproductor web interactivo con "Ambient Mode" (fondo reactivo al sonido) y visualizador de forma de onda.
*   **⬇️ Descarga Automática:** Descarga audio directo desde enlaces de YouTube (y otros).
*   **🎤 Karaoke Sincronizado por IA:** Utiliza **Whisper** (OpenAI) para escuchar el audio de la canción y alinear matemáticamente cada palabra de la letra escrita, detectando el milisegundo exacto en que se canta.
*   **🎬 Generador de Videos (TikTok/Reels):** Exporta fragmentos seleccionados a un video vertical (MP4) con **Kinetic Typography** (texto que reacciona e ilumina con la canción) y un analizador de espectro renderizado con NumPy FFT y MoviePy.

## 🛠️ Tecnologías

### Frontend
*   **Vanilla JS, HTML5 y CSS3**
*   **Web Audio API:** Para el analizador de espectro y orbe reactivo.
*   **Glassmorphism UI:** Diseño limpio, difuminado (blur) y minimalista.

### Backend
*   **Python 3 & FastAPI:** API y servidor web rápido y moderno.
*   **Whisper Timestamped:** Para la detección de palabras y alineación de voz (STT).
*   **MoviePy, PIL & NumPy:** Manipulación de video, dibujo (draw) en frames, y Transformada Rápida de Fourier (FFT) para el espectro de audio.
*   **Demucs (Opcional):** Para separar instrumentales de voces puras y sincronizar mejor el karaoke.

## 🧠 ¿Cómo funciona la sincronización con IA?

Uno de los mayores retos al crear videos tipo "Karaoke" o "Lyrics" es saber exactamente en qué milisegundo empieza y termina cada palabra. En Music Lab, este proceso está completamente automatizado y se divide en tres fases principales:

### 1. Aislamiento de Voces (Demucs)
Las canciones comerciales suelen tener instrumentales muy fuertes o coros que confunden a los modelos de reconocimiento de voz. Para solucionar esto, Music Lab integra de manera nativa [Demucs (htdemucs)](https://github.com/facebookresearch/demucs), un modelo de separación de fuentes de audio de última generación creado por Facebook Research.
* Si seleccionas la opción "Aislar voz", el backend procesa el archivo original y extrae **solo la voz (vocals)** en un archivo `.wav` puro. 
* Este archivo "limpio" será la base para la alineación, evitando errores causados por los bajos o baterías de la canción.

### 2. Detección de Actividad de Voz (VAD con Auditok)
Incluso con la voz aislada, pueden existir fragmentos largos de silencio o ruido de respiración. Opcionalmente, se utiliza un motor **VAD (Voice Activity Detection)** como `auditok` para recortar y descartar los silencios absolutos, enviando a la IA únicamente los segmentos de audio que contienen voz real. Esto acelera el procesamiento y reduce las "alucinaciones" (texto fantasma) en el modelo de transcripción.

### 3. Alineamiento Temporal (Whisper Timestamped)
Finalmente, el audio procesado junto con **la letra escrita** se introduce a un modelo de OpenAI llamado [Whisper](https://github.com/openai/whisper).
* En lugar de pedirle a Whisper que transcriba la canción desde cero (lo cual generaría errores si el cantante pronuncia mal, o simplemente ignoraría las repeticiones artísticas), usamos un repositorio especializado: `whisper-timestamped`.
* Le entregamos el audio de la voz y **la letra oficial** de la canción. Whisper realiza un *Force-Alignment* (Alineación forzada). 
* Matemáticamente, el modelo mapea los fonemas del audio con las palabras del texto provisto y devuelve un archivo `.json` con el `start` y `end` (en milisegundos) de cada palabra con una precisión asombrosa. 
* Este archivo `.json` es el que luego alimenta nuestro generador de videos en Python para pintar cada sílaba en el frame correcto.

## ⚙️ Uso / Instalación

1.  **Clona este repositorio** y navega al directorio del proyecto.
2.  **Instala las dependencias** recomendadas en tu entorno virtual (se requiere `fastapi`, `uvicorn`, `whisper-timestamped`, `moviepy`, `numpy`, `Pillow`, etc.). También se necesita instalar **ffmpeg**.
3.  **Inicia el servidor backend:**
    ```bash
    uvicorn app:app --reload
    ```
4.  **Abre tu navegador** en `http://127.0.0.1:8000` para disfrutar de la experiencia Music Lab.

## 📁 Estructura del Proyecto

*   `app.py`: Servidor principal FastAPI y gestor de tareas en background.
*   `static/`: Contiene todo el código frontend (UI, estilos, lógica de navegador).
*   `tiktok_generator.py`: Motor de video que dibuja frames reactivos con PIL y los une en MoviePy.
*   `lyrics_sync.py`: Lógica principal de Whisper para alineación de letras.
*   `audio_downloader.py`: Utilidad para obtener y convertir fuentes de internet.
