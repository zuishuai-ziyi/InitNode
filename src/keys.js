// 本地 SSH 密钥生成:复用系统 ssh-keygen.exe,命名与注释遵循既有惯例。
// 文件名: <host 冒号转下划线>_id_ed25519(如 77.93.157.132_id_ed25519、2404_8c80_85_8001__51_id_ed25519)
// 注释:   节点名称(如 "雨云 - 湖北十堰 - 192")
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// INITNODE_SSH_DIR 环境变量用于测试重定向。
export const SSH_DIR = process.env.INITNODE_SSH_DIR || path.join(os.homedir(), '.ssh');

export function sanitizeHost(host) {
  return host.replace(/:/g, '_');
}

export function keyPathsFor(host) {
  const base = path.join(SSH_DIR, `${sanitizeHost(host)}_id_ed25519`);
  return { privateKeyPath: base, publicKeyPath: base + '.pub' };
}

export function keyExists({ privateKeyPath, publicKeyPath }) {
  return fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath);
}

function findSshKeygen() {
  const bundled = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe');
  if (fs.existsSync(bundled)) return bundled;
  return 'ssh-keygen'; // 回退到 PATH
}

// basePath = 私钥路径(不带 .pub)。ssh-keygen -f <basePath> 生成 basePath + basePath.pub。
export async function generateKeyPair(basePath, comment) {
  const keygen = findSshKeygen();
  await run(keygen, ['-t', 'ed25519', '-N', '', '-C', comment, '-f', basePath, '-q'], {
    windowsHide: true,
  });
}

export function readPublicKey(publicKeyPath) {
  return fs.readFileSync(publicKeyPath, 'utf8').trim();
}

export function removeKeyPair({ privateKeyPath, publicKeyPath }) {
  for (const p of [privateKeyPath, publicKeyPath]) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
}
