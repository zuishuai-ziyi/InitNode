#!/usr/bin/env python3
"""agent-guard-monitor — instant reaction to cloud vendor agent creation.

System API used: kernel proc connector (NETLINK_CONNECTOR / CN_IDX_PROC).
Subscribes to PROC_EVENT_EXEC and PROC_EVENT_COMM via netlink; the moment a
process that looks like a vendor guest / management / monitoring agent is
started, fires /usr/local/bin/agent-guard.sh immediately (fire-and-forget,
debounced + flock-guarded inside the script). The 1-minute timer sweep remains
as a safety net only.

Detection runs on three axes:
  * EXEC pid -> /proc/<pid>/comm   — exact comm (kernel truncates to 15 bytes)
  * EXEC pid -> /proc/<pid>/cmdline — vendor paths/script names, so agents that
    are just `python3 /usr/sbin/waagent` are still caught
  * COMM event payload — comm string carried by the kernel, works even inside a
    PID namespace (WSL/container) where /proc/<pid> is not addressable

No third-party dependencies; runs on python3 shipped with the distro.
"""
import errno
import os
import socket
import struct
import subprocess
import time

GUARD = "/usr/local/bin/agent-guard.sh"
DEBOUNCE = 5.0                                  # min seconds between triggers

# comm names (<=15 bytes after truncation); covers the same vendor set as
# agent-guard.sh — keep both lists in sync with src/vendorclean/vendor-clean.sh
TARGETS = {
    "qemu-ga", "vmtoolsd", "vgauthd", "lxd-agent",
    "waagent", "walinuxagent",
    "amazon-ssm-agen", "amazon-cloudwat",
    "google_guest_ag", "google_osconfig",
    "aliyun-service", "AliYunDun", "AliYunDunUpdate", "argusagent",
    "barad_agent", "tat_agent", "YDService", "YDLive", "sgagent",
    "hostguard", "jdog",
    "oracle-cloud-ag", "do-agent",
    "xe-daemon", "hv_kvp_daemon", "hv_vss_daemon",
}

# cmdline substrings (path fragments / script names)
CMD_TOKENS = (
    "qemu-ga", "vmtoolsd", "vgauthd", "lxd-agent",
    "walinuxagent", "/sbin/waagent", "WaAppAgent",
    "amazon-ssm-agent", "amazon-cloudwatch-agent",
    "google_guest_agent", "google_osconfig_agent",
    "aliyun-service", "aliyun-assist", "AliYunDun", "argusagent",
    "barad_agent", "tat_agent", "YDService", "YDLive", "sgagent",
    "hostguard", "jdog", "/usr/local/jdcloud",
    "oracle-cloud-agent", "do-agent",
    "xe-daemon", "hv_kvp_daemon", "hv_vss_daemon",
    "/usr/local/aegis/", "/usr/local/cloudmonitor/", "/usr/local/qcloud/",
)

NETLINK_CONNECTOR = 11
CN_IDX_PROC = 0x1
CN_VAL_PROC = 0x1
PROC_CN_MCAST_LISTEN = 0x1
NLMSG_DONE = 0x3

NLMSG_HDRLEN = 16    # struct nlmsghdr: len(4)+type(2)+flags(2)+seq(4)+pid(4)
CN_MSG_HDRLEN = 20   # struct cn_msg: id(8)+seq(4)+ack(4)+len(2)+flags(2)
PROC_WHAT_OFF = 0    # proc_event layout: what(4) @0, cpu(4) @4, timestamp_ns(8) @8, union @16
PROC_DATA_OFF = 16   # event_data union   (exec: process_pid @ +0, process_tgid @ +4)
PROC_COMM_OFF = 24   # comm event union   (pid @ +0, tgid @ +4, comm[16] @ +8)
PROC_EVENT_EXEC = 2
PROC_EVENT_COMM = 0x200


def subscribe(sock):
    """Tell the kernel to multicast proc events to this socket."""
    op = struct.pack("=I", PROC_CN_MCAST_LISTEN)
    cn = struct.pack("=IIIIHH", CN_IDX_PROC, CN_VAL_PROC, 0, 0, len(op), 0) + op
    nl = struct.pack("=IHHII", NLMSG_HDRLEN + len(cn), NLMSG_DONE, 0, 0, 0) + cn
    sock.send(nl)


def read_comm(pid):
    try:
        with open("/proc/%d/comm" % pid, "rb") as f:
            return f.read().strip().decode("utf-8", "replace")
    except OSError:
        return None


def read_cmdline(pid):
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as f:
            return f.read().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return ""


def match_comm(comm):
    """Return the target name for a comm string (kernel truncates to 15 bytes)."""
    if not comm:
        return None
    if comm in TARGETS:
        return comm
    for t in TARGETS:
        if t[:15] == comm:
            return t
    return None


def is_vendor_agent(pid, comm):
    hit = match_comm(comm)
    if hit:
        return hit
    cmd = read_cmdline(pid)
    if cmd:
        for tok in CMD_TOKENS:
            if tok in cmd:
                return tok
    return None


def main():
    debug = bool(os.environ.get("AG_DEBUG"))
    sock = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, NETLINK_CONNECTOR)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
    sock.bind((0, CN_IDX_PROC))   # nl_pid=0 (kernel assigns), groups=CN_IDX_PROC
    subscribe(sock)
    print("agent-guard-monitor: listening on proc connector, watching %d comm names / %d cmdline tokens"
          % (len(TARGETS), len(CMD_TOKENS)), flush=True)

    last_trigger = 0.0
    while True:
        try:
            data = sock.recv(65536)
        except OSError as e:
            if e.errno in (errno.EINTR, errno.EAGAIN):
                continue
            raise
        try:
            if debug:
                print("DBG recv len=%d head=%s" % (len(data), data[:60].hex()), flush=True)
            if len(data) < NLMSG_HDRLEN + CN_MSG_HDRLEN + PROC_DATA_OFF + 4:
                continue
            nl_type = struct.unpack_from("=H", data, 4)[0]
            if debug:
                print("DBG nl_type=%d" % nl_type, flush=True)
            if nl_type != NLMSG_DONE:
                continue
            idx = struct.unpack_from("=I", data, NLMSG_HDRLEN)[0]
            if idx != CN_IDX_PROC:
                continue
            base = NLMSG_HDRLEN + CN_MSG_HDRLEN
            what = struct.unpack_from("=I", data, base + PROC_WHAT_OFF)[0]
            pid = struct.unpack_from("=I", data, base + PROC_DATA_OFF)[0]
            hit = None
            if what == PROC_EVENT_EXEC:
                # EXEC 事件只带 pid:在裸机(init pid ns)上可直接读 /proc/<pid>,
                # 从而识别 comm 被内核截断的名字与 python/perl 型代理的 cmdline
                hit = is_vendor_agent(pid, read_comm(pid))
            elif what == PROC_EVENT_COMM:
                # COMM 事件自带 comm 字符串(execve 会 set_task_comm 触发),
                # 不依赖 /proc,在 PID namespace 内(WSL/容器)也能命中
                raw = data[base + PROC_COMM_OFF: base + PROC_COMM_OFF + 16]
                hit = match_comm(raw.split(b"\0", 1)[0].decode("utf-8", "replace"))
            if hit is None:
                continue
            now = time.monotonic()
            if now - last_trigger < DEBOUNCE:
                print("agent-guard-monitor: %s pid=%d created (debounced)" % (hit, pid),
                      flush=True)
                continue
            last_trigger = now
            print("agent-guard-monitor: %s pid=%d created -> triggering agent-guard"
                  % (hit, pid), flush=True)
            subprocess.Popen([GUARD], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
        except Exception as e:  # never die on a malformed packet
            print("agent-guard-monitor: parse error: %s" % e, flush=True)


if __name__ == "__main__":
    main()
