#!/usr/bin/env python3
"""jarvis-speaker: el jack de la Raspberry Pi compartido entre Spotify y la voz de Jarvis.

Por qué un mezclador propio y no ALSA dmix: en esta Pi (kernel 6.18, salida
bcm2835 Headphones) dmix se cuelga en el primer write, con cualquier tamaño de
buffer; el acceso directo al hardware anda bien. Así que este proceso es el
único dueño del jack y mezcla él mismo:

- música: raspotify (librespot) escribe PCM S16 44,1 kHz estéreo en un FIFO;
- voz: Apollo (en Docker) manda PCM por HTTP (POST /play, 24 kHz mono).

Mientras Jarvis habla, o mientras la placa escucha (POST /duck), la música baja
sola y después vuelve, como en la radio. El volumen de Spotify no se toca: la
bajada es un multiplicador aparte.

Endpoints (todos piden la cabecera X-Speaker-Token):
  GET  /health                 estado
  POST /play?rate=&channels=   cuerpo: PCM S16LE; se encola detrás de lo que esté sonando
  POST /stop                   corta la voz y vacía la cola
  POST /duck?seconds=N         baja la música N segundos (la placa está escuchando)
  POST /unduck                 la vuelve a subir
  POST /volume?voice=0-100     volumen de la voz de Jarvis (se guarda)
"""

import collections
import errno
import json
import os
import stat
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np

OUTPUT_RATE = 44100
OUTPUT_CHANNELS = 2
CHUNK_FRAMES = 1024  # ~23 ms
CHUNK_BYTES = CHUNK_FRAMES * OUTPUT_CHANNELS * 2

ALSA_DEVICE = os.environ.get('SPEAKER_ALSA_DEVICE', 'plughw:Headphones')
MUSIC_FIFO = os.environ.get('SPEAKER_MUSIC_FIFO', '/run/jarvis-speaker/music.fifo')
STATE_FILE = os.environ.get('SPEAKER_STATE_FILE', '/var/lib/jarvis-speaker/state.json')
TOKEN_FILE = os.environ.get('SPEAKER_TOKEN_FILE', '/etc/jarvis-speaker/token')
LISTEN_PORT = int(os.environ.get('SPEAKER_PORT', '8790'))

# Medio segundo de música en memoria: alcanza para tapar el jitter de librespot
# y hace que una pausa en Spotify se escuche enseguida (~0,9 s con el pipe).
MUSIC_BUFFER_MAX_BYTES = OUTPUT_RATE * OUTPUT_CHANNELS * 2 // 2
MUSIC_DUCK_GAIN = 0.18
# Cuánto se mueve la ganancia de la música por bloque: de 1 a 0,18 en ~0,2 s.
MUSIC_GAIN_STEP = 0.1
MAX_PLAY_BYTES = 30 * 1024 * 1024
MAX_DUCK_SECONDS = 60.0


def log(message, **fields):
    print(json.dumps({'message': message, **fields}, ensure_ascii=False), flush=True)


def load_token():
    with open(TOKEN_FILE) as token_file:
        return token_file.read().strip()


class Mixer:
    def __init__(self):
        self.lock = threading.Lock()
        self.music_buffer = bytearray()
        self.music_last_data_at = 0.0
        self.voice_queue = collections.deque()
        self.voice_current = None
        self.voice_offset = 0
        self.duck_until = 0.0
        self.music_gain = 1.0
        self.voice_level = self._load_voice_level()

    # --- estado persistente -------------------------------------------------
    def _load_voice_level(self):
        try:
            with open(STATE_FILE) as state_file:
                return max(0.0, min(1.0, float(json.load(state_file).get('voiceLevel', 0.8))))
        except (OSError, ValueError):
            return 0.8

    def set_voice_level(self, level):
        with self.lock:
            self.voice_level = max(0.0, min(1.0, level))
        try:
            os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
            with open(STATE_FILE, 'w') as state_file:
                json.dump({'voiceLevel': self.voice_level}, state_file)
        except OSError as error:
            log('speaker_estado_no_guardado', error=str(error))

    # --- voz ----------------------------------------------------------------
    def enqueue_voice(self, pcm_bytes, rate, channels):
        samples = np.frombuffer(pcm_bytes[: len(pcm_bytes) // 2 * 2], dtype='<i2').astype(np.float32)
        if channels == 2:
            samples = samples[: len(samples) // 2 * 2].reshape(-1, 2).mean(axis=1)
        if len(samples) == 0:
            return 0.0
        if rate != OUTPUT_RATE:
            duration = len(samples) / rate
            target_length = int(round(duration * OUTPUT_RATE))
            source_times = np.arange(len(samples)) / rate
            target_times = np.arange(target_length) / OUTPUT_RATE
            samples = np.interp(target_times, source_times, samples).astype(np.float32)
        stereo = np.repeat(samples[:, None], 2, axis=1)
        with self.lock:
            self.voice_queue.append(stereo)
        return len(stereo) / OUTPUT_RATE

    def stop_voice(self):
        with self.lock:
            self.voice_queue.clear()
            self.voice_current = None
            self.voice_offset = 0

    def is_voice_active(self):
        return self.voice_current is not None or len(self.voice_queue) > 0

    def _take_voice_chunk(self):
        output = np.zeros((CHUNK_FRAMES, 2), dtype=np.float32)
        written = 0
        while written < CHUNK_FRAMES:
            if self.voice_current is None:
                if not self.voice_queue:
                    break
                self.voice_current = self.voice_queue.popleft()
                self.voice_offset = 0
            remaining = len(self.voice_current) - self.voice_offset
            count = min(remaining, CHUNK_FRAMES - written)
            output[written : written + count] = self.voice_current[self.voice_offset : self.voice_offset + count]
            written += count
            self.voice_offset += count
            if self.voice_offset >= len(self.voice_current):
                self.voice_current = None
        return output, written > 0

    # --- música -------------------------------------------------------------
    def push_music(self, data):
        with self.lock:
            self.music_buffer.extend(data)
            self.music_last_data_at = time.monotonic()

    def music_has_room(self):
        with self.lock:
            return len(self.music_buffer) < MUSIC_BUFFER_MAX_BYTES

    def _take_music_chunk(self):
        if not self.music_buffer:
            return None
        piece = bytes(self.music_buffer[:CHUNK_BYTES])
        del self.music_buffer[:CHUNK_BYTES]
        if len(piece) < CHUNK_BYTES:
            piece += b'\0' * (CHUNK_BYTES - len(piece))
        return np.frombuffer(piece, dtype='<i2').astype(np.float32).reshape(-1, 2)

    # --- mezcla -------------------------------------------------------------
    def duck(self, seconds):
        with self.lock:
            self.duck_until = max(self.duck_until, time.monotonic() + min(seconds, MAX_DUCK_SECONDS))

    def unduck(self):
        with self.lock:
            self.duck_until = 0.0

    def next_chunk(self):
        with self.lock:
            music = self._take_music_chunk()
            voice, voice_present = self._take_voice_chunk()
            ducked = voice_present or self.is_voice_active() or time.monotonic() < self.duck_until
            target = MUSIC_DUCK_GAIN if ducked else 1.0
            if self.music_gain < target:
                self.music_gain = min(target, self.music_gain + MUSIC_GAIN_STEP)
            elif self.music_gain > target:
                self.music_gain = max(target, self.music_gain - MUSIC_GAIN_STEP)
            mixed = voice * self.voice_level
            if music is not None:
                mixed = mixed + music * self.music_gain
        return np.clip(mixed, -32768, 32767).astype('<i2').tobytes()

    def snapshot(self):
        with self.lock:
            return {
                'ok': True,
                'voicePlaying': self.is_voice_active(),
                'voiceQueued': len(self.voice_queue),
                'musicActive': time.monotonic() - self.music_last_data_at < 2.0,
                'ducked': time.monotonic() < self.duck_until,
                'voiceLevel': round(self.voice_level * 100),
                'musicGain': round(self.music_gain, 2),
            }


def output_loop(mixer):
    """Escribe sin parar al jack: aplay bloquea y eso marca el ritmo real."""
    while True:
        player = subprocess.Popen(
            ['aplay', '-q', '-D', ALSA_DEVICE, '-t', 'raw', '-f', 'S16_LE',
             '-r', str(OUTPUT_RATE), '-c', str(OUTPUT_CHANNELS), '--buffer-time=200000'],
            stdin=subprocess.PIPE,
        )
        log('speaker_salida_abierta', dispositivo=ALSA_DEVICE)
        try:
            while True:
                player.stdin.write(mixer.next_chunk())
        except (BrokenPipeError, OSError) as error:
            log('speaker_salida_caida', error=str(error))
        finally:
            try:
                player.kill()
            except OSError:
                pass
        time.sleep(1)


def ensure_fifo(path):
    try:
        mode = os.stat(path).st_mode
        if stat.S_ISFIFO(mode):
            return
        os.remove(path)
    except FileNotFoundError:
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    os.mkfifo(path)
    # librespot corre con otro usuario.
    os.chmod(path, 0o666)


def music_loop(mixer):
    """Lee lo que manda librespot. Si el buffer está lleno, deja de leer y
    librespot se frena solo (escribe bloqueante en el pipe)."""
    ensure_fifo(MUSIC_FIFO)
    while True:
        # O_RDWR: el open no bloquea esperando a un escritor y el FIFO no da
        # EOF cada vez que raspotify se reinicia.
        fifo_fd = os.open(MUSIC_FIFO, os.O_RDWR)
        try:
            while True:
                if not mixer.music_has_room():
                    time.sleep(0.01)
                    continue
                data = os.read(fifo_fd, 16384)
                if data:
                    mixer.push_music(data)
        except OSError as error:
            if error.errno != errno.EINTR:
                log('speaker_musica_error', error=str(error))
                time.sleep(1)
        finally:
            os.close(fifo_fd)


def make_handler(mixer, token):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'jarvis-speaker'

        def log_message(self, format, *args):
            pass

        def _reply(self, status, payload):
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self):
            if self.headers.get('X-Speaker-Token', '') != token:
                self._reply(401, {'ok': False, 'error': 'token'})
                return False
            return True

        def _query(self):
            return {key: values[0] for key, values in parse_qs(urlparse(self.path).query).items()}

        def do_GET(self):
            if not self._authorized():
                return
            if urlparse(self.path).path == '/health':
                self._reply(200, mixer.snapshot())
            else:
                self._reply(404, {'ok': False})

        def do_POST(self):
            if not self._authorized():
                return
            path = urlparse(self.path).path
            query = self._query()
            length = int(self.headers.get('Content-Length', '0') or 0)
            if length > MAX_PLAY_BYTES:
                self._reply(413, {'ok': False, 'error': 'demasiado largo'})
                return
            body = self.rfile.read(length) if length > 0 else b''
            try:
                if path == '/play':
                    rate = int(query.get('rate', '24000'))
                    channels = int(query.get('channels', '1'))
                    if rate < 8000 or rate > 96000 or channels not in (1, 2):
                        self._reply(400, {'ok': False, 'error': 'formato'})
                        return
                    seconds = mixer.enqueue_voice(body, rate, channels)
                    log('speaker_voz_encolada', segundos=round(seconds, 2))
                    self._reply(200, {'ok': True, 'seconds': seconds})
                elif path == '/stop':
                    mixer.stop_voice()
                    self._reply(200, {'ok': True})
                elif path == '/duck':
                    mixer.duck(float(query.get('seconds', '15')))
                    self._reply(200, {'ok': True})
                elif path == '/unduck':
                    mixer.unduck()
                    self._reply(200, {'ok': True})
                elif path == '/volume':
                    mixer.set_voice_level(float(query['voice']) / 100)
                    self._reply(200, mixer.snapshot())
                else:
                    self._reply(404, {'ok': False})
            except (KeyError, ValueError) as error:
                self._reply(400, {'ok': False, 'error': str(error)})

    return Handler


def main():
    token = load_token()
    if len(token) < 16:
        sys.exit('Token demasiado corto en ' + TOKEN_FILE)
    mixer = Mixer()
    threading.Thread(target=output_loop, args=(mixer,), daemon=True).start()
    threading.Thread(target=music_loop, args=(mixer,), daemon=True).start()
    server = ThreadingHTTPServer(('0.0.0.0', LISTEN_PORT), make_handler(mixer, token))
    log('speaker_listo', puerto=LISTEN_PORT, fifo=MUSIC_FIFO)
    server.serve_forever()


if __name__ == '__main__':
    main()
