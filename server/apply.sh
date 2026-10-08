#!/usr/bin/env bash
# Arma el servidor: clona Apollo upstream en el commit probado y copia encima el
# overlay de Jarvis (archivos nuevos y archivos de upstream modificados, con la
# misma ruta que en upstream).
#
#   server/apply.sh [destino]        (default: .cache/apollo dentro del repo)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-$HERE/../.cache/apollo}"
UPSTREAM_URL="https://github.com/galfrevn/apollo"
UPSTREAM_BRANCH="feat/node-host"     # main es solo Cloudflare; el host Bun vive acá
UPSTREAM_COMMIT="62628b820339d74b6de5984ed6744ada42c13521"   # 2026-08-17

if [ ! -d "$DEST/.git" ]; then
  git clone --branch "$UPSTREAM_BRANCH" "$UPSTREAM_URL" "$DEST"
fi
git -C "$DEST" fetch -q origin "$UPSTREAM_BRANCH" || true
git -C "$DEST" checkout -q "$UPSTREAM_COMMIT"
# Volver a upstream limpio antes de copiar: un archivo borrado del overlay no
# tiene que sobrevivir de una corrida anterior.
git -C "$DEST" reset -q --hard "$UPSTREAM_COMMIT"
git -C "$DEST" clean -qfd -e node_modules
cp -R "$HERE/overlay/." "$DEST/"
echo "✓ Apollo $UPSTREAM_COMMIT + overlay de Jarvis en $DEST"
