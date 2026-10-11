// 服务器公网 IP 自动探测:在远端执行多端点回退的 POSIX 命令(curl 优先,wget 兜底)
// 命令本身导出,便于测试与 mock 识别。
import { execSSH } from './ssh.js';

export const DETECT_PUBLIC_IP_CMD = [
  '__g(){ if command -v curl >/dev/null 2>&1; then curl $1 -s --max-time 6 "$2" 2>/dev/null;',
  'else wget -q -T 6 -O - "$2" 2>/dev/null; fi; };',
  'for m in -4 -6; do for u in https://api.ip.sb/ip https://api.ipify.org https://ifconfig.me https://ip.3322.net;',
  'do __ip=$(__g "$m" "$u" | tr -d " \\t\\r\\n");',
  'case "$__ip" in [0-9]*.[0-9]*.[0-9]*.[0-9]*|*:*) echo "$__ip"; exit 0;; esac; done; done;',
  'echo noip; exit 1',
].join(' ');

// 校验字符串是否像 IP(IPv4 严格逐段校验;IPv6 宽松校验十六进制与冒号形态)
export function isValidIP(s) {
  const v = String(s || '').trim();
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(v)) {
    return v.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
  }
  if (/^[0-9a-fA-F:]+$/.test(v) && v.includes(':')) {
    const groups = v.split(':');
    return groups.length >= 3 && groups.length <= 8;
  }
  return false;
}

// 内网/本地地址(用于探测结果菜单的默认项排序):
//   IPv4: 10/8、172.16-31、192.168、127、169.254;IPv6: ::1、fe80、fc/fd(ULA)
export function isPrivateOrLocalIP(s) {
  const v = String(s || '').trim().replace(/^\[|\]$/g, '');
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(v)) {
    const [a, b] = v.split('.').map(Number);
    if (a === 10 || a === 127 || (a === 192 && b === 168) || (a === 169 && b === 254)) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }
  const low = v.toLowerCase();
  return low === '::1' || low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd');
}

// 去掉 IPv6 字面量的方括号(用户可能输入 "[2404:..::51]")
export function normalizeHost(host) {
  return String(host || '').trim().replace(/^\[|\]$/g, '');
}

// 在已建立的服务器连接上探测公网 IP;失败返回 null
export async function detectPublicIP(conn, { timeoutMs = 90_000 } = {}) {
  try {
    const { stdout } = await execSSH(conn, DETECT_PUBLIC_IP_CMD, { timeoutMs });
    const ip = stdout.trim();
    return isValidIP(ip) ? ip : null;
  } catch {
    return null;
  }
}
