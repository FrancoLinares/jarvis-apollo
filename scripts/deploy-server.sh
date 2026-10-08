#!/usr/bin/env bash
# Deploy del servidor a la Pi: upstream + overlay, sube el código, regenera el
# .dev.vars desde el Llavero y reconstruye el contenedor.
#
#   scripts/deploy-server.sh
#
# Ojo: reconstruir corta cualquier conversación en curso y `docker logs` arranca
# de cero (los logs también quedan en /data/apollo.log dentro del volumen).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_macos
require_pi

BUILD="$REPO_ROOT/.cache/apollo"
STAGE="$REPO_ROOT/.cache/apollo-deploy"
"$REPO_ROOT/server/apply.sh" "$BUILD"

# Lo que se sube: apps/agent, sin tests ni dependencias, y con package.json SIN
# devDependencies. Fuera del monorepo "@apollo/typescript-config": "workspace:*"
# no existe y el `bun install --production` del Dockerfile falla.
rm -rf "$STAGE" && mkdir -p "$STAGE"
rsync -a --exclude node_modules --exclude __tests__ --exclude .dev.vars "$BUILD/apps/agent/" "$STAGE/"
python3 -I - "$STAGE/package.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
data.pop('devDependencies', None)
with open(path, 'w') as handle:
    json.dump(data, handle, indent=2)
    handle.write('\n')
PY

# Una tarjeta SD llena deja archivos truncados a mitad del deploy (pasó).
usage="$(ssh "$JARVIS_PI" "df --output=pcent / | tail -1 | tr -dc '0-9'")"
if [ "${usage:-0}" -ge 90 ]; then
  die "El disco de la Pi está al ${usage}%. Liberá espacio antes (docker builder prune -af)."
fi

# COPYFILE_DISABLE evita los ._* de macOS, que después bun test intenta correr.
COPYFILE_DISABLE=1 rsync -az --delete --exclude .dev.vars --exclude '._*' \
  "$STAGE/" "$JARVIS_PI:$JARVIS_PI_APOLLO_DIR/"
"$REPO_ROOT/scripts/push-secrets.sh" apollo
ssh "$JARVIS_PI" "docker network inspect jarvis-mcp >/dev/null 2>&1 || docker network create jarvis-mcp >/dev/null;
  cd '$JARVIS_PI_APOLLO_DIR/docker' && docker compose up -d --build"

host="${JARVIS_PI#*@}"
for _ in $(seq 1 30); do
  if curl -s --max-time 2 "http://$host:8799/health" | grep -q '"ok":true'; then
    echo "✓ Apollo responde en http://$host:8799/health"
    exit 0
  fi
  sleep 2
done
die "Apollo no respondió en 60 s. Mirá: ssh $JARVIS_PI 'docker logs --tail 50 docker-apollo-1'"
