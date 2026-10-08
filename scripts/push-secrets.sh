#!/usr/bin/env bash
# Arma los archivos de configuración de la Pi con los secretos del Llavero y los
# sube por ssh. Nada se escribe en el disco de la Mac: el contenido va de la
# memoria al stdin de ssh, y en la Pi se crea con umask 077 (permisos 600).
#
#   scripts/push-secrets.sh apollo [--restart]     ~/apollo-server/.dev.vars
#   scripts/push-secrets.sh mcp [--restart]        ~/mcp-servers/.env
#   scripts/push-secrets.sh whatsapp [--restart]   ~/whatsapp/.env
#   scripts/push-secrets.sh speaker [--restart]    /etc/jarvis-speaker/token (sudo sin contraseña)
#   scripts/push-secrets.sh google                 ~/mcp-servers/google/oauth-client.json
#   scripts/push-secrets.sh all [--restart]
#
# La parte NO secreta del .dev.vars (modelos, interruptores) sale de server/config.env.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_macos
require_pi

TARGET="${1:-}"
RESTART="${2:-}"

# NOMBRE=valor de cada secreto del destino que esté en el Llavero.
secret_lines() {
  local target="$1" name value
  for name in $(manifest_names_for "$target"); do
    if value="$(kc_get "$name")"; then
      env_line "$name" "$value"
    elif [ "$(manifest_level "$name")" = requerido ]; then
      die "Falta $name en el Llavero: scripts/secrets.sh set $name"
    fi
  done
}

# Sube stdin a un archivo de la Pi de forma atómica y con permisos 600.
remote_write() {
  local directory="$1" file="$2"
  ssh "$JARVIS_PI" "umask 077 && mkdir -p '$directory' && cat > '$directory/$file.tmp' && mv '$directory/$file.tmp' '$directory/$file'"
}

push_apollo() {
  local config="$REPO_ROOT/server/config.env" content name
  [ -f "$config" ] || die "Falta server/config.env (copiá server/config.env.example)."
  # Un secreto en config.env terminaría commiteado tarde o temprano: se rechaza.
  for name in $(manifest_rows | awk '{print $1}'); do
    if grep -qE "^[[:space:]]*$name=" "$config"; then
      die "$name está en server/config.env: los secretos van al Llavero (scripts/secrets.sh set $name)."
    fi
  done
  content="$(grep -vE '^[[:space:]]*(#|$)' "$config"; secret_lines apollo)"
  printf '%s\n' "$content" | remote_write "$JARVIS_PI_APOLLO_DIR" .dev.vars
  echo "✓ $JARVIS_PI_APOLLO_DIR/.dev.vars actualizado ($(printf '%s\n' "$content" | grep -c =) variables)"
  if [ "$RESTART" = --restart ]; then
    # `up -d` y NO `restart`: restart no relee el env_file y el proceso sigue con
    # la configuración vieja.
    ssh "$JARVIS_PI" "cd '$JARVIS_PI_APOLLO_DIR/docker' && docker compose up -d"
  fi
}

push_env_file() {
  local target="$1" directory="$2" content
  content="$(secret_lines "$target")"
  [ -n "$content" ] || { echo "· $target: no hay secretos cargados, no se toca."; return; }
  printf '%s\n' "$content" | remote_write "$directory" .env
  echo "✓ $directory/.env actualizado"
  if [ "$RESTART" = --restart ]; then
    ssh "$JARVIS_PI" "cd '$directory' && docker compose up -d"
  fi
}

push_speaker() {
  local token
  token="$(kc_get SPEAKER_TOKEN)" || { echo "· speaker: falta SPEAKER_TOKEN, no se toca."; return; }
  printf '%s' "$token" | ssh "$JARVIS_PI" \
    'sudo -n install -d -m 0755 /etc/jarvis-speaker &&
     sudo -n sh -c "umask 077; cat > /etc/jarvis-speaker/token" &&
     sudo -n chgrp "$(id -gn)" /etc/jarvis-speaker/token &&
     sudo -n chmod 0640 /etc/jarvis-speaker/token' \
    || die "speaker: hace falta sudo sin contraseña en la Pi para escribir /etc/jarvis-speaker/token."
  echo "✓ /etc/jarvis-speaker/token actualizado"
  if [ "$RESTART" = --restart ]; then
    ssh "$JARVIS_PI" 'sudo -n systemctl restart jarvis-speaker'
  fi
}

push_google() {
  local encoded
  encoded="$(kc_get GOOGLE_OAUTH_CLIENT_JSON_B64)" || { echo "· google: falta GOOGLE_OAUTH_CLIENT_JSON_B64, no se toca."; return; }
  printf '%s' "$encoded" | base64 -d | remote_write "$JARVIS_PI_MCP_DIR/google" oauth-client.json
  echo "✓ $JARVIS_PI_MCP_DIR/google/oauth-client.json actualizado"
}

case "$TARGET" in
  apollo) push_apollo ;;
  mcp) push_env_file mcp "$JARVIS_PI_MCP_DIR" ;;
  whatsapp) push_env_file whatsapp "$JARVIS_PI_WHATSAPP_DIR" ;;
  speaker) push_speaker ;;
  google) push_google ;;
  all)
    push_apollo
    push_env_file mcp "$JARVIS_PI_MCP_DIR"
    push_env_file whatsapp "$JARVIS_PI_WHATSAPP_DIR"
    push_speaker
    push_google
    ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
