# Secretos y datos privados

**Regla:** ningún secreto vive en un archivo del repo ni en un archivo de la Mac, y ninguno
viaja como argumento de un comando (quedaría en el historial del shell y visible en `ps`).
Los secretos viven en el **Llavero de macOS**; los scripts los leen a memoria y los mandan por
stdin a donde tengan que ir.

Esto incluye los datos personales que no son contraseñas pero no deberían terminar en un
repo: tu dirección (origen de los viajes), tu número y los de tus contactos de WhatsApp, tu
mail.

## Cómo está armado

```
secrets.manifest          qué secretos existen y a qué destino va cada uno (sin valores, se commitea)
jarvis.env                dónde está la Pi y la URL del servidor (no secreto, NO se commitea)
server/config.env         modelos e interruptores de Apollo (no secreto, NO se commitea)

Llavero de macOS          servicio "jarvis", cuenta = NOMBRE de la variable
   │
   ├─ scripts/push-secrets.sh ──ssh/stdin──▶ Pi: ~/apollo-server/.dev.vars       (600)
   │                                          ~/mcp-servers/.env                  (600)
   │                                          ~/mcp-servers/google/oauth-client.json (600)
   │                                          ~/whatsapp/.env                     (600)
   │                                          /etc/jarvis-speaker/token           (640 root:tu-grupo)
   ├─ firmware/build.sh ──archivo temporal 600, borrado al terminar──▶ binario de la placa
   └─ tools/desk-simulator.ts ──security──▶ memoria del proceso
```

## Uso

```bash
scripts/secrets.sh status                         # qué hay y qué falta (nunca muestra valores)
scripts/secrets.sh generate DEVICE_SHARED_SECRET  # aleatorio, 48 hex
scripts/secrets.sh set OPENROUTER_API_KEY         # lo pide oculto, dos veces
scripts/secrets.sh set IDLE_TRAVEL_ORIGIN         # acepta espacios y comas: "Calle Falsa 123, CABA"
scripts/secrets.sh set-file GOOGLE_OAUTH_CLIENT_JSON_B64 client_secret.json   # después borrá el archivo
scripts/push-secrets.sh all --restart             # sube todo y recrea los contenedores
```

Para verlos o editarlos a mano: **Acceso a Llaveros** → buscar `jarvis.`.

Un secreto nuevo se agrega primero a `secrets.manifest` (nombre, destinos, si es requerido);
`secrets.sh` rechaza nombres que no estén ahí, y `push-secrets.sh` rechaza un `server/config.env`
que contenga un nombre del manifiesto (así nadie "resuelve" un apuro pegando la key ahí).

## Detalles que importan

- **`security add-generic-password -w` sin valor** pide el secreto de forma oculta: es la única
  forma de cargar un valor con espacios sin que pase por argv. Los generados y los archivos
  (base64, sin espacios) se le pasan a `security -i` **por stdin**.
- **`.dev.vars` sin comillas cuando no hacen falta**: así `grep ^X= | cut -d= -f2-` sigue
  funcionando en la Pi. Con espacios o símbolos van entre comillas simples, que docker compose
  toma literal (un `$` en una contraseña no se interpola).
- **El firmware lleva el secreto adentro.** La placa lo necesita para conectarse, así que el
  `.bin`, el `sdkconfig` y la carpeta `build/` del árbol del firmware lo contienen. No compartas
  un binario compilado ni ese árbol; compartí el repo y que cada uno compile con su secreto.
  `sdkconfig.defaults` (que sí se commitea) tiene la URL y el token vacíos a propósito.
- **Cada `firmware/build.sh` recompila todo** (~5 min en una Mac M): borra el `sdkconfig` para
  que los defaults y el secreto se apliquen de nuevo. Para iterar sobre el código del firmware,
  después del primer `build.sh` alcanza con `idf.py build` (o `idf.py -p PUERTO -b 460800 flash`)
  dentro del árbol, que es incremental.
- **Rotar un secreto**: `secrets.sh generate NOMBRE` + `push-secrets.sh all --restart`. Si es
  `DEVICE_SHARED_SECRET`, además recompilar y flashear la placa (o publicar por OTA *antes* de
  rotar, porque con el secreto nuevo la placa vieja ya no conecta).
- **En la Pi** los archivos quedan con permisos 600 y el puerto de WAHA y de los MCP solo escucha
  en `127.0.0.1` o en la red interna de Docker. Expuestos a la LAN quedan Apollo (8799) y el
  parlante (8790, tiene que escuchar fuera de loopback para que el contenedor lo alcance), y los
  dos exigen su token en cada pedido.

## Antes de commitear

```bash
git config core.hooksPath .githooks       # una vez: el hook corre el chequeo en cada commit
python3 -I scripts/check-leaks.py         # todo el repo, a mano
```

`check-leaks.py` busca **los valores reales** de tus secretos (los lee del Llavero, sin
imprimirlos) en cada archivo, más patrones de keys conocidas (OpenRouter, Google, Notion,
GitHub, claves privadas, `TOKEN="..."`). También puede comparar contra lo que hay en la Pi:

```bash
source jarvis.env
ssh "$JARVIS_PI" 'cat apollo-server/.dev.vars mcp-servers/.env whatsapp/.env 2>/dev/null' \
  | python3 -I scripts/check-leaks.py --env-from-stdin
```
