#!/usr/bin/env bash
# Cambia la voz de Jarvis entre Piper (local) y Azure (nube), o muestra cuál está
# activa. Se corre desde la Mac.
#
#   tools/voz.sh            -> muestra el estado (lo que ve el PROCESO, no el archivo)
#   tools/voz.sh piper      -> Piper: local, gratis, acento mexicano
#   tools/voz.sh azure      -> Azure: es-AR-TomasNeural (la key va al Llavero:
#                              scripts/secrets.sh set AZURE_SPEECH_KEY)
#
# Cambia TTS_PROVIDER en server/config.env y vuelve a subir el .dev.vars. Piper
# queda siempre como red de seguridad: si Azure falla, habla Piper.
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"
require_pi
CONFIG="$REPO_ROOT/server/config.env"

show() {
  # Lo que importa es lo que ve el proceso: el archivo puede estar adelantado.
  ssh "$JARVIS_PI" 'docker exec docker-apollo-1 sh -lc '"'"'
    echo "  proveedor EN USO: ${TTS_PROVIDER:-(sin definir)}"
    [ -n "$AZURE_SPEECH_KEY" ] && echo "  key de Azure: presente" || echo "  key de Azure: no está"
    echo "  voz Azure: ${AZURE_SPEECH_VOICE:-es-AR-TomasNeural} (${AZURE_SPEECH_REGION:-brazilsouth})"
    echo "  voz Piper: $(basename "${PIPER_VOICE_MODEL:-?}")"'"'"
  echo "  proveedor en server/config.env: $(grep '^TTS_PROVIDER=' "$CONFIG" | cut -d= -f2-)"
}

switch_to() {
  [ -f "$CONFIG" ] || die "Falta server/config.env (copiá server/config.env.example)."
  if [ "$1" = azure ] && ! kc_has AZURE_SPEECH_KEY; then
    die "Falta AZURE_SPEECH_KEY en el Llavero: scripts/secrets.sh set AZURE_SPEECH_KEY"
  fi
  if grep -q '^TTS_PROVIDER=' "$CONFIG"; then
    sed -i '' "s/^TTS_PROVIDER=.*/TTS_PROVIDER=$1/" "$CONFIG"
  else
    echo "TTS_PROVIDER=$1" >> "$CONFIG"
  fi
  # --restart recrea el contenedor (up -d): `docker compose restart` NO relee el
  # env_file y el proceso seguiría con la voz vieja sin ningún error en el log.
  "$REPO_ROOT/scripts/push-secrets.sh" apollo --restart
  sleep 5
  show
}

case "${1:-}" in
  "") show ;;
  piper | azure | elevenlabs) switch_to "$1" ;;
  *) echo "uso: tools/voz.sh [piper | azure | elevenlabs]"; exit 1 ;;
esac
