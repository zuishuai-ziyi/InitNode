// 读写 ~/.ssh/config:解析已有别名、派生短别名、追加标准条目。
// 条目格式与既有惯例一致:
//   Host <短别名> <host>
//     HostName [v6带方括号]
//     Port <port>
//     User <user>
//     IdentityFile "C:\Users\ZiYi\.ssh\<file>"
import fs from 'node:fs';
import path from 'node:path';
import { SSH_DIR } from './keys.js';

export const SSH_CONFIG_PATH = path.join(SSH_DIR, 'config');

// 提取现有配置里所有 Host 模式 token(别名或完整主机名),小写化。
export function existingTokens() {
  let text = '';
  try {
    text = fs.readFileSync(SSH_CONFIG_PATH, 'utf8');
  } catch {
    return new Set();
  }
  const tokens = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*Host\s+(.+)$/i);
    if (m) {
      for (const t of m[1].trim().split(/\s+/)) tokens.add(t.toLowerCase());
    }
  }
  return tokens;
}

// 短别名惯例:取 IP 第一段 / IPv6 首组。如 77.93.157.132 -> 77, 2404:...::51 -> 2404
export function deriveAlias(host) {
  return host.split(/[.:]/)[0] || host;
}

export function isIPv6(host) {
  return host.includes(':');
}

// 别名是否冲突:token 已被占用时,再确认该条目的 HostName 是否同一台机器。
export function findConflictingHost(alias) {
  let text = '';
  try {
    text = fs.readFileSync(SSH_CONFIG_PATH, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*Host\s+(.+)$/i);
    if (!m) continue;
    const tokens = m[1].trim().split(/\s+/);
    if (!tokens.some((t) => t.toLowerCase() === alias.toLowerCase())) continue;
    // 找该块内的 HostName
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*Host\s+/i.test(lines[j])) break;
      const hn = lines[j].match(/^\s*HostName\s+(.+)$/i);
      if (hn) return hn[1].trim().replace(/^\[|\]$/g, '');
    }
    return '(unknown)';
  }
  return null;
}

export function appendEntry({ alias, host, port, user, identityFile, comment }) {
  const hostName = isIPv6(host) ? `[${host}]` : host;
  const portLine = port === 22 ? 'Port 22' : `Port ${port}`;
  const block = [
    '',
    `# initnode: ${comment}`,
    `Host ${alias} ${host}`,
    `  HostName ${hostName}`,
    `  ${portLine}`,
    `  User ${user}`,
    `  IdentityFile "${identityFile}"`,
    '',
  ].join('\n');
  fs.appendFileSync(SSH_CONFIG_PATH, block, 'utf8');
}

// 尽力把新主机写进 known_hosts(ssh-keyscan,TOFU),失败不影响主流程。
export async function addToKnownHosts(host, port) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const keyscan = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keyscan.exe');
  const exe = fs.existsSync(keyscan) ? keyscan : 'ssh-keyscan';
  const knownHosts = path.join(SSH_DIR, 'known_hosts');

  const marker = port === 22 ? host : `[${host}]:${port}`;
  let existing = '';
  try {
    existing = fs.readFileSync(knownHosts, 'utf8');
  } catch { /* 不存在则新建 */ }
  if (existing.split(/\r?\n/).some((l) => l.startsWith(marker + ' ') || l === marker)) {
    return 'exists';
  }

  const args = ['-T', '12', '-p', String(port), host];
  const { stdout } = await run(exe, args, { windowsHide: true, timeout: 20_000 });
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (lines.length === 0) return 'empty';
  fs.appendFileSync(knownHosts, lines.join('\n') + '\n', 'utf8');
  return 'added';
}
