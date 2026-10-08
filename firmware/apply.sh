#!/usr/bin/env bash
# Arma el árbol del firmware: clona apollo-firmware en el commit probado (2.7.1)
# y copia encima el overlay de Jarvis (placa Waveshare 4.3C, tablero LVGL,
# Einstein, "Hey Jarvis", guardianes, etc.).
#
#   firmware/apply.sh [destino]        (default: ~/esp/jarvis-apollo-firmware)
#
# Regla: los cambios se hacen en firmware/overlay/ y se vuelve a correr esto.
# Editar el árbol de destino a mano se pierde en la próxima corrida.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-$HOME/esp/jarvis-apollo-firmware}"
UPSTREAM_URL="https://github.com/galfrevn/apollo-firmware"
UPSTREAM_COMMIT="503d506a9c85147961372d0cf0fb358ba725633b"   # v2.7.1, 2026-08-13

if [ ! -d "$DEST/.git" ]; then
  git clone "$UPSTREAM_URL" "$DEST"
fi
git -C "$DEST" checkout -q "$UPSTREAM_COMMIT"
git -C "$DEST" reset -q --hard "$UPSTREAM_COMMIT"
# build/, managed_components/ y sdkconfig quedan (están en el .gitignore de upstream).
git -C "$DEST" clean -qfd
cp -R "$HERE/overlay/." "$DEST/"
echo "✓ apollo-firmware $UPSTREAM_COMMIT + overlay de Jarvis en $DEST"
echo "  Siguiente paso: firmware/build.sh $DEST"
