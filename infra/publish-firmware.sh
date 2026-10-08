#!/usr/bin/env bash
# Publica un firmware en Apollo para que la placa se actualice por WiFi (sin USB).
#
#   infra/publish-firmware.sh ~/esp/jarvis-apollo-firmware/build/xiaozhi.bin 2.7.4 "qué cambia" [--apply]
#
# Ojo: el .bin lleva el secreto de la placa adentro; solo viaja a tu Pi.
#
# - Verifica que la versión grabada dentro del binario (esp_app_desc) sea la que se anuncia:
#   la placa decide si actualizar comparando números, y un binario 2.7.2 anunciado como 2.7.3
#   quedaría reinstalándose en cada arranque.
# - Lo sube al almacén de Apollo (/data/blobs/firmware/<versión>.bin) y escribe el manifiesto
#   firmware/latest.json que lee /ota/check.
# - Con --apply le pide a la placa que se reinicie (POST /ota/apply → herramienta self.reboot):
#   al arrancar consulta /ota/check y se actualiza. Sin --apply, se actualiza en el próximo arranque.
#
# Seguridad: con rollback habilitado, la versión nueva arranca "pendiente" y recién se marca como
# buena tras 60 s seguidos conectada; si se cuelga antes, el bootloader vuelve a la anterior.
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"
require_pi

BIN="${1:?ruta al .bin}"
VERSION="${2:?versión, p. ej. 2.7.3}"
CHANGELOG="${3:-}"
APPLY="${4:-}"
PI="$JARVIS_PI"

[[ "$VERSION" =~ ^[0-9]+(\.[0-9]+)*$ ]] || { echo "Versión inválida: $VERSION" >&2; exit 1; }

# esp_app_desc_t arranca en 0x20 del binario; el campo version (32 bytes) está en 0x30.
EMBEDDED=$(python3 - "$BIN" <<'PY'
import sys, struct
data = open(sys.argv[1], 'rb').read(0x100)
magic = struct.unpack_from('<I', data, 0x20)[0]
if magic != 0xABCD5432:
    sys.exit('No es una imagen de app ESP-IDF (falta esp_app_desc)')
print(data[0x30:0x50].split(b'\0')[0].decode())
PY
)
if [[ "$EMBEDDED" != "$VERSION" ]]; then
  echo "El binario dice versión $EMBEDDED pero se anuncia $VERSION. Cambiá PROJECT_VER y recompilá." >&2
  exit 1
fi

MANIFEST=$(python3 -c 'import json,sys; print(json.dumps({"version": sys.argv[1], "key": f"firmware/{sys.argv[1]}.bin", **({"changelog": sys.argv[2][:500]} if sys.argv[2] else {})}))' "$VERSION" "$CHANGELOG")

scp -q "$BIN" "$PI:/tmp/firmware-$VERSION.bin"
printf '%s' "$MANIFEST" | ssh "$PI" "cat > /tmp/firmware-latest.json && \
  docker exec docker-apollo-1 mkdir -p /data/blobs/firmware && \
  docker cp /tmp/firmware-$VERSION.bin docker-apollo-1:/data/blobs/firmware/$VERSION.bin && \
  docker cp /tmp/firmware-latest.json docker-apollo-1:/data/blobs/firmware/latest.json && \
  rm -f /tmp/firmware-$VERSION.bin /tmp/firmware-latest.json"
echo "Publicado firmware $VERSION ($(wc -c < "$BIN" | tr -d ' ') bytes)."

if [[ "$APPLY" == "--apply" ]]; then
  ssh "$PI" 'TOKEN=$(grep "^DEVICE_SHARED_SECRET=" ~/apollo-server/.dev.vars | cut -d= -f2-); \
    curl -s -m 30 -X POST "http://localhost:8799/ota/apply?token=$TOKEN"'
  echo
  echo "La placa se reinicia, descarga la versión y vuelve a arrancar (~1 min)."
fi
