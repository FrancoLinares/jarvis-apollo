#!/usr/bin/env bash
# Convierte el sprite de PicoPixel a imagenes LVGL para la placa.
#
# El .picopixel es un ZIP: los PNG viven en objects/<blob>.png y el orden de los
# frames esta en files/*/lvgl-widgets.json. El join entre un frame y su blob es
# por NOMBRE de archivo (idle_000.png), NO por los ids, que son de otra cosa.
#
# Salida: RGB565A8 sin comprimir. Sin comprimir se lee directo de flash con cero
# costo de RAM; comprimido obligaria a LV_BIN_DECODER_RAM_LOAD y a descomprimir
# cada frame en PSRAM.
set -euo pipefail
#
# Los frames quedan con nombre plano, ein_<modo>_<n>.bin, porque el empaquetador
# de assets aplana por nombre de archivo (máximo 32 caracteres).
#
#   tools/convert-einstein.sh "Einstein Sprite.picopixel"
#   PY=python-con-Pillow FIRMWARE=~/esp/jarvis-apollo-firmware tools/convert-einstein.sh ...
SRC="${1:?uso: convert-einstein.sh <Sprite.picopixel> [destino]}"
DST="${2:-firmware/overlay/main/assets/einstein}"
FIRMWARE="${FIRMWARE:-$HOME/esp/jarvis-apollo-firmware}"   # trae scripts/Image_Converter/LVGLImage.py
PY="${PY:-python3}"                                          # necesita Pillow
WIDTH=150; HEIGHT=163
MODES="idle waiting review waving jumping failed running run-right run-left"   # estados + reacciones y paseos (2026-10-01)

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
unzip -o -q "$SRC" -d "$WORK"

"$PY" - "$WORK" "$WIDTH" "$HEIGHT" <<'PYEOF'
import json, glob, os, sys, re
from PIL import Image
work, w, h = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
base = glob.glob(os.path.join(work, 'files', '*/'))[0]
blob_by_name = {}
for p in glob.glob(base + 'media/*.json'):
    m = json.load(open(p)); blob_by_name[m['name']] = m['mediaId']
root = list(json.load(open(base + 'lvgl-widgets.json')).values())[0]
modes = []
def walk(n):
    if isinstance(n, dict):
        if 'frames' in n and 'duration' in n and isinstance(n.get('name'), str): modes.append(n)
        for v in n.values():
            if isinstance(v, (dict, list)): walk(v)
    elif isinstance(n, list):
        for i in n: walk(i)
walk(root)
manifest = []
for mode in modes:
    slug = re.sub(r'[^a-z0-9]+', '-', mode['name'].lower()).strip('-')
    out = os.path.join(work, 'scaled', slug); os.makedirs(out, exist_ok=True)
    for i, fr in enumerate(mode['frames']):
        blob = blob_by_name.get(fr.get('name'))
        src = os.path.join(work, 'objects', f'{blob}.png') if blob else None
        if not (src and os.path.exists(src)):
            raise SystemExit(f'falta el blob de {mode["name"]}[{i}] ({fr.get("name")})')
        Image.open(src).convert('RGBA').resize((w, h), Image.LANCZOS).save(f'{out}/{i:03d}.png')
    manifest.append({'name': mode['name'], 'slug': slug,
                     'frames': len(mode['frames']), 'durationMs': mode.get('duration')})
json.dump(manifest, open(os.path.join(work, 'modes.json'), 'w'), indent=2, ensure_ascii=False)
print(f'  escalados {sum(m["frames"] for m in manifest)} frames a {w}x{h}')
PYEOF

# Nombre corto de cada modo en el firmware (jarvis_dashboard_display.cc los busca así).
short_name() {
  case "$1" in
    idle) echo idle ;; waiting) echo wait ;; review) echo think ;; waving) echo talk ;;
    jumping) echo jump ;; failed) echo fail ;; running) echo run ;;
    run-right) echo runr ;; run-left) echo runl ;;
  esac
}

mkdir -p "$DST"
rm -f "$DST"/ein_*.bin
for mode in $MODES; do
  short="$(short_name "$mode")"
  mkdir -p "$WORK/bin/$mode"
  for f in $(find "$WORK/scaled/$mode" -name '*.png' | sort); do
    "$PY" "$FIRMWARE/scripts/Image_Converter/LVGLImage.py" \
      --ofmt BIN --cf RGB565A8 -o "$WORK/bin/$mode" "$f" >/dev/null
  done
  index=0
  for f in $(find "$WORK/bin/$mode" -name '*.bin' | sort); do
    cp "$f" "$DST/ein_${short}_${index}.bin"
    index=$((index + 1))
  done
  echo "  $mode -> ein_${short}_*: $index frames"
done
echo "  duraciones por modo (ms), para el firmware:"
"$PY" -c 'import json,sys; [print("   ", m["slug"] + ":", m["durationMs"]) for m in json.load(open(sys.argv[1]))]' "$WORK/modes.json"
echo "  total: $(find "$DST" -name 'ein_*.bin' -exec ls -la {} \; | awk '{t+=$5} END {printf "%.0f", t/1024}') KB en $DST"
