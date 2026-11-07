#!/usr/bin/env python3
"""agent-guard-monitor — instant reaction to cloud vendor guest-agent creation.

System API used: kernel proc connector (NETLINK_CONNECTOR / CN_IDX_PROC).
Subscribes to PROC_EVENT_EXEC via netlink; the moment a process whose comm
matches a vendor monitoring agent (vmtoolsd / vgauthd / qemu-ga) is exec'ed,
fires /usr/local/bin/agent-guard.sh immediately (fire-and-forget, debounced
+ flock-guarded inside the script). The 1-minute cron sweep remains as a
safety net only.

No third-party dependencies; runs on python3 shipped with the distro.
"""
import errno
import os
import socket
import struct
import subprocess
import time

GUARD = "/usr/local/bin/agent-guard.sh"
TARGETS = {"vmtoolsd", "vgauthd", "qemu-ga"}   # comm names of vendor agents
DEBOUNCE = 5.0                                  # min seconds between triggers

NETLINK_CONNECTOR = 11
CN_IDX_PROC = 0x1
CN_VAL_PROC = 0x1
PROC_CN_MCAST_LISTEN = 0x1
NLMSG_DONE = 0x3

NLMSG_HDRLEN = 16    # struct nlmsghdr: len(4)+type(2)+flags(2)+seq(4)+pid(4)
CN_MSG_HDRLEN = 20   # struct cn_msg: id(8)+seq(4)+ack(4)+len(2)+flags(2)
PROC_WHAT_OFF = 0    # proc_event layout: what(4) @0, cpu(4) @4, timestamp_ns(8) @8, union @16
PROC_DATA_OFF = 16   # event_data union   (exec: process_pid @ +0, process_tgid @ +4)
PROC_EVENT_EXEC = 2


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


def main():
    debug = bool(os.environ.get("AG_DEBUG"))
    sock = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, NETLINK_CONNECTOR)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
    sock.bind((0, CN_IDX_PROC))   # nl_pid=0 (kernel assigns), groups=CN_IDX_PROC
    subscribe(sock)
    print("agent-guard-monitor: listening on proc connector, watching %s"
          % sorted(TARGETS), flush=True)

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
            if what != PROC_EVENT_EXEC:
                continue
            pid = struct.unpack_from("=I", data, base + PROC_DATA_OFF)[0]
            comm = read_comm(pid)
            if comm is None or comm not in TARGETS:
                continue
            now = time.monotonic()
            if now - last_trigger < DEBOUNCE:
                print("agent-guard-monitor: %s pid=%d created (debounced)" % (comm, pid),
                      flush=True)
                continue
            last_trigger = now
            print("agent-guard-monitor: %s pid=%d created -> triggering agent-guard"
                  % (comm, pid), flush=True)
            subprocess.Popen([GUARD], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
        except Exception as e:  # never die on a malformed packet
            print("agent-guard-monitor: parse error: %s" % e, flush=True)


if __name__ == "__main__":
    main()
