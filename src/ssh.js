// SSH 操作封装(基于 ssh2):连接(TOFU 指纹展示)、执行命令、流式输出、公钥安装。
import { Client } from 'ssh2';
import crypto from 'node:crypto';
import fs from 'node:fs';

// OpenSSH 风格的 SHA256 主机密钥指纹
export function hostKeyFingerprint(hostKeyBuf) {
  const b64 = crypto.createHash('sha256').update(hostKeyBuf).digest('base64').replace(/=+$/, '');
  return `SHA256:${b64}`;
}

function loadPrivateKey(auth, passphrase) {
  if (auth.password !== undefined) return { password: auth.password };
  const key = fs.readFileSync(auth.privateKeyPath);
  const parsed = { privateKey: key };
  if (passphrase) parsed.passphrase = passphrase;
  return parsed;
}

// 连接。auth: { password } 或 { privateKeyPath }。
// TOFU: 首次连接自动信任并在返回值里给出指纹供展示。
export function connectSSH({ host, port, username, auth, passphrase = '' }, { timeoutMs = 25_000 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let fingerprint = null;
    let settled = false;

    const timer = setTimeout(() => finish(new Error(`连接超时(${timeoutMs / 1000}s)`)), timeoutMs);

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try { conn.end(); } catch { /* ignore */ }
        reject(err);
      } else {
        resolve(value);
      }
    }

    conn.on('error', (err) => finish(normalizeSshError(err)));

    let creds;
    try {
      creds = loadPrivateKey(auth, passphrase);
    } catch (err) {
      return finish(new Error(`读取私钥失败: ${err.message}`));
    }

    conn.connect({
      host,
      port,
      username,
      readyTimeout: timeoutMs,
      keepaliveInterval: 10_000,
      // 接受任意主机密钥,但截下指纹(TOFU)。通过 hostVerifier 拿原始 Buffer。
      hostVerifier: (key) => {
        fingerprint = hostKeyFingerprint(key);
        return true;
      },
      ...creds,
    });

    conn.on('ready', () => finish(null, { conn, hostFingerprint: fingerprint }));
  });
}

function normalizeSshError(err) {
  const msg = String(err?.message || err);
  if (/All configured authentication methods failed/i.test(msg)) {
    return new Error('认证失败:用户名/密码/私钥不正确,或服务器禁用了该认证方式');
  }
  if (/getaddrinfo|ENOTFOUND/i.test(msg)) {
    return new Error(`域名/IP 解析失败: ${msg}`);
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return new Error('连接被拒绝:检查 IP 与端口是否正确');
  }
  if (/ETIMEDOUT|timed out/i.test(msg)) {
    return new Error('连接超时:检查 IP/端口、防火墙或安全组');
  }
  if (/Encrypted private key|passphrase/i.test(msg)) {
    return new Error('私钥有口令保护,需要提供 passphrase');
  }
  return new Error(msg);
}
export { normalizeSshError };

// 执行命令,收集输出。input: 写入 stdin 的内容(可选)。
export function execSSH(conn, cmd, { input = '', timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      const stdout = [];
      const stderr = [];
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error(`命令执行超时(${timeoutMs / 1000}s): ${cmd.slice(0, 80)}`));
      }, timeoutMs);

      stream.on('data', (d) => stdout.push(d));
      stream.stderr.on('data', (d) => stderr.push(d));
      stream.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });

      if (input !== '') stream.write(input);
      stream.end();
    });
  });
}

// 执行命令,写入 input 后关闭 stdin,输出实时转发到本机终端(适合安装脚本等长任务)。
// 返回 { code, output }。
export function execSSHStream(conn, cmd, { input = '', timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error(`命令执行超时(${timeoutMs / 1000}s): ${cmd.slice(0, 80)}`));
      }, timeoutMs);

      stream.on('data', (d) => {
        chunks.push(d);
        process.stdout.write(d);
      });
      stream.stderr.on('data', (d) => {
        chunks.push(d);
        process.stderr.write(d);
      });
      stream.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output: Buffer.concat(chunks).toString('utf8') });
      });

      if (input !== '') stream.write(input);
      stream.end();
    });
  });
}

// 带 PTY 执行,输出实时转发到本机终端,stdin 原始转发(供交互脚本使用)。
// 返回退出码。onChunk 可选,用于旁路捕获输出。
export function execInteractive(conn, cmd, { term = 'xterm-256color', onChunk = null, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, { pty: { term, cols: process.stdout.columns || 100, rows: process.stdout.rows || 30 } }, (err, stream) => {
      if (err) return reject(err);

      const wasRaw = process.stdin.isRaw;
      const chunks = [];
      let timedOut = false;
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            process.stdout.write('\n[initnode] 执行超时,断开远端命令。\n');
            stream.close();
          }, timeoutMs)
        : null;
      try {
        process.stdin.setRawMode?.(true);
      } catch { /* 非终端环境 */ }
      const onData = (buf) => stream.write(buf);
      process.stdin.resume(); // readline close 后 stdin 可能处于 paused,显式恢复流动
      process.stdin.on('data', onData);

      const cleanup = () => {
        process.stdin.removeListener('data', onData);
        try {
          process.stdin.setRawMode?.(wasRaw ?? false);
        } catch { /* ignore */ }
      };

      stream.on('data', (d) => {
        chunks.push(d);
        process.stdout.write(d);
        onChunk?.(d);
      });
      stream.on('close', (code) => {
        if (timer) clearTimeout(timer);
        cleanup();
        if (timedOut) return reject(new Error('远端命令执行超时'));
        resolve({ code, output: Buffer.concat(chunks).toString('utf8') });
      });
    });
  });
}

// 在远端安装公钥(幂等,自动去重、修正权限)。
export async function installPubKey(conn, pubKeyLine) {
  const cmd = [
    'umask 077',
    'mkdir -p ~/.ssh',
    'chmod 700 ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    'cat >> ~/.ssh/authorized_keys',
    'chmod 600 ~/.ssh/authorized_keys',
    'sort -u -o ~/.ssh/authorized_keys ~/.ssh/authorized_keys',
    'echo __INITNODE_PUBKEY_OK__',
  ].join(' && ');
  const { code, stdout, stderr } = await execSSH(conn, cmd, { input: pubKeyLine.trimEnd() + '\n' });
  if (code !== 0 || !stdout.includes('__INITNODE_PUBKEY_OK__')) {
    throw new Error(`公钥安装失败 (exit=${code}) ${stderr.trim().slice(0, 300)}`);
  }
}
