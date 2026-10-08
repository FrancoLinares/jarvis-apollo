# Funciones comunes de los scripts. Se carga con:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
#
# Regla de la casa: un secreto nunca se escribe en un archivo de la Mac ni viaja
# como argumento de un comando (quedaría en el historial y en `ps`). Sale del
# Llavero a una variable en memoria y de ahí por stdin a donde tenga que ir.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$REPO_ROOT/secrets.manifest"

# Configuración local, NO secreta (IP de la Pi, URL del servidor). Ver jarvis.env.example.
if [ -f "$REPO_ROOT/jarvis.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/jarvis.env"
  set +a
fi

JARVIS_KEYCHAIN_SERVICE="${JARVIS_KEYCHAIN_SERVICE:-jarvis}"
# Carpetas en la Pi, relativas al home del usuario remoto.
JARVIS_PI_APOLLO_DIR="${JARVIS_PI_APOLLO_DIR:-apollo-server}"
JARVIS_PI_MCP_DIR="${JARVIS_PI_MCP_DIR:-mcp-servers}"
JARVIS_PI_WHATSAPP_DIR="${JARVIS_PI_WHATSAPP_DIR:-whatsapp}"

die() { echo "✗ $*" >&2; exit 1; }

require_macos() {
  [ "$(uname -s)" = "Darwin" ] || die "Este script usa el Llavero de macOS (comando security)."
}

require_pi() {
  [ -n "${JARVIS_PI:-}" ] || die "Definí JARVIS_PI=usuario@ip-de-la-pi en jarvis.env (copiá jarvis.env.example)."
}

# Filas útiles del manifiesto: NOMBRE DESTINOS NIVEL DESCRIPCIÓN
manifest_rows() { grep -vE '^[[:space:]]*(#|$)' "$MANIFEST"; }

manifest_has() { manifest_rows | awk '{print $1}' | grep -qx "$1"; }

# Nombres cuyo campo DESTINOS incluye $1 (apollo, mcp, whatsapp, ...).
manifest_names_for() {
  manifest_rows | awk -v target="$1" '{
    count = split($2, list, ",")
    for (i = 1; i <= count; i++) if (list[i] == target) print $1
  }'
}

manifest_level() { manifest_rows | awk -v name="$1" '$1 == name {print $3}'; }

kc_has() { security find-generic-password -s "$JARVIS_KEYCHAIN_SERVICE" -a "$1" >/dev/null 2>&1; }

kc_get() { security find-generic-password -s "$JARVIS_KEYCHAIN_SERVICE" -a "$1" -w 2>/dev/null; }

# Guarda un valor SIN espacios ni comillas (hex, base64) pasándoselo a `security -i`
# por stdin: printf es un builtin, así que el valor no aparece en ningún argv.
kc_put_token() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[A-Za-z0-9+/=_.-]+$ ]] || die "kc_put_token: $name tiene caracteres no permitidos"
  printf 'add-generic-password -U -s %s -a %s -l %s -w %s\n' \
    "$JARVIS_KEYCHAIN_SERVICE" "$name" "$JARVIS_KEYCHAIN_SERVICE.$name" "$value" | security -i >/dev/null
}

# Línea para un env_file de docker compose. Sin comillas si no hacen falta (así
# `grep ^X= | cut -d= -f2-` sigue andando en la Pi); con comillas simples, que
# compose toma literal (sin interpolar $), si el valor tiene espacios o símbolos.
env_line() {
  local name="$1" value="$2"
  if [[ "$value" =~ ^[A-Za-z0-9_./:@+=,-]*$ ]]; then
    printf '%s=%s\n' "$name" "$value"
  elif [[ "$value" != *"'"* && "$value" != *$'\n'* ]]; then
    printf "%s='%s'\n" "$name" "$value"
  else
    die "$name tiene comillas simples o saltos de línea: docker compose no lo puede leer literal."
  fi
}
