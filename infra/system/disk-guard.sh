#!/usr/bin/env bash
# Guardián de disco de la Pi de Jarvis (cron cada 30 min, root).
#
# El 2026-10-05 la tarjeta llegó al 100 %: el diario de la base de WAHA/GOWS
# (gows.db-wal) creció a 2,2 GB al sincronizar el historial al vincular, encima
# de ~500 MB de caché de builds de Apollo. Con el disco lleno, Apollo no puede
# escribir sus recordatorios en SQLite y un deploy deja archivos a medias.
#
# Si el uso pasa UMBRAL, borra solo cosas regenerables: caché de builds de
# Docker, caché de apt y journal viejo. No toca imágenes, volúmenes ni datos.
set -u
UMBRAL=90
uso() { df --output=pcent / | tail -1 | tr -dc '0-9'; }
antes=$(uso)
if [ "$antes" -lt "$UMBRAL" ]; then
  exit 0
fi
docker builder prune -af >/dev/null 2>&1
apt-get clean
journalctl --vacuum-size=50M >/dev/null 2>&1
despues=$(uso)
logger -t disk-guard "disco ${antes}% -> ${despues}% (umbral ${UMBRAL}%)"
if [ "$despues" -ge "$UMBRAL" ]; then
  logger -p user.warning -t disk-guard "sigue arriba del ${UMBRAL}%: revisar volúmenes (du -sh /var/lib/docker/volumes/*)"
fi
