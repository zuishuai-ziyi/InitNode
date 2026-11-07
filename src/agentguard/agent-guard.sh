#!/bin/sh
exec 9>/run/agent-guard.lock; flock -n 9 || exit 0
# agent-guard.sh - detect & purge cloud vendor guest agents (qemu-guest-agent /
# open-vm-tools incl. vmtoolsd+vgauth, lxd-agent incl. lxd snap & lxd-agent-loader).
# Intentionally NOT touched: komari-agent, cloud-init.
# Runs every minute via /etc/cron.d/agent-guard (plus @reboot).
# Action log: /var/log/agent-guard.log   Last-run stamp: /run/agent-guard.lastrun

LOG=/var/log/agent-guard.log
CHANGED=0
act() { echo "$(date '+%Y-%m-%d %T') $*" >>"$LOG"; CHANGED=1; }

# keep the log bounded
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 1048576 ]; then : >"$LOG"; fi

# 1) purge packages if (re)installed
PKGS=""
for p in qemu-guest-agent open-vm-tools lxd-agent-loader; do
  [ "$(dpkg-query -W -f='${Status}' "$p" 2>/dev/null)" = "install ok installed" ] && PKGS="$PKGS $p"
done
if [ -n "$PKGS" ]; then
  CHANGED=1
  if DEBIAN_FRONTEND=noninteractive apt-get purge -y $PKGS >>"$LOG" 2>&1; then
    act "purged:$PKGS"
  else
    act "purge FAILED:$PKGS (apt output above)"
  fi
fi

# 2) kill running agents
for b in vmtoolsd vgauthd qemu-ga; do
  if pgrep -x "$b" >/dev/null 2>&1; then
    pkill -x "$b" 2>/dev/null
    act "killed process $b"
  fi
done

# 3) remove boot-autostart entries
for u in qemu-guest-agent open-vm-tools vmtoolsd; do
  for w in /etc/systemd/system/multi-user.target.wants /lib/systemd/system/multi-user.target.wants; do
    if [ -L "$w/$u.service" ]; then
      rm -f "$w/$u.service"
      act "removed autostart $w/$u.service"
      CHANGED=1
    fi
  done
done

# 4) keep lxd-agent masked forever (symlink -> /dev/null)
M=/etc/systemd/system/lxd-agent.service
if [ "$(readlink -f "$M" 2>/dev/null)" != "/dev/null" ]; then
  ln -sfn /dev/null "$M" && act "masked lxd-agent"
fi

# 5) remove lxd snap if it comes back
if command -v snap >/dev/null 2>&1 && snap list lxd >/dev/null 2>&1; then
  CHANGED=1
  if snap remove lxd --purge >>"$LOG" 2>&1; then
    act "removed snap lxd"
  fi
  for id in $(snap saved 2>/dev/null | awk '$2=="lxd" {print $1}'); do
    snap forget "$id" >/dev/null 2>&1
  done
fi

# 6) leftover dirs
for d in /etc/vmware-tools /usr/lib/vmware-tools /var/snap/lxd; do
  if [ -e "$d" ]; then
    rm -rf "$d"
    act "removed dir $d"
    CHANGED=1
  fi
done

[ "$CHANGED" = 1 ] && systemctl daemon-reload 2>/dev/null

date '+%Y-%m-%d %T' >/run/agent-guard.lastrun
