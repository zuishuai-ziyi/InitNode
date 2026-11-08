#!/bin/sh
# vendor-clean.sh - one-shot removal of cloud vendor guest / monitoring / management agents.
#
# 与 agent-guard.sh 的区别: agent-guard 是常驻守卫(只盯 qemu-ga / vmtoolsd+vgauthd / lxd-agent,
# 每分钟回收一次); 本脚本是一次性"大扫除", 覆盖各云厂商塞进镜像里的
# guest-agent / 主机安全 / 监控 / 运维通道代理, 适合拿到一台二手/回收机器后清一遍。
#
# 覆盖(按厂商):
#   KVM        qemu-guest-agent (qemu-ga)
#   VMware     open-vm-tools (vmtoolsd / vgauthd / vmware-tools 目录)
#   LXD/Incus  lxd-agent, lxd-agent-loader, snap lxd
#   Azure      walinuxagent (waagent), azure-vm-utils
#   AWS        amazon-ssm-agent, amazon-cloudwatch-agent
#   GCP        google-guest-agent, google-osconfig-agent, google-compute-engine
#   Aliyun     aegis(安骑士: AliYunDun/AliYunDunUpdate/agentwatch), aliyun-service(云助手),
#              aliyun-assist, cloudmonitor(云监控旧版)
#   Tencent    barad_agent, tat_agent(TAT 自动化助手), YunJing(云镜 YDService/YDLive), stargate
#   Huawei     hostguard(HSS 主机安全)
#   JD Cloud   jdog / jdcloud-agent
#   Oracle     oracle-cloud-agent (含 updater / uniagent)
#   DO         do-agent
#   Xen        xe-daemon (xe-guest-utilities)
#   Hyper-V    hv_kvp_daemon / hv-vss-daemon
#
# 刻意不动(即使"看起来像监控"):
#   cloud-init, komari-agent(本家监控), 宝塔 BT-Panel/BT-Task, docker/containerd,
#   nginx/php-fpm/mysqld, gost, sshd, 系统自带 systemd 组件。
#   第三方监控(netdata / zabbix-agent / telegraf / node_exporter / datadog)默认也不动,
#   那些通常是使用者自己装的; 要一并清掉请显式加 --third-party。
#
# 用法:
#   ./vendor-clean.sh --dry-run     只报告将执行的动作, 不改动系统(不需要 root)
#   ./vendor-clean.sh               真删(需 root), 动作日志 /var/log/vendor-clean.log
#   ./vendor-clean.sh --third-party 连第三方监控代理一起清
#
# 退出码: 0 = 已清理干净(或本就没有); 1 = 有清理失败项; 2 = 参数/权限错误
set -u

LOG=/var/log/vendor-clean.log
STAMP=/run/vendor-clean.lastrun
DRY=0
THIRD=0
HITS=0
DONE=0
FAIL=0

usage() {
    awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print} NR>1 && !/^#/ {exit}' "$0"
    exit 2
}

while [ $# -gt 0 ]; do
    case "$1" in
        -n|--dry-run) DRY=1 ;;
        --third-party) THIRD=1 ;;
        -h|--help) usage ;;
        *) echo "vendor-clean: 未知参数 $1 (见 --help)" >&2; exit 2 ;;
    esac
    shift
done

say() {
    printf '%s\n' "$*"
    [ "$DRY" = 1 ] || printf '%s %s\n' "$(date '+%Y-%m-%d %T')" "$*" >>"$LOG" 2>/dev/null
}

# ---------------------------------------------------------------- 环境识别
if [ "$DRY" = 0 ] && [ "$(id -u)" != 0 ]; then
    echo "vendor-clean: 真删需要 root (或先 --dry-run 看清单)" >&2
    exit 2
fi

if [ "$DRY" = 0 ] && [ -f "$LOG" ] && [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
    : >"$LOG"
fi
if command -v timeout >/dev/null 2>&1; then TIMEOUT=timeout; else TIMEOUT=""; fi

say "=== vendor-clean $(date '+%Y-%m-%d %T') host=$(hostname 2>/dev/null) dry-run=$DRY ==="
[ -r /etc/os-release ] && say "OS: $(. /etc/os-release && echo "$PRETTY_NAME")"
say "virt: $(systemd-detect-virt 2>/dev/null || echo unknown)"
if [ -r /sys/class/dmi/id/sys_vendor ]; then
    say "DMI: $(cat /sys/class/dmi/id/sys_vendor 2>/dev/null) / $(cat /sys/class/dmi/id/product_name 2>/dev/null) / $(cat /sys/class/dmi/id/bios_vendor 2>/dev/null)"
fi

# ---------------------------------------------------------------- 1) 厂商自带卸载器
# 优先用厂商自己的 uninstall.sh: 它们会顺带清 aegis 驱动/注册项, 比手工删干净
UNINSTALLERS="
/usr/local/aegis/uninstall.sh
/usr/local/cloudmonitor/uninstall.sh
/usr/local/qcloud/stargate/uninstall.sh
/usr/local/qcloud/barad_agent/uninstall.sh
/usr/local/hostguard/uninstall.sh
/usr/local/uniagent/uninstall.sh
"
for f in $UNINSTALLERS; do
    [ -f "$f" ] || continue
    HITS=$((HITS + 1))
    if [ "$DRY" = 1 ]; then
        say "[dry-run] sh $f   (厂商自带卸载器)"
    elif ${TIMEOUT:+$TIMEOUT 180} sh "$f" </dev/null >>"$LOG" 2>&1; then
        say "ran vendor uninstaller: $f"
        DONE=$((DONE + 1))
    else
        say "vendor uninstaller FAILED (继续手工清理): $f"
        FAIL=$((FAIL + 1))
    fi
done

# ---------------------------------------------------------------- 2) 卸包
PKGS="qemu-guest-agent open-vm-tools open-vm-tools-desktop lxd-agent-loader
walinuxagent WALinuxAgent azure-vm-utils
google-guest-agent google-compute-engine google-compute-engine-oslogin google-osconfig-agent
amazon-ssm-agent amazon-cloudwatch-agent
oracle-cloud-agent
aliyun-assist aliyun-service
xe-guest-utilities xe-guest-utilities-xenstore hyperv-daemons"
if [ "$THIRD" = 1 ]; then
    PKGS="$PKGS netdata zabbix-agent zabbix-agent2 telegraf prometheus-node-exporter datadog-agent"
fi

purge_pkgs() {
    names=""
    if command -v dpkg-query >/dev/null 2>&1; then
        for p in $PKGS; do
            [ "$(dpkg-query -W -f='${Status}' "$p" 2>/dev/null)" = "install ok installed" ] && names="$names $p"
        done
        [ -n "$names" ] || return 0
        HITS=$((HITS + 1))
        if [ "$DRY" = 1 ]; then
            say "[dry-run] DEBIAN_FRONTEND=noninteractive apt-get purge -y$names"
            return 0
        fi
        if DEBIAN_FRONTEND=noninteractive apt-get purge -y \
            -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold $names >>"$LOG" 2>&1; then
            say "purged:$names"
            DONE=$((DONE + 1))
        else
            say "FAILED purge:$names"
            FAIL=$((FAIL + 1))
        fi
        return 0
    fi
    if command -v rpm >/dev/null 2>&1; then
        for p in $PKGS; do
            rpm -q "$p" >/dev/null 2>&1 && names="$names $p"
        done
        [ -n "$names" ] || return 0
        HITS=$((HITS + 1))
        if command -v dnf >/dev/null 2>&1; then
            RM="dnf -y remove"
        elif command -v yum >/dev/null 2>&1; then
            RM="yum -y remove"
        else
            RM="rpm -e --nodeps"
        fi
        if [ "$DRY" = 1 ]; then
            say "[dry-run] $RM$names"
            return 0
        fi
        if $RM $names >>"$LOG" 2>&1; then
            say "removed:$names"
            DONE=$((DONE + 1))
        else
            say "FAILED remove:$names"
            FAIL=$((FAIL + 1))
        fi
        return 0
    fi
    if command -v apk >/dev/null 2>&1; then
        for p in $PKGS; do
            apk info -e "$p" >/dev/null 2>&1 && names="$names $p"
        done
        [ -n "$names" ] || return 0
        HITS=$((HITS + 1))
        if [ "$DRY" = 1 ]; then
            say "[dry-run] apk del$names"
            return 0
        fi
        if apk del $names >>"$LOG" 2>&1; then
            say "apk del:$names"
            DONE=$((DONE + 1))
        else
            say "FAILED apk del:$names"
            FAIL=$((FAIL + 1))
        fi
    fi
}
purge_pkgs

# ---------------------------------------------------------------- 3) 杀进程
# 用 pgrep -f 匹配完整命令行(路径/脚本名), 避免误伤同名普通进程; 先 TERM 后 KILL
PROC_PATTERNS="
(^|/)qemu-ga([[:space:]]|$)
(^|/)vmtoolsd([[:space:]]|$)
(^|/)vgauthd([[:space:]]|$)
(^|/)lxd-agent([[:space:]]|$)
(^|/)waagent([[:space:]]|$)
(^|/)amazon-ssm-agent([[:space:]]|$)
(^|/)amazon-cloudwatch-agent([[:space:]]|$)
(^|/)google_guest_agent([[:space:]]|$)
(^|/)google_osconfig_agent([[:space:]]|$)
(^|/)aliyun-service([[:space:]]|$)
(^|/)aliyun-assist([[:space:]]|$)
/usr/local/aegis/
AliYunDun
(^|/)barad_agent
(^|/)tat_agent
(^|/)YDService|(^|/)YDLive|/usr/local/qcloud/
(^|/)hostguard
(^|/)jdog|/usr/local/jdcloud/
(^|/)oracle-cloud-agent
/usr/local/uniagent/
(^|/)do-agent([[:space:]]|$)
(^|/)xe-daemon
(^|/)hv_kvp_daemon
(^|/)hv-vss-daemon
"
if [ "$THIRD" = 1 ]; then
    PROC_PATTERNS="$PROC_PATTERNS
(^|/)netdata([[:space:]]|$)
(^|/)zabbix_agent
(^|/)telegraf([[:space:]]|$)
(^|/)node_exporter([[:space:]]|$)
(^|/)dd-agent([[:space:]]|$)
"
fi

kill_procs() {
    pat=$1
    pids=$(pgrep -f -- "$pat" 2>/dev/null | tr '\n' ' ')
    [ -n "$pids" ] || return 0
    tgt=""
    for p in $pids; do
        [ "$p" = "$$" ] && continue          # 自己
        [ "$p" = "$PPID" ] && continue       # 调用者(可能是 ssh 会话)
        tgt="$tgt $p"
    done
    [ -n "$tgt" ] || return 0
    HITS=$((HITS + 1))
    if [ "$DRY" = 1 ]; then
        say "[dry-run] kill -TERM$tgt   (pattern: $pat)"
        return 0
    fi
    kill -TERM $tgt 2>/dev/null
    sleep 1
    for p in $tgt; do
        kill -0 "$p" 2>/dev/null && kill -KILL "$p" 2>/dev/null
    done
    say "killed$tgt (pattern: $pat)"
    DONE=$((DONE + 1))
}
# 注意: 用 for 遍历(不在管道子壳里跑, 否则 HITS/DONE 计数丢失)
set -f
for pat in $PROC_PATTERNS; do
    kill_procs "$pat"
done
set +f

# ---------------------------------------------------------------- 4) systemd unit
UNITS="qemu-guest-agent.service open-vm-tools.service vmtoolsd.service vgauthd.service
lxd-agent.service lxd-agent-9p.service snap.lxd.daemon.service snap.lxd.activate.service
walinuxagent.service amazon-ssm-agent.service amazon-cloudwatch-agent.service
google-guest-agent.service google-osconfig-agent.service google-startup-scripts.service
oracle-cloud-agent.service oracle-cloud-agent-updater.service
aegis.service agentwatch.service cloudmonitor.service aliyun.service aliyun-assist.service
barad_agent.service barad-agent.service tat_agent.service YunJing.service ydservice.service
hostguard.service hostguard-agent.service jdog.service jdcloud-agent.service
do-agent.service xe-linux-distribution.service hv-kvp-daemon.service hv-vss-daemon.service
uniagent.service stargate.service"
if [ "$THIRD" = 1 ]; then
    UNITS="$UNITS netdata.service zabbix-agent.service zabbix-agent2.service telegraf.service prometheus-node-exporter.service datadog-agent.service"
fi

unit_exists() {
    if command -v systemctl >/dev/null 2>&1; then
        systemctl list-unit-files --no-legend --no-pager "$1" 2>/dev/null | grep -q . && return 0
    fi
    for d in /etc/systemd/system /usr/lib/systemd/system /lib/systemd/system; do
        [ -e "$d/$1" ] && return 0
    done
    return 1
}

for u in $UNITS; do
    unit_exists "$u" || continue
    HITS=$((HITS + 1))
    if [ "$DRY" = 1 ]; then
        say "[dry-run] systemctl stop/disable/mask $u"
        continue
    fi
    systemctl stop "$u" >>"$LOG" 2>&1
    systemctl disable "$u" >>"$LOG" 2>&1
    if systemctl mask "$u" >>"$LOG" 2>&1; then
        say "stopped+disabled+masked: $u"
        DONE=$((DONE + 1))
    else
        say "FAILED unit: $u"
        FAIL=$((FAIL + 1))
    fi
done

# ---------------------------------------------------------------- 5) SysV / 自启链残留
TOKENS="aegis agentwatch qemu-guest-agent open-vm-tools vmtoolsd vgauthd lxd-agent walinuxagent barad tat_agent hostguard cloudmonitor aliyun do-agent xe-daemon uniagent jdog stargate"
for d in /etc/rc0.d /etc/rc1.d /etc/rc2.d /etc/rc3.d /etc/rc4.d /etc/rc5.d /etc/rc6.d /etc/rcS.d; do
    [ -d "$d" ] || continue
    for l in "$d"/*; do
        [ -L "$l" ] || continue
        base=$(basename "$l")
        for t in $TOKENS; do
            case "$base" in
                *"$t"*)
                    HITS=$((HITS + 1))
                    if [ "$DRY" = 1 ]; then
                        say "[dry-run] rm -f $l   (SysV 自启链)"
                    else
                        rm -f "$l" && say "rm $l"
                        DONE=$((DONE + 1))
                    fi
                    break
                    ;;
            esac
        done
    done
done

for f in /etc/init.d/*; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    for t in $TOKENS; do
        case "$base" in
            *"$t"*)
                HITS=$((HITS + 1))
                if [ "$DRY" = 1 ]; then
                    say "[dry-run] rm -f $f + update-rc.d $base remove   (SysV 脚本)"
                else
                    command -v update-rc.d >/dev/null 2>&1 && update-rc.d "$base" remove >>"$LOG" 2>&1
                    rm -f "$f" && say "rm $f"
                    DONE=$((DONE + 1))
                fi
                break
                ;;
        esac
    done
done

# ---------------------------------------------------------------- 6) 清理残留目录
DIRS="/etc/qemu /etc/vmware-tools /usr/lib/vmware-tools /var/lib/vmware /var/snap/lxd
/usr/local/aegis /usr/local/cloudmonitor /usr/local/qcloud /usr/local/sa /usr/local/uniagent
/usr/local/hostguard /usr/local/jdcloud /var/lib/waagent /var/lib/amazon/ssm
/var/lib/amazon/amazon-cloudwatch-agent /opt/aws /var/lib/google /var/lib/oracle-cloud-agent
/var/log/oracle-cloud-agent /var/log/aegis /var/log/qcloud"
if [ "$THIRD" = 1 ]; then
    DIRS="$DIRS /var/lib/netdata /var/cache/netdata /etc/netdata /etc/telegraf"
fi

safe_rm_dir() {
    d=$1
    case "$d" in
        ""|/|/usr|/usr/local|/etc|/var|/var/lib|/opt|/bin|/sbin|/lib|/lib64|/boot|/home|/root|/tmp|/snap|/proc|/sys|/dev|/run)
            say "REFUSE protected path: $d"
            return 1
            ;;
    esac
    [ -e "$d" ] || [ -L "$d" ] || return 0
    HITS=$((HITS + 1))
    if [ "$DRY" = 1 ]; then
        say "[dry-run] rm -rf $d"
        return 0
    fi
    if rm -rf "$d"; then
        say "removed dir: $d"
        DONE=$((DONE + 1))
    else
        say "FAILED rm -rf $d"
        FAIL=$((FAIL + 1))
        return 1
    fi
}
for d in $DIRS; do
    safe_rm_dir "$d"
done

# ---------------------------------------------------------------- 7) snap lxd
if command -v snap >/dev/null 2>&1 && snap list lxd >/dev/null 2>&1; then
    HITS=$((HITS + 1))
    if [ "$DRY" = 1 ]; then
        say "[dry-run] snap remove lxd --purge"
    else
        if snap remove lxd --purge >>"$LOG" 2>&1; then
            say "removed snap lxd"
            DONE=$((DONE + 1))
        else
            say "FAILED snap remove lxd"
            FAIL=$((FAIL + 1))
        fi
        for id in $(snap saved 2>/dev/null | awk '$2=="lxd" {print $1}'); do
            snap forget "$id" >/dev/null 2>&1
        done
    fi
fi

# ---------------------------------------------------------------- 8) cron / rc.local 里的厂商钩子
drop_cron_tokens() {
    f=$1
    [ -f "$f" ] || return 0
    for t in $TOKENS; do
        grep -q -- "$t" "$f" 2>/dev/null || continue
        HITS=$((HITS + 1))
        if [ "$DRY" = 1 ]; then
            say "[dry-run] 从 $f 删除含 '$t' 的行"
        else
            tmp="$f.vendorclean.$$"
            grep -v -- "$t" "$f" >"$tmp" 2>/dev/null && cat "$tmp" >"$f"
            rm -f "$tmp"
            say "stripped '$t' lines from $f"
            DONE=$((DONE + 1))
        fi
    done
}
for f in /etc/cron.d/* /etc/crontab /etc/rc.local; do
    case "$f" in
        *agent-guard*|*komari*|*bt_*|*BTPanel*) continue ;;   # 本家/宝塔的钩子
    esac
    drop_cron_tokens "$f"
done

# ---------------------------------------------------------------- 9) 永久 mask lxd-agent
# 与 agent-guard 一致: 即使以后 lxd-agent-loader 被重装也不会自启
M=/etc/systemd/system/lxd-agent.service
if unit_exists lxd-agent.service && [ "$(readlink -f "$M" 2>/dev/null)" != "/dev/null" ]; then
    HITS=$((HITS + 1))
    if [ "$DRY" = 1 ]; then
        say "[dry-run] ln -sfn /dev/null $M   (永久 mask lxd-agent)"
    else
        ln -sfn /dev/null "$M" && say "masked lxd-agent permanently"
        DONE=$((DONE + 1))
    fi
fi

if [ "$DRY" = 0 ]; then
    systemctl daemon-reload >>"$LOG" 2>&1
fi

# ---------------------------------------------------------------- 10) 复查
remain=""
if command -v dpkg-query >/dev/null 2>&1; then
    for p in $PKGS; do
        [ "$(dpkg-query -W -f='${Status}' "$p" 2>/dev/null)" = "install ok installed" ] && remain="$remain pkg:$p"
    done
fi
for pat in $PROC_PATTERNS; do
    pgrep -f -- "$pat" >/dev/null 2>&1 && remain="$remain proc:$pat"
done
set +f

say "=== 命中 $HITS 项, 已处理 $DONE 项, 失败 $FAIL 项 ==="
if [ -n "$remain" ]; then
    say "复查仍存在:$remain"
elif [ "$DRY" = 1 ]; then
    say "复查: 当前无命中(或已在上表列出的项), 干跑未改动系统"
else
    say "复查: 无厂商代理包/进程残留"
fi
say "未触碰: cloud-init / komari-agent / 宝塔 / docker / nginx / sshd (第三方监控需 --third-party)"

[ "$DRY" = 0 ] && [ -w /run ] && echo "$(date '+%Y-%m-%d %T') hits=$HITS done=$DONE fail=$FAIL" >"$STAMP" 2>/dev/null

[ "$FAIL" -gt 0 ] && exit 1
exit 0
