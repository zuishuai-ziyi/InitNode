// agent-guard 清理服务安装:自动检测并清除云厂商 guest 监控代理
// (qemu-guest-agent / open-vm-tools 含 vmtoolsd+vgauth / lxd-agent 含 lxd snap /
//  lxd-agent-loader)。刻意不碰 komari-agent 与 cloud-init。
//
// 组件(均为 systemd 原生机制,不依赖 cron):
//   - agent-guard.sh        清理脚本(开机清一遍 + 每分钟 timer 兜底)
//   - agent-guard.timer     每分钟触发清理脚本
//   - agent-guard-monitor   netlink proc-connector 监听器,厂商代理进程被创建的
//                           同一秒即触发清理(需 python3)
//
// 依赖处理(bootstrap 内完成):
//   - systemd:必需,缺失则放弃安装(输出 INITNODE_AG_RESULT systemd=no)
//   - flock(util-linux):Debian/Ubuntu 必装;极端缺失时自动去掉并发锁行
//   - python3:缺失时按 apt-get/dnf/yum/apk 顺序尝试安装;仍失败则跳过秒级
//     监听(开机清理 + 每分钟 timer 不受影响)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { execSSHStream } from './ssh.js';

const ASSET_DIR = new URL('./agentguard/', import.meta.url);
const readAsset = (name) => fs.readFileSync(fileURLToPath(new URL(name, ASSET_DIR)), 'utf8');

// 内嵌资产:与线上已验证版本字节一致(guard.sh / monitor.py 取自生产机)
export const AGENT_GUARD_ASSETS = {
  guard: readAsset('agent-guard.sh'),
  monitor: readAsset('agent-guard-monitor.py'),
  oneshotUnit: readAsset('agent-guard.service'),
  timerUnit: readAsset('agent-guard.timer'),
  monitorUnit: readAgentGuardMonitorUnit(),
};

function readAgentGuardMonitorUnit() {
  return readAsset('agent-guard-monitor.service');
}

// heredoc 片段:定界符必须加引号,防止远端 shell 展开脚本内容(如 ${Status})
function heredoc(dest, marker, content) {
  const body = content.endsWith('\n') ? content : `${content}\n`;
  return `cat > ${dest} <<'${marker}'\n${body}${marker}\n`;
}

// 生成远端安装脚本(纯函数,便于单测)。经 ssh stdin 送入 `bash -s` 执行。
// 结果约定:最后一行 INITNODE_AG_RESULT systemd=<yes|no> monitor=<yes|no>
export function buildAgentGuardBootstrap() {
  return `#!/bin/sh
# initnode agent-guard bootstrap —— 写入厂商监控清理服务并按依赖启用
set -u
ag_note() { echo "ag-guard: $*"; }

# ---- 依赖 1: systemd(整套机制的载体) ----
if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  echo "INITNODE_AG_RESULT systemd=no monitor=no"
  exit 0
fi

mkdir -p /usr/local/bin
${heredoc('/usr/local/bin/agent-guard.sh', 'AG_GUARD_EOF', AGENT_GUARD_ASSETS.guard)}
chmod 755 /usr/local/bin/agent-guard.sh

# ---- 依赖 2: flock(util-linux);极端精简系统缺失时去掉并发锁行,保证脚本可用 ----
if ! command -v flock >/dev/null 2>&1; then
  sed -i '/agent-guard\\.lock/d' /usr/local/bin/agent-guard.sh
  ag_note "未找到 flock,已去掉并发锁行(建议安装 util-linux)"
fi

${heredoc('/etc/systemd/system/agent-guard.service', 'AG_SVC_EOF', AGENT_GUARD_ASSETS.oneshotUnit)}
${heredoc('/etc/systemd/system/agent-guard.timer', 'AG_TIMER_EOF', AGENT_GUARD_ASSETS.timerUnit)}

# ---- 依赖 3: python3(秒级监听需要);缺失时按常见包管理器尝试安装 ----
AG_MONITOR=yes
if ! command -v python3 >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y python3 >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q python3 >/dev/null 2>&1 || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q python3 >/dev/null 2>&1 || true
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache python3 >/dev/null 2>&1 || true
  fi
fi
if command -v python3 >/dev/null 2>&1; then
${heredoc('/usr/local/bin/agent-guard-monitor.py', 'AG_MONPY_EOF', AGENT_GUARD_ASSETS.monitor)}
  chmod 755 /usr/local/bin/agent-guard-monitor.py
${heredoc('/etc/systemd/system/agent-guard-monitor.service', 'AG_MONSVC_EOF', AGENT_GUARD_ASSETS.monitorUnit)}
else
  AG_MONITOR=no
  ag_note "python3 不可用且自动安装失败,跳过秒级监听(开机清理 + 每分钟 timer 仍生效)"
fi

systemctl daemon-reload
systemctl enable --now agent-guard.service >/dev/null 2>&1 || ag_note "agent-guard.service 启用失败"
systemctl enable --now agent-guard.timer >/dev/null 2>&1 || ag_note "agent-guard.timer 启用失败"
if [ "$AG_MONITOR" = yes ]; then
  systemctl enable --now agent-guard-monitor.service >/dev/null 2>&1 || ag_note "agent-guard-monitor.service 启用失败"
fi

# 装完立即清一轮
/usr/local/bin/agent-guard.sh >/dev/null 2>&1 || true
echo "INITNODE_AG_RESULT systemd=yes monitor=$AG_MONITOR"
`;
}

// 在已连接的服务器上安装 agent-guard。返回 { systemd, monitor, output }。
// 任何失败抛错(调用方决定是否中止流程)。
export async function installAgentGuard(conn) {
  const r = await execSSHStream(conn, 'bash -s', {
    input: buildAgentGuardBootstrap(),
    timeoutMs: 10 * 60 * 1000,
  });
  const m = r.output.match(/INITNODE_AG_RESULT systemd=(yes|no) monitor=(yes|no)/);
  if (!m) throw new Error(`安装脚本未返回结果标记 (exit=${r.code})`);
  return { systemd: m[1] === 'yes', monitor: m[2] === 'yes', output: r.output };
}
