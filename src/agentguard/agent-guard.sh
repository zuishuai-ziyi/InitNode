#!/bin/sh
exec 9>/run/agent-guard.lock; flock -n 9 || exit 0
# agent-guard.sh - detect & purge cloud vendor guest / management / monitoring agents.
#
# Scope (kept in sync with src/vendorclean/vendor-clean.sh):
#   KVM      qemu-guest-agent (qemu-ga)
#   VMware   open-vm-tools (vmtoolsd, vgauthd)
#   LXD      lxd-agent, lxd-agent-loader, lxd snap
#   Azure    WALinuxAgent (waagent)
#   AWS      amazon-ssm-agent, amazon-cloudwatch-agent
#   GCP      google-guest-agent, google-osconfig-agent
#   Aliyun   aegis/AliYunDun + aliyun-service (wtty/云助手), cloudmonitor (argusagent)
#   Tencent  barad_agent, tat_agent, YDService/YDLive (云镜)
#   Huawei   hostguard (HSS)
#   JD       jdog / jdcloud-agent
#   Oracle   oracle-cloud-agent (+ updater)
#   DigitalOcean  do-agent
#   Xen      xe-daemon
#   Hyper-V  hv_kvp_daemon / hv_vss_daemon
# Intentionally NOT touched: komari-agent, cloud-init, BT-Panel, docker/containerd,
#   nginx/php-fpm/mysqld, gost, sshd, and third-party monitoring (netdata/zabbix/...).
# Runs every minute via agent-guard.timer (plus at boot) and instantly by
# agent-guard-monitor.py (proc connector).
# Action log: /var/log/agent-guard.log   Last-run stamp: /run/agent-guard.lastrun

LOG=/var/log/agent-guard.log
CHANGED=0
RELOAD=0
act() { echo "$(date '+%Y-%m-%d %T') $*" >>"$LOG"; CHANGED=1; }

# keep the log bounded
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 1048576 ]; then : >"$LOG"; fi

# ---- 1) purge packages if (re)installed -------------------------------------
pkg_installed() {
  if command -v dpkg-query >/dev/null 2>&1; then
    [ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null)" = "install ok installed" ]
  elif command -v rpm >/dev/null 2>&1; then
    rpm -q --quiet "$1" >/dev/null 2>&1
  else
    return 1
  fi
}

PKGS=""
for p in qemu-guest-agent open-vm-tools lxd-agent-loader walinuxagent WALinuxAgent \
         azure-vm-utils amazon-ssm-agent amazon-cloudwatch-agent \
         google-guest-agent google-osconfig-agent google-compute-engine \
         google-compute-engine-oslogin aliyun-assist aliyun-service cloudmonitor \
         oracle-cloud-agent do-agent xe-guest-utilities hyperv-daemons; do
  pkg_installed "$p" && PKGS="$PKGS $p"
done
if [ -n "$PKGS" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get purge -y $PKGS >>"$LOG" 2>&1 \
      && act "purged:$PKGS" || act "purge FAILED:$PKGS (apt output above)"
  elif command -v dnf >/dev/null 2>&1; then
    dnf remove -y -q $PKGS >>"$LOG" 2>&1 && act "removed:$PKGS" || act "remove FAILED:$PKGS"
  elif command -v yum >/dev/null 2>&1; then
    yum remove -y -q $PKGS >>"$LOG" 2>&1 && act "removed:$PKGS" || act "remove FAILED:$PKGS"
  elif command -v rpm >/dev/null 2>&1; then
    rpm -e --nodeps $PKGS >>"$LOG" 2>&1 && act "rpm -e:$PKGS" || act "rpm -e FAILED:$PKGS"
  elif command -v apk >/dev/null 2>&1; then
    apk del $PKGS >>"$LOG" 2>&1 && act "apk del:$PKGS" || act "apk del FAILED:$PKGS"
  fi
fi

# ---- 2) kill running agents by comm name (exact, cheap) ---------------------
for b in vmtoolsd vgauthd qemu-ga lxd-agent AliYunDun AliYunDunUpdate aliyun-service \
         argusagent barad_agent tat_agent YDService YDLive hostguard jdog do-agent \
         xe-daemon hv_kvp_daemon hv_vss_daemon staragent sgagent amazon-ssm-agen \
         amazon-cloudwat google_guest_ag google_osconfig oracle-cloud-ag; do
  if pgrep -x "$b" >/dev/null 2>&1; then
    pkill -x "$b" 2>/dev/null
    sleep 1
    pkill -9 -x "$b" 2>/dev/null
    act "killed process $b"
  fi
done

# ---- 3) kill by command line (python/perl agents whose comm is python3/perl) --
kill_cmd() {
  if pgrep -f -- "$1" >/dev/null 2>&1; then
    pkill -f -- "$1" 2>/dev/null
    sleep 1
    pkill -9 -f -- "$1" 2>/dev/null
    act "killed process ($1)"
  fi
}
while IFS= read -r pat; do
  [ -n "$pat" ] && kill_cmd "$pat"
done <<'VENDOR_PAT_EOF'
(^|/)qemu-ga([[:space:]]|$)
(^|/)vmtoolsd([[:space:]]|$)
(^|/)vgauthd([[:space:]]|$)
(^|/)lxd-agent([[:space:]]|$)
(^|/)(waagent|walinuxagent)([[:space:]]|$)
(^|/)amazon-ssm-agent([[:space:]]|$)
(^|/)(amazon-cloudwatch-agent|amazon-cloudwatch-agent-ctl)([[:space:]]|$)
(^|/)google_guest_agent([[:space:]]|$)
(^|/)google_osconfig_agent([[:space:]]|$)
(^|/)(aliyun-service|aliyun-assist|aliyun_installer)([[:space:]]|$)
(^|/)(AliYunDun|AliYunDunUpdate|aegis_quartz|assist_daemon|argusagent)([[:space:]]|$)
(^|/)(barad_agent|barad_agent\.py|sgagent)([[:space:]]|$)
(^|/)tat_agent([[:space:]]|$)
(^|/)(YDService|YDLive|yunjing)([[:space:]]|$)
(^|/)hostguard([[:space:]]|$)
(^|/)(jdog|jdcloud-agent)([[:space:]]|$)
(^|/)(oracle-cloud-agent|oracle-cloud-agent-updater)([[:space:]]|$)
(^|/)do-agent([[:space:]]|$)
(^|/)(xe-daemon|xenguest)([[:space:]]|$)
(^|/)hv_(kvp|vss|balloon|utils)_daemon([[:space:]]|$)
VENDOR_PAT_EOF

# ---- 4) stop + disable + mask vendor units that exist on disk ----------------
UNIT_LIST="qemu-guest-agent.service open-vm-tools.service vmtoolsd.service lxd-agent.service
walinuxagent.service amazon-ssm-agent.service amazon-cloudwatch-agent.service
google-guest-agent.service google-osconfig-agent.service google-startup-scripts.service
aliyun.service aliyun-assist.service cloudmonitor.service assist-daemon.service
tat_agent.service barad_agent.service yunjing.service YDService.service hostguard.service
jdog.service oracle-cloud-agent.service oracle-cloud-agent-updater.service do-agent.service
xe-daemon.service hv-kvp-daemon.service hv-vss-daemon.service"

unit_present() {
  for d in /etc/systemd/system /run/systemd/system /usr/lib/systemd/system /lib/systemd/system; do
    [ -e "$d/$1" ] && return 0
  done
  return 1
}

if command -v systemctl >/dev/null 2>&1; then
  for u in $UNIT_LIST; do
    unit_present "$u" || continue
    [ "$(systemctl is-enabled "$u" 2>/dev/null)" = masked ] && continue
    systemctl stop "$u" >/dev/null 2>&1
    systemctl disable "$u" >/dev/null 2>&1
    if systemctl mask "$u" >/dev/null 2>&1; then
      act "stopped+disabled+masked $u"
      RELOAD=1
    elif [ -f "/etc/systemd/system/$u" ] && [ ! -L "/etc/systemd/system/$u" ]; then
      # unit 直接装在 /etc/systemd/system 时 systemctl mask 会拒绝覆盖真实文件;
      # 这类就是厂商自己塞的 unit,直接删掉(等价于永久禁用)
      rm -f "/etc/systemd/system/$u"
      act "removed unit file /etc/systemd/system/$u (mask 不支持 /etc 内真实文件)"
      RELOAD=1
    else
      act "mask FAILED $u"
    fi
  done
fi

# ---- 5) remove boot-autostart symlinks for any vendor unit -------------------
for w in /etc/systemd/system/multi-user.target.wants \
         /etc/systemd/system/default.target.wants \
         /usr/lib/systemd/system/multi-user.target.wants \
         /lib/systemd/system/multi-user.target.wants; do
  [ -d "$w" ] || continue
  for f in "$w"/*.service; do
    [ -L "$f" ] || continue
    case "${f##*/}" in
      *qemu-guest-agent*|*open-vm-tools*|*vmtoolsd*|*vgauthd*|*lxd-agent*|*walinuxagent*|\
      *amazon-ssm*|*amazon-cloudwatch*|*google-guest*|*google-osconfig*|*aliyun*|*aegis*|\
      *cloudmonitor*|*barad*|*tat_agent*|*yunjing*|*YDService*|*hostguard*|*jdog*|\
      *oracle-cloud-agent*|*do-agent*|*xe-daemon*|*hv-kvp*|*hv-vss*)
        rm -f "$f"
        act "removed autostart $f"
        RELOAD=1
        ;;
    esac
  done
done

# ---- 6) keep lxd-agent masked forever (symlink -> /dev/null) ----------------
M=/etc/systemd/system/lxd-agent.service
if [ "$(readlink -f "$M" 2>/dev/null)" != "/dev/null" ]; then
  ln -sfn /dev/null "$M" && { act "masked lxd-agent"; RELOAD=1; }
fi

# ---- 7) SysV init scripts + rc?.d links ------------------------------------
for f in /etc/init.d/*; do
  [ -f "$f" ] || continue
  b=${f##*/}
  case "$b" in
    qemu-guest-agent|open-vm-tools|vmtoolsd|vgauthd|lxd-agent|walinuxagent|amazon-ssm-agent|\
    amazon-cloudwatch-agent|google-guest*|google-osconfig*|google-startup*|google-compute*|\
    aliyun*|aegis*|cloudmonitor|barad*|tat_agent|hostguard|jdog|oracle-cloud-agent|\
    do-agent|xe-daemon|hv-kvp-daemon|hv-vss-daemon)
      { "$f" stop >/dev/null 2>&1 || service "$b" stop >/dev/null 2>&1; } || true
      rm -f /etc/rc0.d/[SK][0-9][0-9]"$b" /etc/rc1.d/[SK][0-9][0-9]"$b" \
            /etc/rc2.d/[SK][0-9][0-9]"$b" /etc/rc3.d/[SK][0-9][0-9]"$b" \
            /etc/rc4.d/[SK][0-9][0-9]"$b" /etc/rc5.d/[SK][0-9][0-9]"$b" \
            /etc/rc6.d/[SK][0-9][0-9]"$b" /etc/rcS.d/[SK][0-9][0-9]"$b" 2>/dev/null
      rm -f "$f" && act "removed init script $f"
      ;;
  esac
done

# ---- 8) strip vendor hooks from cron dirs and rc.local ----------------------
CRON_PAT='(qemu-ga|vmtoolsd|vgauthd|lxd-agent|walinuxagent|waagent|amazon-ssm|amazon-cloudwatch|google_guest_agent|google_osconfig|aliyun-service|aliyun-assist|AliYunDun|argusagent|barad_agent|tat_agent|YDService|hostguard|jdog|oracle-cloud-agent|do-agent|xe-daemon|hv_kvp_daemon|hv_vss_daemon)'
for f in /etc/cron.d/* /etc/cron.hourly/* /etc/cron.daily/* /etc/cron.weekly/*; do
  [ -f "$f" ] || continue
  case "${f##*/}" in
    agent-guard*|komari*|bt_*|BTPanel*) continue ;;
  esac
  grep -qE "$CRON_PAT" "$f" 2>/dev/null || continue
  sed -i -E "\#$CRON_PAT#d" "$f" 2>/dev/null && act "stripped vendor cron lines from $f"
done
if [ -f /etc/rc.local ] && grep -qE "$CRON_PAT" /etc/rc.local 2>/dev/null; then
  sed -i -E "\#$CRON_PAT#d" /etc/rc.local && act "stripped vendor lines from /etc/rc.local"
fi

# ---- 9) leftover vendor dirs ----------------------------------------------
for d in /usr/local/aegis /usr/local/cloudmonitor /usr/local/qcloud /usr/local/sa \
         /usr/local/uniagent /usr/local/hostguard /usr/local/jdcloud \
         /usr/local/share/aliyun-assist /var/lib/waagent /var/lib/google \
         /var/lib/amazon/ssm /var/lib/amazon/aws-ssm /var/lib/oracle-cloud-agent \
         /opt/oracle-cloud-agent /usr/lib/oracle-cloud-agent \
         /opt/aws/amazon-cloudwatch-agent /etc/vmware-tools /usr/lib/vmware-tools \
         /var/snap/lxd; do
  [ -e "$d" ] || continue
  case "$d" in /|/usr|/var|/etc|/opt|/usr/lib|/var/lib) continue ;; esac
  rm -rf "$d" && act "removed dir $d"
done

# ---- 10) remove lxd snap if it comes back ---------------------------------
if command -v snap >/dev/null 2>&1 && snap list lxd >/dev/null 2>&1; then
  if snap remove lxd --purge >>"$LOG" 2>&1; then
    act "removed snap lxd"
  fi
  for id in $(snap saved 2>/dev/null | awk '$2=="lxd" {print $1}'); do
    snap forget "$id" >/dev/null 2>&1
  done
fi

[ "$RELOAD" = 1 ] && systemctl daemon-reload 2>/dev/null

date '+%Y-%m-%d %T' >/run/agent-guard.lastrun
