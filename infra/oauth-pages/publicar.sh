#!/usr/bin/env bash
# Publica las paginas de inicio y privacidad que Google exige para sacar la app
# OAuth de "Testing" (donde el refresh token vence a los 7 dias).
#
# Se corre UNA vez desde la Mac:
#   GITHUB_USER=tu-usuario GOOGLE_CLOUD_PROJECT=tu-proyecto bash infra/oauth-pages/publicar.sh
#
# Crea un repo publico con GitHub Pages. Es gratis y el contenido es el minimo
# que pide Google: una pagina principal y una politica de privacidad.
set -euo pipefail

USUARIO="${GITHUB_USER:?definí GITHUB_USER (tu usuario de GitHub)}"
PROYECTO_GCP="${GOOGLE_CLOUD_PROJECT:-TU-PROYECTO}"
REPO="jarvis-voice-assistant"
ORIGEN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRABAJO="$HOME/jarvis-oauth-pages"
# El bash de macOS es 3.2 y NO soporta ${VAR,,}: da "bad substitution". Con tr
# anda en cualquier version.
USUARIO_MIN="$(printf '%s' "$USUARIO" | tr '[:upper:]' '[:lower:]')"
BASE="https://${USUARIO_MIN}.github.io/${REPO}"

echo "==> 1/5  Preparando archivos en $TRABAJO"
mkdir -p "$TRABAJO"
for pagina in index.html privacy.html; do
  sed "s/__GITHUB_USER__/$USUARIO/g" "$ORIGEN/$pagina" > "$TRABAJO/$pagina"
done
cd "$TRABAJO"

if [ ! -d .git ]; then
  git init -q -b main
fi
git add -A
# --allow-empty para que re-ejecutar el script no falle si no cambio nada.
git commit -q --allow-empty -m "Paginas de inicio y privacidad para la app OAuth de Jarvis

Google exige una URL de pagina principal y una de politica de privacidad para
pasar la app de Testing a produccion, que es lo que evita que el refresh token
venza cada 7 dias."

echo "==> 2/5  Creando el repositorio publico"
if gh repo view "$USUARIO/$REPO" >/dev/null 2>&1; then
  echo "    ya existia, solo empujo los cambios"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "git@github.com:$USUARIO/$REPO.git"
  git push -q -u origin main --force-with-lease 2>/dev/null || git push -q -u origin main
else
  gh repo create "$USUARIO/$REPO" --public --source=. --push \
    --description "Asistente de voz personal - paginas de inicio y privacidad para la app OAuth"
fi

echo "==> 3/5  Activando GitHub Pages"
# Si Pages ya estaba activo la API devuelve 409: no es un error para nosotros.
if gh api "repos/$USUARIO/$REPO/pages" >/dev/null 2>&1; then
  echo "    Pages ya estaba activo"
else
  gh api "repos/$USUARIO/$REPO/pages" -X POST --input - >/dev/null <<'JSON'
{"source":{"branch":"main","path":"/"}}
JSON
  echo "    activado"
fi

echo "==> 4/5  Esperando a que GitHub publique (puede tardar ~2 min)"
INICIO="$BASE/"
PRIVACIDAD="$BASE/privacy.html"
for intento in $(seq 1 40); do
  c1=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$INICIO" || echo 000)
  c2=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$PRIVACIDAD" || echo 000)
  if [ "$c1" = "200" ] && [ "$c2" = "200" ]; then
    echo "    ambas paginas responden 200"
    break
  fi
  printf "    intento %2d/40  inicio=%s privacidad=%s\n" "$intento" "$c1" "$c2"
  sleep 15
done

if [ "${c1:-000}" != "200" ] || [ "${c2:-000}" != "200" ]; then
  echo
  echo "!! Las paginas todavia no responden 200. GitHub a veces tarda mas en el"
  echo "   primer despliegue. Revisa el estado en:"
  echo "   https://github.com/$USUARIO/$REPO/settings/pages"
  exit 1
fi

cat <<FIN

==> 5/5  Listo. Pega esto en la pantalla de Marca de Google:

  Nombre de la app .............. Jarvis
  Correo de asistencia .......... $(git config user.email)
  URL de pagina principal ....... $INICIO
  URL de politica de privacidad . $PRIVACIDAD

  Dominio autorizado ............ ${USUARIO_MIN}.github.io

  (github.io esta en la Public Suffix List, asi que el dominio autorizado es
   el subdominio completo, NO "github.io" a secas.)

Despues:
  1. Publicar la app:
     https://console.cloud.google.com/auth/audience?project=$PROYECTO_GCP
  2. Re-autenticar Calendar (dos terminales, ver instrucciones).

FIN
