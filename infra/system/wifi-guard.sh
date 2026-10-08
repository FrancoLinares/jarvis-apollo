#!/bin/sh
# Guardián de WiFi de la Pi (cron cada 2 min, root):
#   */2 * * * * root /usr/local/sbin/wifi-guard.sh      (en /etc/cron.d/wifi-guard)
#
# Si la Pi no llega al router, fuerza la reconexión. Con un repetidor WiFi en el
# medio, la red se cae a veces y NetworkManager, después de unos pocos intentos
# fallidos (autoconnect-retries = 4 por defecto), deja de reintentar: la Pi
# queda prendida pero fuera de la red hasta que alguien la reinicia.
# Complemento recomendado, una sola vez:
#   sudo nmcli connection modify "<tu conexión>" connection.autoconnect-retries 0
GATEWAY="$(ip route show default | awk '/default/ {print $3; exit}')"
CONN="$(nmcli -t -f NAME,TYPE connection show --active | awk -F: '$2 == "802-11-wireless" {print $1; exit}')"
if [ -n "$GATEWAY" ] && ping -c 3 -W 3 "$GATEWAY" >/dev/null 2>&1; then
  exit 0
fi
if [ -z "$CONN" ]; then
  # Sin conexión activa no hay nombre que levantar: se reinicia la radio.
  CONN="$(nmcli -t -f NAME,TYPE connection show | awk -F: '$2 == "802-11-wireless" {print $1; exit}')"
fi
logger -t wifi-guard "sin respuesta del router; reconectando ${CONN:-wifi}"
if [ -n "$CONN" ] && nmcli con up "$CONN" >/dev/null 2>&1; then
  exit 0
fi
nmcli radio wifi off
sleep 3
nmcli radio wifi on
