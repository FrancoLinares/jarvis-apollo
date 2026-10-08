# Copia local de 78/esp-ml307 (3.6.6)

Se usa vía `override_path` en `main/idf_component.yml`. Cambios respecto del original, todos en
`src/esp/esp_tcp.cc` (2026-09-30):

- `connect()` con tiempo máximo de 5 s (no bloqueante + select).
- `SO_SNDTIMEO` de 3 s; si un envío vence, `shutdown()` del socket para que se cierre la conexión y la
  aplicación reconecte.
- Keepalive TCP (10 s idle, 5 s intervalo, 3 intentos) y `TCP_NODELAY`.

Motivo: el original bloqueaba sin límite desde el loop principal y la placa quedaba muda con el WiFi
del repetidor lento.
