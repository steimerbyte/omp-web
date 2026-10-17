#!/usr/bin/env bash
# Deploy-Guard fuer den lokalen omp-web-Fork.
#
# Zwei Instanzen laufen auf diesem Host gleichzeitig:
#
#   8788  /home/pi/omp-web              die Live-Instanz, ueber die der User
#                                        mit dem Agent kommuniziert
#   8799  /home/pi/workspace/omp-web-dev die Verify-Instanz, eigener Agent-Dir
#
# Diese Instanz IST der Arbeitsweg des Users: ein Neustart von 8788 beendet
# genau die Session, in der dieses Skript laeuft. Deshalb ist ein Deploy auf
# 8788 hier standardmaessig gesperrt und nur mit --live moeglich.
#
# Grundregel: erst 8799 testen, dann 8788 anfassen. Das Skript prueft 8799
# selbst, bevor es irgendetwas live ausfuehrt -- ein Schritt "ich habe vorher
# getestet" faellt bei einer Aenderung zwischen Test und Deploy sonst still
# aus.
#
# Aufruf:
#   scripts/deploy-local.sh              -> nur Verify-Instanz neu bauen/starten
#   scripts/deploy-local.sh --live       -> zusaetzlich auf 8788 deployen
#   scripts/deploy-local.sh --live --wip -> auch uncommittete Aenderungen
#
# --wip ohne --live ist ein Fehler: ungetesteter Code auf die Live-Instanz,
# und der lokale Stand unterscheidet sich sonst vom getesteten.

set -euo pipefail

DEV_DIR="/home/pi/workspace/omp-web-dev"
LIVE_DIR="/home/pi/omp-web"
VERIFY_PORT=8799
LIVE_PORT=8788
BUN="/home/pi/.bun/bin/bun"
LOG_TAG="omp-web-deploy"

LIVE=0
WIP=0

for arg in "$@"; do
  case "$arg" in
    --live) LIVE=1 ;;
    --wip)  WIP=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unbekanntes Argument: $arg" >&2; exit 2 ;;
  esac
done

if [ "$WIP" = 1 ] && [ "$LIVE" = 0 ]; then
  echo "--wip nur zusammen mit --live. Sonst deployst Du ungetesteten Code." >&2
  exit 2
fi

log() { logger -t "$LOG_TAG" -- "$*"; echo "[deploy] $*"; }
die() { log "FEHLER: $*"; echo "[deploy] FEHLER: $*" >&2; exit 1; }

# 1. Verify-Instanz neu bauen und starten.
#
# Der Verify-Prozess laeuft ueber `hub`, nicht ueber systemd, deshalb wird er
# hier nur ersetzt, wenn er schon laeuft. Sonst startet ihn der naechste
# Developer-Lauf per Hand. Ein Kill dieses Prozesses beendet NICHT die Session
# des Users -- das ist der ganze Zweck der Aufteilung.
verify_rebuild() {
  log "Verify-Instanz wird gebaut"
  cd "$DEV_DIR"
  rm -rf .next
  "$BUN" run build >/tmp/omp-web-verify-build.log 2>&1 \
    || { tail -40 /tmp/omp-web-verify-build.log >&2; die "Verify-Build fehlgeschlagen"; }
  log "Verify-Build fertig"
}

verify_health() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
    "http://127.0.0.1:${VERIFY_PORT}/" || echo 000)
  # / ist auf einer unbeaufsichtigten Instanz 200, auf einer mit Passwortschutz
  # 302 -- beides gesund. 000 heisst: laeuft gar nicht.
  [ "$code" = 200 ] || [ "$code" = 302 ] \
    || die "Verify-Instanz auf ${VERIFY_PORT} antwortet mit ${code}"
  log "Verify-Instanz gesund (HTTP ${code})"
}

verify_rebuild
# Neustart nur, wenn schon etwas laeuft -- ein Neustart von aussen waere sonst
# ein zweiter Verify-Prozess auf demselben Port.
if curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${VERIFY_PORT}/" 2>/dev/null; then
  log "Hinweis: Verify-Instanz laeuft bereits, sie muss ueber 'hub restart omp-verify' neu gestartet werden"
else
  log "Verify-Instanz laeuft nicht -- starte sie jetzt"
  cd "$DEV_DIR"
  PI_CODING_AGENT_DIR=/home/pi/omp-verify-agent \
  OMP_WEB_HOME_ROOT=/home/pi/accounts \
  OMP_WEB_ADMINS=pi \
  nohup "$BUN" --bun ./node_modules/next/dist/bin/next \
    start -H 127.0.0.1 -p "$VERIFY_PORT" \
    >/tmp/omp-web-verify.log 2>&1 &
  for _ in $(seq 1 30); do
    sleep 1
    verify_health && break
  done
fi

verify_health
log "Verify-Instanz fertig. Noch kein Kontakt zu ${LIVE_PORT}."

# 2. Ab hier ist ein Live-Deploy gemeint.
[ "$LIVE" = 1 ] || { log "Nur Verify. Für 8788: --live"; exit 0; }

# Sicherheitsnetz: laeuft die Live-Instanz ueberhaupt? Sonst waere ein Restart
# ein blindes Vertrauen in einen Zustand, den niemand gesehen hat.
live_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
  "http://127.0.0.1:${LIVE_PORT}/" || echo 000)
[ "$live_code" != 000 ] || die "Live-Instanz auf ${LIVE_PORT} antwortet nicht -- kein Restart"
log "Live-Instanz laeuft (HTTP ${live_code}) -- wird jetzt neu gestartet, die Session endet"

cd "$DEV_DIR"
if [ "$WIP" = 0 ]; then
  [ -z "$(git status --porcelain -- ':!bun.lock')" ] \
    || die "Arbeitsbaum ist schmutzig. Erst committen oder --wip setzen"
fi

rsync -a --delete \
  --exclude '.git/' --exclude '.next/' --exclude 'node_modules/' \
  --exclude '.gitnexus/' --exclude 'omp-web-verify*' \
  "$DEV_DIR/" "$LIVE_DIR/"

log "Dateien kopiert, baue Live-Instanz neu"
cd "$LIVE_DIR"
sudo -n systemctl stop omp-web.service
rm -rf .next
"$BUN" run build >/tmp/omp-web-live-build.log 2>&1 \
  || { tail -40 /tmp/omp-web-live-build.log >&2; die "Live-Build fehlgeschlagen, Dienst bleibt gestoppt"; }
sudo -n systemctl start omp-web.service
log "Live-Instanz neu gestartet"