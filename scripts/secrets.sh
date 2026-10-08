#!/usr/bin/env bash
# Secretos de Jarvis en el Llavero de macOS (servicio "jarvis", cuenta = NOMBRE).
#
#   scripts/secrets.sh status                 qué hay cargado (nunca muestra valores)
#   scripts/secrets.sh set NOMBRE             pide el valor oculto (dos veces) y lo guarda
#   scripts/secrets.sh generate NOMBRE        genera 48 caracteres hex aleatorios y los guarda
#   scripts/secrets.sh set-file NOMBRE ARCH   guarda un archivo (p. ej. el JSON de OAuth) en base64
#   scripts/secrets.sh delete NOMBRE
#
# Los NOMBRES válidos están en secrets.manifest. Para verlos en Acceso a Llaveros:
# buscá "jarvis.".
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_macos

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

check_name() {
  [ -n "${1:-}" ] || usage
  manifest_has "$1" || die "$1 no está en secrets.manifest (agregalo ahí primero si es nuevo)."
}

case "${1:-}" in
  status)
    printf '%-30s %-10s %s\n' NOMBRE NIVEL ESTADO
    missing_required=0
    while read -r name _ level _; do
      if kc_has "$name"; then state="✓ cargado"; else state="· falta"; fi
      if [ "$level" = requerido ] && ! kc_has "$name"; then missing_required=1; state="✗ FALTA"; fi
      printf '%-30s %-10s %s\n' "$name" "$level" "$state"
    done < <(manifest_rows)
    [ "$missing_required" = 0 ] || { echo; echo "Faltan secretos requeridos."; exit 1; }
    ;;
  set)
    check_name "${2:-}"
    echo "Pegá el valor de $2 (no se muestra; lo pide dos veces):"
    # -w al final, sin valor: lo pide el propio security, oculto. Así acepta
    # cualquier carácter (espacios, comas) y no pasa por argv ni por el historial.
    security add-generic-password -U -s "$JARVIS_KEYCHAIN_SERVICE" -a "$2" \
      -l "$JARVIS_KEYCHAIN_SERVICE.$2" -w
    echo "✓ $2 guardado en el Llavero."
    ;;
  generate)
    check_name "${2:-}"
    if kc_has "$2"; then
      echo "$2 ya existe. Regenerarlo obliga a actualizarlo en todos sus destinos" \
        "(y a recompilar el firmware si es DEVICE_SHARED_SECRET)."
      read -r -p "¿Regenerar? [s/N] " answer
      [ "$answer" = s ] || exit 0
    fi
    kc_put_token "$2" "$(openssl rand -hex 24)"
    echo "✓ $2 generado y guardado."
    ;;
  set-file)
    check_name "${2:-}"
    [ -f "${3:-}" ] || die "Uso: set-file NOMBRE ARCHIVO"
    kc_put_token "$2" "$(base64 < "$3" | tr -d '\n')"
    echo "✓ $2 guardado. Ya podés borrar $3 de la Mac."
    ;;
  delete)
    check_name "${2:-}"
    security delete-generic-password -s "$JARVIS_KEYCHAIN_SERVICE" -a "$2" >/dev/null
    echo "✓ $2 borrado."
    ;;
  *) usage ;;
esac
