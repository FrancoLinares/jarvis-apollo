#!/usr/bin/env python3
"""Seguimiento de gasto mensual de Jarvis.

Toma snapshots del consumo de cada proveedor y los guarda en SQLite, para poder
responder "cuánto me salió este mes" sin depender de los paneles web.

Uso:
    cost-tracker.py snapshot     # graba el estado actual (lo corre el cron)
    cost-tracker.py report       # resumen mes a mes
    cost-tracker.py report --json
"""

import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HOME = Path(os.environ.get("JARVIS_COSTS_HOME", Path.home() / "jarvis-costs"))
DATABASE = HOME / "costs.db"
ENVIRONMENT_FILE = Path(
    os.environ.get("JARVIS_ENV_FILE", Path.home() / "apollo-server" / ".dev.vars")
)
TIMEOUT_SECONDS = 20


def read_environment_file(path):
    """Lee un archivo tipo .env sin depender de librerías externas."""
    values = {}
    if not path.exists():
        return values
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        values[name.strip()] = value.strip()
    return values


def connect():
    HOME.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE)
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS usage_snapshot (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            captured_at  TEXT NOT NULL,
            provider     TEXT NOT NULL,
            -- Gasto acumulado histórico en USD, tal como lo reporta el proveedor.
            total_usage  REAL,
            -- Ventanas que el proveedor ya calcula, cuando las expone.
            usage_daily  REAL,
            usage_monthly REAL,
            credits      REAL,
            raw          TEXT
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_snapshot_provider_time "
        "ON usage_snapshot(provider, captured_at)"
    )
    connection.commit()
    return connection


def fetch_json(url, token):
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return json.load(response)


def collect_openrouter(token):
    key_info = fetch_json("https://openrouter.ai/api/v1/key", token).get("data", {})
    try:
        credits_info = fetch_json("https://openrouter.ai/api/v1/credits", token).get("data", {})
    except urllib.error.URLError:
        credits_info = {}

    purchased = credits_info.get("total_credits")
    spent = credits_info.get("total_usage", key_info.get("usage"))
    remaining = None
    if purchased is not None and spent is not None:
        remaining = purchased - spent

    return {
        "provider": "openrouter",
        "total_usage": spent,
        "usage_daily": key_info.get("usage_daily"),
        "usage_monthly": key_info.get("usage_monthly"),
        "credits": remaining,
        "raw": json.dumps({"key": key_info, "credits": credits_info}),
    }


# Cada proveedor nuevo se agrega acá: una función que devuelve el mismo dict.
COLLECTORS = {"OPENROUTER_API_KEY": collect_openrouter}


def command_snapshot(_arguments):
    environment = read_environment_file(ENVIRONMENT_FILE)
    connection = connect()
    captured_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    recorded = 0

    for variable, collector in COLLECTORS.items():
        token = environment.get(variable) or os.environ.get(variable)
        if not token:
            print(f"- {variable}: sin key, salteado")
            continue
        try:
            row = collector(token)
        except Exception as error:  # noqa: BLE001 - el cron no debe morir por un proveedor
            print(f"- {variable}: error consultando ({error})")
            continue
        connection.execute(
            "INSERT INTO usage_snapshot "
            "(captured_at, provider, total_usage, usage_daily, usage_monthly, credits, raw) "
            "VALUES (?,?,?,?,?,?,?)",
            (
                captured_at,
                row["provider"],
                row["total_usage"],
                row["usage_daily"],
                row["usage_monthly"],
                row["credits"],
                row["raw"],
            ),
        )
        recorded += 1
        print(
            f"- {row['provider']}: acumulado=${_money(row['total_usage'])} "
            f"mes=${_money(row['usage_monthly'])} restante=${_money(row['credits'])}"
        )

    connection.commit()
    connection.close()
    print(f"{recorded} snapshot(s) guardados en {DATABASE}")


def _money(value):
    return "—" if value is None else f"{value:.4f}"


def command_report(arguments):
    connection = connect()
    # El gasto de un mes es la diferencia entre el último acumulado de ese mes
    # y el último acumulado del mes anterior: el proveedor reporta acumulado
    # histórico, no consumo por período.
    rows = connection.execute(
        """
        SELECT provider, substr(captured_at, 1, 7) AS month,
               MAX(total_usage) AS ending_total,
               MAX(captured_at)  AS last_seen
        FROM usage_snapshot
        WHERE total_usage IS NOT NULL
        GROUP BY provider, month
        ORDER BY provider, month
        """
    ).fetchall()
    connection.close()

    if not rows:
        print("Todavía no hay datos. Corré: cost-tracker.py snapshot")
        return

    report = []
    previous_by_provider = {}
    for provider, month, ending_total, last_seen in rows:
        previous = previous_by_provider.get(provider, 0.0)
        report.append(
            {
                "provider": provider,
                "month": month,
                "spent": round(ending_total - previous, 6),
                "cumulative": round(ending_total, 6),
                "last_seen": last_seen,
            }
        )
        previous_by_provider[provider] = ending_total

    if arguments.json:
        print(json.dumps(report, indent=2))
        return

    print(f"{'Proveedor':<14} {'Mes':<9} {'Gasto del mes':>15} {'Acumulado':>12}")
    print("-" * 54)
    for entry in report:
        print(
            f"{entry['provider']:<14} {entry['month']:<9} "
            f"{'$' + format(entry['spent'], '.4f'):>15} "
            f"{'$' + format(entry['cumulative'], '.4f'):>12}"
        )
    total = sum(e["spent"] for e in report)
    print("-" * 54)
    print(f"{'TOTAL':<24} {'$' + format(total, '.4f'):>15}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("snapshot", help="graba el consumo actual")
    report_parser = subparsers.add_parser("report", help="resumen mes a mes")
    report_parser.add_argument("--json", action="store_true", help="salida en JSON")
    arguments = parser.parse_args()

    if arguments.command == "snapshot":
        command_snapshot(arguments)
    else:
        command_report(arguments)
    return 0


if __name__ == "__main__":
    sys.exit(main())
