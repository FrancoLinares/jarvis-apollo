# Customizaciones sobre Apollo

Todo lo que este repo le agrega o cambia a Apollo y a su firmware, agrupado por lo que se nota
al usarlo. Cada punto dice dónde vive el código (rutas relativas a `server/overlay/apps/agent/src/`
o a `firmware/overlay/`) y por qué se hizo así, que suele ser lo más útil.

---

## Avisos que te buscan a vos

### "¿A qué hora tengo que salir?" — `travel/departure.ts`, `tools/travel.ts`

Decís "voy al dentista a las 3" o "a las 8 juego al fútbol en tal lugar" y Jarvis te avisa
**7 minutos antes de la hora en que tenés que salir** para llegar a tiempo.

- **Tráfico a la hora de salida, no el de ahora.** El MCP de Google Maps no acepta hora de
  salida (devuelve un tiempo típico), así que se llama a la Distance Matrix por REST con
  `departure_time`, que sí devuelve `duration_in_traffic`. Decidir a las 10 de la mañana cuánto
  tardás a las 18 sin modelar tráfico da un número inútil.
- **Dos fases, porque el tráfico envejece.** Si falta más de una hora, no se fija el aviso: se
  programa un recálculo para una hora antes de salir, que recién ahí programa el aviso. Mismo
  patrón en todo el proyecto: *el schedule no dispara el aviso, dispara un cálculo*.
- **El caso implícito es el importante.** Medido con el router: "avisame cuándo tengo que
  salir" va a la intención `viaje`, pero "voy a ir al dentista a las tres" cae en `agenda_crear`
  (0,66) y "a las 8 juego al fútbol" también (0,82). Por eso la herramienta está en las dos
  intenciones. *Agregar una herramienta a una intención no alcanza: hay que medir a qué
  intención va la frase real.*
- El origen es `IDLE_TRAVEL_ORIGIN` (tu dirección, en el Llavero). Interruptor:
  `DEPARTURE_ALERTS=off`.

### Recordatorios que no se pierden — `reminders/`, `tools/reminder.ts`, `host/actor.ts`

- **Hasta 60 días** (Apollo los limitaba a 24 h: "el 7 avisame una semana antes" se rechazaba o
  quedaba para mañana).
- **Recurrentes de verdad** (`set_recurring_reminder`): "todos los días a las 19:30",
  "lunes a viernes", "todos los 5 del mes a las 10". Es un cron, no N recordatorios sueltos:
  el modelo decía "listo, todos los días" y programaba solo el primero. No crea duplicados.
- **Alarma y pantalla completa** (`reminders/alarm.ts`) para que se note desde lejos.
- **No te hablan encima** (`reminders/defer.ts`): si el aviso cae mientras estás conversando,
  se posterga de a 10 s hasta que termine el turno (con tope de 2 min).
- **Por WhatsApp si no llegó** (`reminders/whatsapp-relay.ts`): si la placa está desconectada
  cuando suena, o sonó y en 10 minutos nadie la tocó ni le habló, el aviso te llega por
  WhatsApp.

### Vencimientos por mail — `billing/`

Cada mañana y cada tarde lee Gmail por IMAP (contraseña de aplicación) **solo los mails cuyo
asunto** habla de vencer, renovar o deuda; el resto del buzón no sale de Google ni pasa por el
LLM. Cada mail pasa por el LLM, que devuelve concepto, fecha y monto; avisa el día anterior a
las 10 y el mismo día a las 9. Las intimaciones recientes se avisan en el momento.
`BILLING_SKIP_CONCEPTS` evita duplicar lo que ya tiene un recordatorio fijo.

### Opcionales (apagados por defecto)

- **Partidos de tu equipo** (`sports/fixtures.ts`): scoreboard público de ESPN (sin key),
  mirando solo las próximas 26 h porque en el fútbol argentino los partidos se reprograman
  todo el tiempo. `FOOTBALL_TEAM=Racing Club`.
- **Seguimiento de una web sin API** (`events/watch.ts`, `sports/padel.ts`): torneos nuevos de
  Premier Padel leyendo el HTML del calendario oficial. Sirve de molde para seguir cualquier
  página.

---

## Conversación

### Persona Jarvis — `persona/soul.ts`, `persona/characters.ts`, `persona/mood.ts`

- Rioplatense ("vos", nunca "tú"), cordial con ingenio seco, y **respuestas de 1 o 2
  oraciones**. No es estilo: es latencia. Cada carácter de más se paga en síntesis de voz.
- **Personajes por tono**: Jev elige en la misma llamada si la frase pide `sarcastico`
  ("¿el agua moja?"), `relator` (un gol de tu equipo), `mayordomo` ("buenas noches") o
  `normal`. Nunca hay personaje si es una queja. `PERSONAJES=off` lo apaga.
- **Cara según el tono**: el LLM cierra con `[[cara:festejo|triste|apurado|pensativo]]` y la
  mascota de la pantalla reacciona.
- **Modo conversación** (`turn/run.ts`): el micrófono se reabre después de cada respuesta para
  seguir sin repetir "Hey Jarvis", y se cierra solo a los ~3 s de silencio.
- **Agenda = calendario + recordatorios**: al preguntar "¿qué tengo hoy?" mira las dos fuentes.
  "Agendá una reunión" va a Google Calendar; "recordame" va a un recordatorio interno.

### Router de intenciones con Jev — `router/`

El cambio más grande del lado del servidor. Antes del LLM, una sola llamada a
`typesafe/jev-1.13` (por OpenRouter, ~USD 0,000014 por turno, en paralelo con la memoria) da
probabilidades para: intención, ruido, queja, razonamiento y personaje. Con eso el turno decide
qué herramientas ve el modelo (ver la tabla de niveles en
[arquitectura.md](arquitectura.md#un-turno-de-punta-a-punta)).

- **Aprende solo** (`router/learn.ts`, 04:00): etiqueta cada turno sin preguntarte nada (las
  herramientas que terminó usando el LLM dicen la intención real; usar el escape = error del
  router; quejarse del mismo tema en los 3 minutos siguientes = error), ajusta los umbrales de
  cada intención (atajo si acierta ≥ 90 %, sin LLM de por medio si ≥ 97 %), y entrena un
  **clasificador local** sobre los embeddings (`router/head.ts`) que reemplaza a Jev cuando
  demuestra ≥ 97 % de acierto en turnos que no vio.
- **Razonar solo cuando hace falta**: el LLM razonaba por defecto (+2 s por ronda). Jev decide
  si hay que encadenar pasos, calcular fechas o hacer cuentas; si no, `reasoning` apagado. Un
  A/B (`ROUTER_REASONING_EXPLORE=0.2`) invierte la decisión en el 20 % de los turnos y cada
  noche mueve el umbral según los errores medidos.
- **Dónde ganó de verdad**: el dólar pasó de 9,5 s a 3 s (una ronda en vez de dos), el ruido
  de Whisper se descarta sin gastar un turno, y "leeme los pendientes" usa la lista real en vez
  de la memoria vieja.
- Modo `shadow` para medir sin aplicar; `ROUTER_MODE=off` lo apaga.

### "No confirmes lo que no hiciste" — `turn/claims.ts`

El modelo a veces decía "listo, te aviso mañana" sin haber programado nada, o "esta semana no
tenés nada" sin mirar el calendario. Si el pedido es de acción y no hubo herramienta, o es de
datos y no hubo consulta, la respuesta no se dice: se agrega una nota de sistema y la ronda
siguiente va con `tool_choice: 'required'`. Una pregunta de aclaración no lo dispara.

### Mensajes a otras personas — `tools/message.ts`

"Decile a Ana que llego a las 9" → WhatsApp, aunque no digas "WhatsApp". Dos candados **en
código, no en el prompt**:

1. **Lista cerrada** (`WHATSAPP_CONTACTS`, en el Llavero). Un nombre que no está no se resuelve
   contra ninguna agenda.
2. **Confirmación por voz**: `mandar_mensaje` solo arma un borrador y la frase que se dice la
   impone la herramienta (`Para Ana: "Llego a las 9". ¿Se lo mando?`), no el modelo. El envío lo
   hace `confirmar_mensaje`, que exige que tu frase del turno *inmediato siguiente* sea un "sí"
   claro (sin "no", "esperá", "cambiá"). Cualquier otro turno descarta el borrador; vence a los
   3 minutos. El modelo no puede confirmar por su cuenta.

Y `whatsapp/client.ts` espera el ack del servidor de WhatsApp antes de decir "enviado": WAHA
llegó a aceptar mensajes que nunca salieron.

### Voz — `voice/`

- **Azure Speech** (`voice/azure.ts`) con `es-AR-TomasNeural`: 4,3x más rápido que Piper en la
  Pi y en el formato exacto de la placa (sin remuestrear). El texto se escapa en el SSML (un `&`
  en la respuesta dejaba a Jarvis mudo).
- **Piper** (`voice/piper.ts`) como proceso persistente: recargar el modelo ONNX de 63 MB en cada
  respuesta era el 60 % del tiempo de voz. Remuestrea 22050 → 24000 Hz.
- **Selector con red de seguridad** (`voice/synthesize.ts`): `TTS_PROVIDER=azure|piper|elevenlabs`;
  Azure sin key o con error cae a Piper. Hay tests que fijan las cuatro rutas.
- **Filtro de alucinaciones de Whisper** (`voice/silence.ts`) y STT que devuelve vacío en vez
  de error ante silencio (antes la pantalla decía "No pude procesar ese pedido").

---

## Pantalla

### Tablero LVGL — `main/display/jarvis_dashboard_display.cc`, `dashboard/`

La idea de Apollo es una cara a pantalla completa. Acá la pantalla es un **dashboard** con la
mascota en una esquina: hora, clima, agenda del día (calendario + recordatorios mezclados por
hora), pendientes de la lista, tiempo de viaje con tráfico, y el estado del turno.

- El servidor arma y **recorta** el contenido (`dashboard/payload.ts`) y lo manda **cada 10 s
  aunque no haya cambiado**: mandarlo solo al cambiar dejaba la pantalla vacía después de cada
  reinicio de la placa.
- Las filas se crean una sola vez y solo cambia el texto (recrearlas hacía parpadear todo).
- `DashboardPayload` se **deriva** del esquema zod del protocolo: el encoder descarta en silencio
  cualquier clave que no esté en el esquema, así que un campo nuevo sin declarar ahora es un
  error de compilación.

### Einstein — `main/assets/einstein/`, `tools/convert-einstein.sh`

Sprite pixel art con 9 animaciones (57 frames, 150×163 RGB565A8) que vive en la partición de
assets y se lee **directo de flash**, sin copiarlo a RAM. Escucha (Waiting), piensa (Review),
habla (Waving), festeja (Jumping), se pone triste (Failed) o se apura (Running) según el tono
de la respuesta; en reposo parpadea al azar, hace un gesto cada tanto y cada 4–8 minutos sale
corriendo por un costado y entra por el otro.

### Lo que se ve durante un turno — `turn/caption.ts`, `turn/streaming.ts`

1. Lo que escuchó, entre comillas (si el STT entendió mal, se ve al instante).
2. Un cartel por herramienta ("Calculando el viaje…") con un color por familia.
3. El texto del modelo escribiéndose en vivo, y después la frase que está diciendo.

La fuente de la placa no tiene emojis: los carteles son texto y la diferencia visual la hace el
color del anillo.

### Port a la Waveshare 4.3" — `main/boards/waveshare/esp32-s3-touch-lcd-4.3c/`

Apollo solo soportaba una pantalla redonda de 1,85". El board se tomó de xiaozhi-esp32 y se le
aplicó el mismo delta que Apollo le aplica a la suya: panel **RGB paralelo** (sin `panel_io`:
el dibujado es sincrónico), touch **GT911** en vez de CST816S, `bits_per_pixel` en vez de
`in_color_format` (ESP-IDF 5.5.2), layout 800×480 y reloj de píxel a 16 MHz (a 21 MHz la PSRAM
no daba abasto con `full_refresh` y parpadeaba).

---

## Integraciones

- **Notion** (`notion/`): la base de Notion es un espejo editable de las listas. El SQLite de la
  Pi sigue siendo la fuente de verdad; la reconciliación es completa e idempotente cada 60 s
  (alta en cualquier lado, vincular en vez de duplicar, tildar "Hecho" borra, editar en Notion
  gana). Por REST con token de integración interna porque el MCP alojado de Notion exige un
  redirect HTTPS que una LAN no tiene.
- **Búsqueda web** (`search/tavily.ts`): 3 resultados y sin el texto completo de las páginas
  (la respuesta pasó de 54 mil a 4,7 mil caracteres de contexto).
- **Parlante externo y Spotify** (`speaker/output.ts`, `tools/speaker.ts`, `infra/speaker/`):
  modos `avisos` (solo avisos al parlante), `todo` o `apagado`, cambiables por voz. La placa
  recibe silencio del mismo largo para que su estado no cambie. La música baja al 18 % desde
  "Hey Jarvis" hasta el final del turno: la cancelación de eco de la placa no conoce el audio de
  la Pi.

---

## Operación

- **Costos** (`costs/ledger.ts`): cada llamada a OpenRouter guarda su `usage.cost` exacto en
  `api_costs`. Más un tracker horario del consumo de la key (`infra/costs/cost-tracker.py`).
- **Latencia medida por etapa** (`turn/run.ts`): `apollo_turn_timings` con STT, memoria,
  router, cada llamada al LLM, cada herramienta por nombre, TTS, y un `sin_medir` que si crece
  avisa que hay una etapa sin instrumentar.
- **Firmware por WiFi** (`ota/routes.ts`, `infra/publish-firmware.sh`): verifica que la versión
  grabada en el binario sea la anunciada (si no, la placa se reinstalaría en cada arranque),
  lo sube al almacén de Apollo y opcionalmente le pide a la placa que se reinicie.
- **Informe de arranque** (`protocol/schema.ts`, `main/application.cc`): motivo del último
  reinicio, nota del guardián y resumen del coredump, logueado en el servidor.
- **Guardianes de la Pi** (`infra/system/`): `disk-guard.sh` libera caché de Docker/apt/journal
  si el disco pasa el 90 % (una SD llena dejó un deploy a medias), `wifi-guard.sh` reconecta si
  la Pi pierde el router.
