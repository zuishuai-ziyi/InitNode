// E2E 测试:mock SSH 服务器 + mock Komari 面板 + 管道喂入交互答案,跑通 index.js 全流程
// (NodeQuality 选择跳过)。不触真实 ~/.ssh 与真实 Komari。
// 运行:node test/e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import ssh2 from 'ssh2';
const { Server: SshServer, utils } = ssh2;

import { connectSSH } from '../src/ssh.js';

const NODE = process.execPath;
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const ADMIN_KEY = 'komari-test-admin-key';
const AD_KEY = 'ad-key-test-123';
const PASSWORD = 'testpass';
const NODENAME = 'E2E测试节点';
const INSTALL_SH = '#!/bin/sh\n# [mock] komari-agent installer stub\n'
  + '# pad '.repeat(80) + '\n'
  + 'echo "[mock-agent] installed"\n';

// ---------- mock 状态 ----------
const mock = {
  receivedPubKey: null,
  agentInstallInput: null,
  authSequence: [],       // 每次连接使用的认证方式
  registeredName: null,
  renamedName: null,
  listRequests: 0,
};

// ---------- mock SSH 服务器 ----------
function startMockSsh() {
  const kp = utils.generateKeyPairSync('ed25519');
  const hostKey = kp.private ?? kp.privateKey;
  const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'root' && ctx.password === PASSWORD) {
        mock.authSequence.push('password');
        return ctx.accept();
      }
      if (ctx.method === 'publickey') {
        mock.authSequence.push('publickey');
        return ctx.accept();
      }
      ctx.reject();
    });
    client.on('ready', () => {
      // ssh2 服务器要求:先 accept session 通道,再在其上处理 exec
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (accept2, reject2, info) => {
          const stream = accept2();
          const cmd = info.command || '';
          const drain = (cb) => {
            let input = '';
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              cb(input);
            };
            stream.on('data', (d) => { input += d.toString(); });
            stream.on('end', finish);
            // 某些客户端不写 stdin 也不 end,兜底
            setTimeout(finish, 5000).unref?.();
          };
          if (cmd.includes('__INITNODE_PUBKEY_OK__')) {
            drain((input) => {
              mock.receivedPubKey = input.trim();
              stream.write('__INITNODE_PUBKEY_OK__\n');
              stream.exit(0);
              stream.end();
            });
          } else if (cmd.trim() === 'echo ok') {
            stream.write('ok\n');
            stream.exit(0);
            stream.end();
          } else if (cmd.includes('bash -s --')) {
            drain((input) => {
              mock.agentInstallInput = input;
              stream.write('[mock-agent] installed\n');
              stream.exit(0);
              stream.end();
            });
          } else {
            stream.stderr.write(`mock-ssh: unhandled command: ${cmd}\n`);
            stream.exit(1);
            stream.end();
          }
        });
      });
    });
  });
  server.on('error', () => {});
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---------- mock Komari 面板 ----------
function startMockKomari() {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(body);
    };
    const readBody = () => new Promise((r) => {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => r(b));
    });

    if (req.method === 'GET' && req.url === '/api/admin/settings/') {
      if (auth !== `Bearer ${ADMIN_KEY}`) return send(401, { code: 401, message: 'unauthorized' });
      return send(200, { status: 'success', data: { auto_discovery_key: AD_KEY, website_name: 'MockKomari' } });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/clients/register')) {
      if (auth !== `Bearer ${AD_KEY}`) return send(401, { code: 401, message: 'bad ad key' });
      const u = new URL(req.url, 'http://x');
      mock.registeredName = u.searchParams.get('name');
      return send(200, { status: 'success', data: { uuid: 'uuid-mock-0001', token: 'tok-mock-0001' } });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/admin/client/uuid-mock-0001/edit')) {
      if (auth !== `Bearer ${ADMIN_KEY}`) return send(401, { code: 401, message: 'unauthorized' });
      readBody().then((b) => {
        mock.renamedName = JSON.parse(b || '{}').name || null;
        send(200, { status: 'success' });
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/admin/client/list') {
      if (auth !== `Bearer ${ADMIN_KEY}`) return send(401, { code: 401, message: 'unauthorized' });
      mock.listRequests++;
      return send(200, [{
        uuid: 'uuid-mock-0001',
        name: mock.renamedName || `Auto-${mock.registeredName}`,
        updated_at: new Date().toISOString(),
      }]);
    }
    if (req.method === 'GET' && req.url.startsWith('/agent/install.sh')) {
      res.writeHead(200, { 'Content-Type': 'text/x-shellscript' });
      return res.end(INSTALL_SH);
    }
    send(404, { code: 404, message: `no route: ${req.method} ${req.url}` });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---------- 主流程 ----------
let failed = false;
const t = (name, cond) => {
  if (cond) console.log(`  ok  ${name}`);
  else { failed = true; console.error(`  FAIL ${name}`); }
};

const { server: sshServer, port: sshPort } = await startMockSsh();
const { server: komariServer, port: komariPort } = await startMockKomari();

// 负例:错误密码应被拒绝并归一化为中文提示
try {
  await connectSSH({ host: '127.0.0.1', port: sshPort, username: 'root', auth: { password: 'definitely-wrong' } }, { timeoutMs: 8000 });
  t('负例:错误密码应被拒绝', false);
} catch (err) {
  t('负例:错误密码提示认证失败', /认证失败/.test(err.message));
}

const tmpSsh = fs.mkdtempSync(path.join(os.tmpdir(), 'initnode-e2e-'));
const tmpConfig = path.join(tmpSsh, 'initnode-config.json');
fs.writeFileSync(tmpConfig, JSON.stringify({
  komari: { endpoint: `http://127.0.0.1:${komariPort}`, adminApiKey: ADMIN_KEY },
}), 'utf8');

const child = spawn(NODE, ['index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    INITNODE_SSH_DIR: tmpSsh,
    INITNODE_CONFIG: tmpConfig,
    INITNODE_AGENT_INSTALL_URLS: `http://127.0.0.1:${komariPort}/agent/install.sh`,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const answers = [
  NODENAME,          // 节点名称
  '127.0.0.1',       // 服务器地址
  String(sshPort),   // SSH 端口
  '',                // SSH 用户名(默认 root)
  '1',               // 认证方式:密码
  PASSWORD,          // SSH 密码
  'y',               // 信任主机指纹
  'n',               // 跳过 NodeQuality
];
let out = '';
let errOut = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { errOut += d; });

const exited = new Promise((resolve) => {
  child.on('close', (c) => resolve([c]));
});
child.stdin.write(answers.join('\n') + '\n');
const timeout = setTimeout(() => {
  console.error('\n[e2e] 超时!子进程输出如下:\n---- stdout ----\n' + out);
  console.error('---- stderr ----\n' + errOut);
  child.kill();
}, 60_000);
const [code] = await exited;
clearTimeout(timeout);
child.stdout.destroy();
child.stderr.destroy();

console.log(`[e2e] exit code = ${code}`);
if (code !== 0) {
  console.error('---- stdout tail ----\n' + out.split('\n').slice(-40).join('\n'));
  console.error('---- stderr ----\n' + errOut);
}

t('进程退出码 0', code === 0);
t('SSH 首连用密码认证', mock.authSequence[0] === 'password');
t('第二次连接用 publickey 认证', mock.authSequence[1] === 'publickey');
t('公钥已上传且与新公钥一致', (() => {
  try {
    const pub = fs.readFileSync(path.join(tmpSsh, '127.0.0.1_id_ed25519.pub'), 'utf8').trim();
    return mock.receivedPubKey === pub;
  } catch { return false; }
})());
t('密钥注释 = 节点名称', fs.readFileSync(path.join(tmpSsh, '127.0.0.1_id_ed25519.pub'), 'utf8').trim().endsWith(NODENAME));
t('ssh config 已追加(短别名 127)', (() => {
  try {
    const cfgText = fs.readFileSync(path.join(tmpSsh, 'config'), 'utf8');
    return cfgText.includes('Host 127 127.0.0.1')
      && cfgText.includes(`Port ${sshPort}`)
      && cfgText.includes(`# initnode: ${NODENAME}`)
      && cfgText.includes('127.0.0.1_id_ed25519');
  } catch { return false; }
})());
t('known_hosts 已写入', (() => {
  try {
    const kh = fs.readFileSync(path.join(tmpSsh, 'known_hosts'), 'utf8');
    return kh.includes(`[127.0.0.1]:${sshPort}`) || kh.includes('127.0.0.1');
  } catch { return false; }
})());
t('Komari 注册名为节点名称', mock.registeredName === NODENAME);
t('安装脚本内容已通过 stdin 送入远端', mock.agentInstallInput === INSTALL_SH);
t('节点已改名(去 Auto- 前缀)', mock.renamedName === NODENAME);
t('client/list 被轮询(等待上线)', mock.listRequests >= 1);
t('输出包含初始化完成', out.includes('初始化完成'));
t('输出包含公钥安装成功', out.includes('公钥已写入'));
t('输出包含新密钥登录成功', out.includes('新密钥登录成功'));

sshServer.close();
komariServer.close();
if (!failed) {
  try { fs.rmSync(tmpSsh, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
console.log(failed ? '\n[e2e] 存在失败项' : `\n[e2e] 全部通过(tmp 已清理)`);
process.exit(failed ? 1 : 0);
