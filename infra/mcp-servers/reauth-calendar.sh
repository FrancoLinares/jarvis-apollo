#!/usr/bin/env bash
# Re-autentica el MCP de Google Calendar desde la Pi, que no tiene pantalla.
#
# Se corre DESDE LA MAC, con un tunel que lleva el callback de Google hasta aca:
#
#   ssh -t -L 3500:127.0.0.1:3500 usuario@ip-de-la-pi 'bash ~/mcp-servers/reauth-calendar.sh'
#
# (el oauth-client.json lo sube scripts/push-secrets.sh google desde el Llavero)
#
# Por que asi: el cliente OAuth es de tipo "Desktop app", y Google redirige al
# terminar a http://localhost:3500/oauth2callback. Ese "localhost" es el de la
# Mac, donde esta el navegador; el tunel lo reenvia al puerto 3500 de la Pi.
#
# Por que --network host: el servidor de callback de @cocal/google-calendar-mcp
# escucha en 127.0.0.1. Dentro de un contenedor con red propia ese 127.0.0.1 es
# el del contenedor, y ni un `-p 3500:3500` ni el tunel llegarian.
#
# OJO: si la app OAuth sigue en modo "Testing", el token nuevo TAMBIEN vence a
# los 7 dias. Publicarla primero (consent screen -> In production).
set -euo pipefail

TTY_FLAG=-i
if [ -t 1 ]; then TTY_FLAG=-it; fi

echo
echo "=================================================================="
echo " 1. Abri en el navegador de la Mac la URL de Google que sale abajo"
echo " 2. Elegi tu cuenta y acepta los permisos de Calendar"
echo "    (si dice 'Google no verifico esta app': Avanzado -> Ir a ...)"
echo " 3. Cuando el navegador diga que termino, volve aca"
echo "=================================================================="
echo

docker run --rm $TTY_FLAG --network host \
  -v mcp-servers_mcp-npm-cache:/root/.npm \
  -v "$HOME/mcp-servers/google/oauth-client.json:/creds/oauth-client.json:ro" \
  -v "$HOME/mcp-servers/google/tokens:/tokens" \
  -e GOOGLE_OAUTH_CREDENTIALS=/creds/oauth-client.json \
  -e GOOGLE_CALENDAR_MCP_TOKEN_PATH=/tokens/tokens.json \
  node:22-alpine npx -y @cocal/google-calendar-mcp auth

echo
echo "Reiniciando calendar-mcp para que tome el token nuevo..."
docker restart calendar-mcp >/dev/null

# Verificacion real: se le pide a Google que renueve el token. Es la misma
# prueba que diagnostico la falla ("invalid_grant"), asi que si esto da OK el
# problema esta resuelto de verdad. No imprime ningun secreto.
echo "Verificando contra Google..."
docker exec -i calendar-mcp node - <<'JS'
const fs = require("fs");
const tokens = JSON.parse(fs.readFileSync("/tokens/tokens.json", "utf8"));
const client = JSON.parse(fs.readFileSync("/creds/oauth-client.json", "utf8"));
const c = client.installed ?? client.web;
(async () => {
  for (const [cuenta, t] of Object.entries(tokens)) {
    const body = new URLSearchParams({
      client_id: c.client_id, client_secret: c.client_secret,
      refresh_token: t.refresh_token, grant_type: "refresh_token",
    });
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
    const j = await r.json();
    console.log(j.error
      ? `  ✗ cuenta "${cuenta}": ${j.error} — ${j.error_description}`
      : `  ✓ cuenta "${cuenta}": Google acepta el token. Calendar funciona.`);
  }
})();
JS
