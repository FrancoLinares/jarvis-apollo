# jarvis-speaker: parlante externo por el jack de la Pi

Un parlante **activo** enchufado al jack de 3,5 mm de la Raspberry Pi 4 pasa:

- **Spotify Connect**: raspotify aparece como el dispositivo **"Jarvis"** en la app de Spotify (requiere Premium);
- **la voz de Jarvis**: Apollo manda los avisos al parlante (y las respuestas, en modo parlante).

Mientras Jarvis habla, o mientras la placa escucha ("hey Jarvis"), la música baja al 18 % y después vuelve.

## Por qué un mezclador propio

En esta Pi (kernel 6.18, salida `bcm2835 Headphones`) **ALSA dmix se cuelga en el primer write**, con cualquier
tamaño de buffer (probados 4: siempre timeout), mientras que `plughw:Headphones` directo anda. Por eso
`speaker.py` es el **único dueño del jack** y mezcla él mismo:

```
raspotify (librespot, backend pipe) ──► /run/jarvis-speaker/music.fifo ──┐
                                                                         ├─► speaker.py (numpy) ──► aplay plughw:Headphones
Apollo (Docker) ── POST /play (PCM 24 kHz mono) ─────────────────────────┘
```

No hay `/etc/asound.conf`: si aparece uno con dmix, sacarlo.

## Archivos en la Pi

| Archivo | Qué es |
|---|---|
| `/opt/jarvis-speaker/speaker.py` | el mezclador (este directorio) |
| `/etc/systemd/system/jarvis-speaker.service` | unidad (`User=` tu usuario de la Pi, `Restart=always`) |
| `/etc/systemd/system/raspotify.service.d/jarvis.conf` | raspotify → pipe, nombre "Jarvis", 320 kbps |
| `/etc/jarvis-speaker/token` | token compartido con Apollo (`SPEAKER_TOKEN`; lo sube `scripts/push-secrets.sh speaker`) |
| `/var/lib/jarvis-speaker/state.json` | volumen de la voz |

Apollo: `SPEAKER_URL=http://host.docker.internal:8790`, `SPEAKER_ROUTE=avisos` (default), `SPEAKER_TOKEN`, y
`extra_hosts: host.docker.internal:host-gateway` en `docker/compose.yaml`. Código en
`deploy/pi/apollo/overrides/speaker/output.ts`, `tools/speaker.ts` (herramienta `parlante`), `agents/notify.ts`,
`agents/runtime.ts` y `host/actor.ts`.

## Modos (herramienta `parlante`, por voz)

- `avisos` (default): avisos y recordatorios por el parlante; la conversación en la placa.
- `todo`: "modo parlante", también las respuestas.
- `apagado`: todo en la placa.

Cuando el audio va al parlante, la placa recibe **silencio del mismo largo**: su estado (hablando → reposo, acks,
overlay) no cambia. Si el parlante no contesta, el audio va a la placa.

## Instalar / actualizar

```bash
source jarvis.env   # JARVIS_PI=usuario@ip
scp infra/speaker/{speaker.py,jarvis-speaker.service,raspotify-jarvis.conf} "$JARVIS_PI:/tmp/"
ssh "$JARVIS_PI" '
  sudo install -d /opt/jarvis-speaker /etc/systemd/system/raspotify.service.d
  sudo install -m 0644 /tmp/speaker.py /opt/jarvis-speaker/speaker.py
  sudo install -m 0644 /tmp/jarvis-speaker.service /etc/systemd/system/
  sudo install -m 0644 /tmp/raspotify-jarvis.conf /etc/systemd/system/raspotify.service.d/jarvis.conf
  sudo systemctl daemon-reload && sudo systemctl enable jarvis-speaker'
scripts/secrets.sh generate SPEAKER_TOKEN
scripts/push-secrets.sh speaker --restart   # escribe /etc/jarvis-speaker/token
scripts/push-secrets.sh apollo --restart    # y el mismo token en el .dev.vars
```

Dependencias: `python3-numpy`, `raspotify` (repo apt `dtcooper.github.io/raspotify`).

## Probar

En la Pi. El token va por stdin (`-H @-`), no como argumento de curl:

```bash
sudo sh -c 'printf "X-Speaker-Token: %s\n" "$(cat /etc/jarvis-speaker/token)"' | curl -s -H @- localhost:8790/health
# {"voicePlaying":…, "musicActive":…, "ducked":…, "voiceLevel":80, "musicGain":1.0}
```

Medido el 2026-10-04: 0,3 % de CPU y 31 MB en reposo; recordatorio real por la consola → 6,55 s de audio en el
parlante; con música en el pipe, `musicGain` 1,0 → 0,18 con voz o `/duck` → 1,0 al terminar.
