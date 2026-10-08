# Infraestructura de la Pi

Todo lo que corre en la Raspberry Pi además del contenedor de Apollo. Los comandos asumen
`source jarvis.env` (para `$JARVIS_PI`) y se corren desde la raíz del repo, en la Mac.

## Servidores MCP — `mcp-servers/`

Maps, Calendar y Notion, cada uno en su contenedor en la red `jarvis-mcp`. Paso a paso en
[docs/arquitectura.md](../docs/arquitectura.md#servidores-mcp).

## WhatsApp — `whatsapp/`

[WAHA](https://waha.devlike.pro) con el motor GOWS (sin Chromium: entra en 2 GB). Se vincula
como un dispositivo más de tu cuenta, igual que WhatsApp Web.

```bash
scripts/secrets.sh generate WAHA_API_KEY
scripts/secrets.sh generate WAHA_DASHBOARD_PASSWORD
scripts/secrets.sh set WHATSAPP_TO                 # tu número: 5491100000000
scp -r infra/whatsapp "$JARVIS_PI:"
scripts/push-secrets.sh whatsapp && scripts/push-secrets.sh apollo --restart
ssh "$JARVIS_PI" 'cd whatsapp && docker compose up -d'

# El panel solo escucha en 127.0.0.1 de la Pi: se abre por un túnel.
ssh -L 3000:127.0.0.1:3000 "$JARVIS_PI"
# → http://localhost:3000/dashboard  (usuario "jarvis", contraseña: WAHA_DASHBOARD_PASSWORD
#   del Llavero), sesión "default", escanear el QR desde WhatsApp → Dispositivos vinculados.
```

Para mensajes a otras personas, `scripts/secrets.sh set WHATSAPP_CONTACTS` con
`Nombre=549...,Otro=549...`. Solo esos nombres son alcanzables, y cada envío pide un "sí" por voz.

## Parlante externo + Spotify — `speaker/`

Ver [speaker/README.md](speaker/README.md).

## Guardianes — `system/`

```bash
scp infra/system/*.sh "$JARVIS_PI:/tmp/"
ssh "$JARVIS_PI" 'sudo install -m 0755 /tmp/disk-guard.sh /tmp/wifi-guard.sh /usr/local/sbin/ &&
  echo "*/30 * * * * root /usr/local/sbin/disk-guard.sh" | sudo tee /etc/cron.d/disk-guard &&
  echo "*/2 * * * * root /usr/local/sbin/wifi-guard.sh" | sudo tee /etc/cron.d/wifi-guard'
```

- `disk-guard.sh`: si `/` pasa el 90 %, borra caché de builds de Docker, de apt y journal viejo.
  No toca imágenes, volúmenes ni datos.
- `wifi-guard.sh`: si la Pi no llega al router, levanta de nuevo la conexión WiFi (o apaga y
  prende la radio). Sumale `nmcli connection modify "<tu red>" connection.autoconnect-retries 0`.

## Costos — `costs/`

- `cost-tracker.py`: snapshot horario del gasto de la key de OpenRouter (lee la key del
  `.dev.vars` de la Pi). Cron: `17 * * * * ~/jarvis-costs/cost-tracker.py snapshot`.
  `cost-tracker.py report` da el gasto mes a mes.

## Firmware por WiFi — `publish-firmware.sh`

```bash
infra/publish-firmware.sh ~/esp/jarvis-apollo-firmware/build/xiaozhi.bin 2.7.4 "qué cambia" --apply
```

La versión del binario (`PROJECT_VER` en el `CMakeLists.txt` raíz del firmware) tiene que ser
la que se anuncia. La placa la baja al arrancar; si no queda 60 s conectada, vuelve sola a la
anterior.

## Páginas para la app OAuth de Google — `oauth-pages/`

Google exige una página de inicio y una de privacidad para publicar la app (sin publicar, el
token de Calendar vence a los 7 días). `GITHUB_USER=tu-usuario GOOGLE_CLOUD_PROJECT=tu-proyecto
bash infra/oauth-pages/publicar.sh` las sube a GitHub Pages con tu usuario.
