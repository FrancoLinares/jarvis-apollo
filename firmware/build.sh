#!/usr/bin/env bash
# Compila (y opcionalmente flashea) el firmware con la URL del servidor y el
# secreto de la placa. El secreto sale del Llavero a un archivo temporal 600 que
# se borra al terminar; NUNCA se escribe en sdkconfig.defaults.
#
#   firmware/build.sh [árbol]                  compila (default ~/esp/jarvis-apollo-firmware)
#   firmware/build.sh [árbol] flash [puerto]   compila y flashea (default /dev/cu.usbmodem101)
#
# Ojo: el binario y el sdkconfig/build/ del árbol SÍ llevan el secreto adentro
# (la placa lo necesita). No compartas un .bin ni ese árbol.
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"
require_macos

TREE="${1:-$HOME/esp/jarvis-apollo-firmware}"
ACTION="${2:-build}"
PORT="${3:-/dev/cu.usbmodem101}"
[ -f "$TREE/main/application.cc" ] || die "No encuentro el firmware en $TREE (corré firmware/apply.sh primero)."
[ -n "${JARVIS_APOLLO_URL:-}" ] || die "Definí JARVIS_APOLLO_URL=ws://IP-DE-LA-PI:8799 en jarvis.env (sin path)."
TOKEN="$(kc_get DEVICE_SHARED_SECRET)" || die "Falta DEVICE_SHARED_SECRET: scripts/secrets.sh generate DEVICE_SHARED_SECRET"

SECRETS_DIR="$(mktemp -d)"
trap 'rm -rf "$SECRETS_DIR"' EXIT
(
  umask 077
  printf 'CONFIG_APOLLO_URL="%s"\nCONFIG_APOLLO_TOKEN="%s"\nCONFIG_APOLLO_DEVICE_ID="%s"\n' \
    "$JARVIS_APOLLO_URL" "$TOKEN" "${JARVIS_DEVICE_NAME:-jarvis}" > "$SECRETS_DIR/sdkconfig.secrets"
)
unset TOKEN

# ESP-IDF en macOS necesita cmake y ninja de Homebrew (brew install cmake ninja).
if ! command -v cmake >/dev/null 2>&1 && [ -x /opt/homebrew/bin/cmake ]; then
  PATH="/opt/homebrew/bin:$PATH"
fi
command -v cmake >/dev/null 2>&1 || die "Falta cmake: brew install cmake ninja"
# export.sh elige el entorno de Python según el `python3` del PATH; si ese no es
# con el que se instaló ESP-IDF (pasa en macOS: /usr/bin/python3 vs Homebrew),
# falla. Con un solo entorno instalado, se usa ese.
if [ -z "${IDF_PYTHON_ENV_PATH:-}" ]; then
  environment_list=("$HOME"/.espressif/python_env/idf*_env)
  if [ "${#environment_list[@]}" -eq 1 ] && [ -d "${environment_list[0]}" ]; then
    export IDF_PYTHON_ENV_PATH="${environment_list[0]}"
  fi
fi
# shellcheck disable=SC1091
. "${IDF_PATH:-$HOME/esp/esp-idf}/export.sh" >/dev/null
cd "$TREE"
# Los defaults solo se aplican a lo que el sdkconfig no tenga: sin borrarlo, un
# cambio de URL o de secreto no entraría nunca. Se borra y se regenera en cada build
# (el orden es sdkconfig.defaults, sdkconfig.defaults.esp32s3 y el de secretos).
rm -f sdkconfig
idf.py -D IDF_TARGET=esp32s3 -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;$SECRETS_DIR/sdkconfig.secrets" build

# Control antes de flashear: si el tablero no quedó en el binario, el linker lo
# descartó en silencio (pasó: pantalla blanca sin errores de compilación).
# (grep -c y no grep -q: -q corta el pipe, strings muere por SIGPIPE y con
# pipefail parece que no estaba.)
if [ "$(strings build/xiaozhi.elf | grep -c "tablero armado")" = 0 ]; then
  die "El binario no tiene el tablero LVGL (revisá la placa en sdkconfig.defaults)."
fi

if [ "$ACTION" = flash ]; then
  # 460800 y no 921600: a 921600 el flasheo se corta. Y nada más puede tener el
  # puerto abierto (un monitor serie corta el flasheo a mitad).
  if lsof "$PORT" >/dev/null 2>&1; then die "Hay otro proceso usando $PORT (¿un monitor serie?)."; fi
  idf.py -p "$PORT" -b 460800 flash
fi
echo "✓ Firmware listo: $TREE/build/xiaozhi.bin"
