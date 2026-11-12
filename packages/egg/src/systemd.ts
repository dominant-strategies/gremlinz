/** Host supervision. Docker packages the runtime; systemd alone owns container restarts. */
export const GREMLIN_UNIT = `[Unit]
Description=Gremlin egg
After=docker.service network-online.target gremlin-lockdown.service
Wants=docker.service network-online.target gremlin-watchdog.timer
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=exec
Environment=GREMLIN_MEMORY=1536m
Environment=GREMLIN_CPUS=1.5
EnvironmentFile=/etc/gremlin/service.env
ExecStartPre=-/usr/bin/docker rm -f egg
ExecStart=/usr/bin/docker run --name egg --init --restart=no --stop-timeout=20 --memory=\${GREMLIN_MEMORY} --cpus=\${GREMLIN_CPUS} --pids-limit=512 --log-opt=max-size=10m --log-opt=max-file=3 -v /var/lib/gremlin:/var/lib/gremlin -v /var/lib/gremlin-hermes:/var/lib/gremlin-hermes -v /etc/gremlin:/etc/gremlin:ro \${GREMLIN_IMAGE}
ExecStop=-/usr/bin/docker stop --time 20 egg
# A restored nest exits zero to re-enter as an egg. systemctl stop still stays stopped.
Restart=always
RestartSec=10
TimeoutStartSec=300
TimeoutStopSec=40
KillMode=control-group

[Install]
WantedBy=multi-user.target
`

export const WATCHDOG_UNIT = `[Unit]
Description=Check gremlin container progress
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/gremlin-watchdog
TimeoutStartSec=20
StateDirectory=gremlin-watchdog
StateDirectoryMode=0700
NoNewPrivileges=yes
`

export const WATCHDOG_TIMER = `[Unit]
Description=Periodically check gremlin progress

[Timer]
OnBootSec=180
OnUnitActiveSec=30
Unit=gremlin-watchdog.service

[Install]
WantedBy=timers.target
`

export const WATCHDOG_SCRIPT = `#!/bin/sh
set -eu
state=\${GREMLIN_WATCHDOG_STATE:-/var/lib/gremlin-watchdog}
docker=\${GREMLIN_DOCKER:-/usr/bin/docker}
mkdir -p "$state"
now=$(date +%s)
active=$(systemctl is-active gremlin.service || true)
# An intentional manual stop stays stopped. A failed service can recover after its start-limit cooldown.
case "$active" in inactive|deactivating) exit 0 ;; esac
if [ "$active" = failed ]; then
  unhealthy=failed
else
  unhealthy=$("$docker" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' egg) || exit 1
fi
case "$unhealthy" in healthy|starting|unknown) rm -f "$state/unhealthy-since"; exit 0 ;; esac
[ -f "$state/unhealthy-since" ] || printf '%s\n' "$now" > "$state/unhealthy-since"
since=$(cat "$state/unhealthy-since")
# Local service restarts get ten minutes to recover before restarting the whole container.
[ $((now - since)) -ge 600 ] || exit 0
last=0
[ ! -f "$state/last-restart" ] || last=$(cat "$state/last-restart")
[ $((now - last)) -ge 600 ] || exit 0
printf '%s\n' "$now" > "$state/last-restart"
rm -f "$state/unhealthy-since"
logger -t gremlin-watchdog 'Restarting gremlin after sustained local liveness failure'
systemctl reset-failed gremlin.service
systemctl --no-block restart gremlin.service
`
