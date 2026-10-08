# Lecciones y trampas

Lo que costó horas y conviene saber antes de tocar algo. Ordenado por dónde aparece.

## Firmware y placa

- **Flashear a 460800 baudios, no a 921600**: a 921600 el flasheo se corta.
- **Nada más puede tener el puerto serie abierto** al flashear. Un monitor serie corriendo dejó
  un flasheo con 1 de 5 particiones escritas y la pantalla negra (se arregla reflasheando
  completo; la placa no se daña). `lsof /dev/cu.usbmodem101` tiene que estar vacío.
- **Abrir el puerto serie reinicia la placa** (USB-CDC nativo: RTS/DTR la re-enumera y el handle
  abierto deja de recibir). Para observar un problema que aparece con horas, abrir el puerto una
  sola vez con un logger y dejarlo.
- **Borrar `sdkconfig` resetea el target a `esp32`** y la placa (que depende de
  `IDF_TARGET_ESP32S3`) desaparece del Kconfig con un error engañoso: "board does not define
  BOARD_DIR". `firmware/build.sh` pasa `-D IDF_TARGET=esp32s3` siempre.
- **`sdkconfig.defaults.esp32s3` se aplica DESPUÉS de `sdkconfig.defaults`**: un valor puesto en el
  primero pisa al del segundo (así el umbral del wake word quedaba en 50 sin que nadie lo viera).
- **El linker descarta clases que nadie instancia, sin error.** Pantalla blanca con la UI vieja y
  compilación limpia: alguien había pisado la línea que crea el tablero. `nm` no lo detecta (la
  vtable sigue); buscar un string de la clase con `strings build/xiaozhi.elf`. `build.sh` lo hace.
- **Editar siempre el overlay, nunca el árbol del firmware.** El árbol es una copia; el overlay es
  la fuente de verdad. `firmware/apply.sh` resetea el árbol a upstream antes de copiar.
- **Pantalla negra con la placa sana**: con `direct_mode` + `full_refresh`, LVGL solo dibuja lo
  invalidado y al salir de `SetupUI()` el layout flex todavía no se calculó (todo mide cero). Hace
  falta `lv_obj_update_layout()` + `lv_obj_invalidate()` al final. Está comentado en el código
  para que nadie lo borre "limpiando logs".
- **"Pantalla negra y no responde" era la pantalla dormida.** El touch la despertaba, pero al
  pasar a LVGL la tarea de gestos había quedado compilada adentro de un `#if` del motor de caras.
  Con la placa viva por serie y la pantalla apagada, sospechar del sueño antes que del dibujado.
- **Boot loops al reemplazar `SetupUI()`**: la clase base da por creados varios labels y los
  desreferencia sin chequear; y `Assets::Apply` libera la fuente anterior, así que un label con
  la fuente fijada en su estilo local queda apuntando a memoria liberada. Los labels heredan la
  fuente de la pantalla. Para cualquier pánico: `xtensa-esp32s3-elf-addr2line -pfiaC -e
  build/xiaozhi.elf <direcciones del backtrace>` da la línea exacta.
- **LVGL guarda el puntero al arreglo de imágenes del `animimg`, no una copia**: los descriptores
  tienen que vivir mientras exista la animación, y el vector se reserva antes de llenarlo (si se
  reubica, los punteros quedan colgando).
- **`process_extra_files` aplana por nombre**: los frames de la mascota se llaman
  `ein_<modo>_<n>.bin`, no `000.bin` en carpetas (máximo 32 caracteres). El `file(GLOB)` necesita
  `CONFIGURE_DEPENDS` o los frames nuevos no entran sin `idf.py reconfigure`.
- **El audio no se toca sin necesidad**: subir la ganancia y sacar el canal de referencia,
  juntos, dejaron el micrófono mudo (`Peak probability: 0/255`). Cuando algo andaba hace una
  hora, revertir los cambios propios gana a teorizar.
- **El wake word es "Hey Jarvis" en inglés**, la frase completa. El umbral quedó en 80 %: con el
  97 % del manifiesto, voces reales picaban en 233–242 de 255 y no disparaba.
- **Medir con la placa en el estado correcto**: en reposo el ping a la placa da 460 ms (ahorro de
  energía del WiFi); conversando, 200 ms. Casi se reporta un bug por medir en reposo.
- **Un repetidor WiFi en el medio** explica pérdida de paquetes y desconexiones largas. La placa
  reintenta sola; la Pi necesita `autoconnect-retries 0` y `wifi-guard.sh`.

## Servidor

- **`docker compose restart` NO relee el `env_file`.** El archivo decía Azure, el proceso seguía
  con Piper, y como nunca intentaba Azure no había error en el log. Usar `docker compose up -d`.
  Verificar el estado del **proceso** (`docker exec ... sh -lc 'echo $X'`), no del archivo.
- **`up --build` recrea el contenedor y `docker logs` arranca vacío.** Los logs también van a
  `/data/apollo.log`, que vive en el volumen.
- **Typechecks que mienten**: el contenedor no trae `tsc`, y un `grep -c "error TS"` sobre un
  `tsc` que no existe da 0 y parece un pase. Correr el typecheck en la Mac sobre el árbol armado
  (y sembrar un error a propósito si hay dudas). Correrlo en una Pi de 2 GB la reinició por RAM.
- **Una tool MCP se paga en cada turno.** Con 77 herramientas habilitadas los esquemas pesaban
  11 veces más que la conversación. Habilitar solo lo que se pide por voz; lo que te tiene que
  avisar a vos es un cron, no una herramienta.
- **`supergateway` en modo SSE muere con la segunda conexión** ("Already connected to a
  transport"). Usar `--outputTransport streamableHttp`, o el transporte HTTP nativo del servidor
  MCP si lo tiene (el de Calendar pasó de 13–18 s a 0,5 s por consulta).
- **El encoder del protocolo descarta en silencio las claves que no están en el esquema zod.**
  Por eso los tipos se derivan del esquema: un campo sin declarar es error de compilación.
- **"Optimizar" mandando solo cuando cambia rompió el tablero**: una placa que se reinicia
  nunca recibía el estado si nada había cambiado. Se manda siempre, cada 10 s.
- **La memoria de largo plazo guarda creencias viejas.** Jarvis decía que el calendario estaba
  caído sin consultarlo porque lo tenía en memoria de una caída anterior. Cuando un servicio
  vuelve, limpiar las memorias que dicen que está caído.
- **Contrastar el diagnóstico con la base antes de construir el arreglo**: se escribió un módulo
  para "rehabilitar herramientas que se deshabilitaban solas" y era un script que leía `enabled`
  en vez de `isEnabled`. Un `SELECT` de 10 segundos lo habría evitado.
- **No transformar literales de código a ciegas**: un regex para sacar emojis vació 11 strings
  `' '` legítimos. Los tests con strings exactos lo atraparon.
- **Avisos que suenan encima de la respuesta**: un recordatorio que vence mientras hablás se
  posterga; si no, dos audios juntos trababan la placa.
- **`tar`/`rsync` desde macOS meten archivos `._*`** que `bun test` intenta correr:
  `COPYFILE_DISABLE=1`.

## Latencia (dónde se va el tiempo)

Medido por etapa con `apollo_turn_timings`, en este orden de impacto:

1. **El LLM razonando cuando no hacía falta** (+2 s por ronda). Lo resolvió el router.
2. **Rondas de herramientas**: cada una cuesta 2–5 s. Una herramienta que trae el dato antes
   (el dólar) ahorra una ronda entera.
3. **Largo de la respuesta**: cada carácter se paga en síntesis. Por eso 1–2 oraciones.
4. **Piper recargando el modelo en cada respuesta** (60 % del tiempo de voz). Proceso persistente.
5. **Búsqueda web**: 5–20 s; sin el texto completo de las páginas el contexto bajó 11x.

Lo que **no** era el problema, medido: la red de la Pi (29 ms a las APIs), la CPU de la Pi
(ociosa), el STT (`whisper-large-v3-turbo` es el más rápido de los probados) y el tamaño de los
resultados de las herramientas (1 KB).

## Operación de la Pi

- **Fuente de 5 V / 3 A**: con un cargador de celular, `vcgencmd get_throttled` da `0x50005` y la
  CPU baja a 600 MHz.
- **La tarjeta SD se llena** (WAHA sincronizó el historial de WhatsApp a un WAL de 2,2 GB y un
  deploy quedó a medias): `df` antes de deployar y `disk-guard.sh` por cron.
- **WAHA**: usar el motor GOWS; con NOWEB los mensajes quedaban en ack 0 sin salir nunca.
- **Los avisos a tu propio chat de WhatsApp llegan sin notificación** (WhatsApp no avisa mensajes
  de tu propia cuenta). Si necesitás que suene, Telegram o ntfy.
- **La IP de la Pi cambia si es DHCP**, y la placa la tiene compilada: reservarla en el router.
- **ALSA dmix se cuelga** en la salida de auriculares de la Pi 4 con kernels recientes: por eso
  el parlante tiene su propio mezclador (`infra/speaker/`) y no hay `/etc/asound.conf`.
- **Google Calendar en modo "Testing" vence el token a los 7 días**. Publicar la app (sin logo,
  para no disparar la verificación).
