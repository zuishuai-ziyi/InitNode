// E2E 测试:mock SSH 服务器 + mock Komari 面板 + 管道喂入交互答案,跑通 index.js 全流程
// (NodeQuality 选择跳过)。不触真实 ~/.ssh 与真实 Komari。
// 两个场景:①自动探测公网 IP + 模板选标签;②关闭探测 + 自定义标签。
// 运行:node test/e2e.mjs
import fs from 'node:fs';
import http from 'node:http';
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
const INSTALL_SH = '#!/bin/sh\n# [mock] komari-agent installer stub\n'
  + '# pad '.repeat(80) + '\n'
  + 'echo "[mock-agent] installed"\n';
const DETECTED_IP = '198.51.100.7';

// ---------- mock 状态 ----------
const mock = {
  receivedPubKey: null,
  agentInstallInput: null,
  authSequence: [],       // 每次连接使用的认证方式
  registeredName: null,
  editBody: null,         // 最后一次 /edit 的完整 body
  listRequests: 0,
  detectCalls: 0,         // 公网 IP 探测命令被调用次数
  nqInput: null,          // NodeQuality 交互阶段收到的远端输入
  agentGuardInput: null,  // agent-guard 清理服务安装脚本收到的远端输入
  // —— sshd 公钥登录闸门(场景 4) ——
  enforcePubkeyGate: false, // true 时:未执行过 fix 脚本前拒绝 publickey 认证
  sshdPubkeyEnabled: false, // fix 脚本执行后置 true(模拟 PubkeyAuthentication no → yes)
  sshdFixInput: null,       // 收到的 sshd 修复脚本内容
  inspectCalls: 0,          // sshd 诊断脚本被调用次数
};

function resetMock() {
  mock.receivedPubKey = null;
  mock.agentInstallInput = null;
  mock.authSequence = [];
  mock.registeredName = null;
  mock.editBody = null;
  mock.listRequests = 0;
  mock.detectCalls = 0;
  mock.nqInput = null;
  mock.agentGuardInput = null;
  mock.enforcePubkeyGate = false;
  mock.sshdPubkeyEnabled = false;
  mock.sshdFixInput = null;
  mock.inspectCalls = 0;
}

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
        // 场景 4 的闸门:服务器没启用公钥登录时拒绝 publickey(真实故障的模拟)
        if (mock.enforcePubkeyGate && !mock.sshdPubkeyEnabled) {
          mock.authSequence.push('publickey-rejected');
          return ctx.reject();
        }
        mock.authSequence.push('publickey');
        return ctx.accept();
      }
      ctx.reject();
    });
    client.on('ready', () => {
      // ssh2 服务器要求:先 accept session 通道,再在其上处理 exec
      client.on('session', (accept) => {
        const session = accept();
        // ssh2 服务端事件名为 'pty'(非 'pty-req'),无监听器会直接拒绝导致客户端报
        // “Unable to request a pseudo-terminal”——execInteractive 必须依赖它
        session.on('pty', (acceptPty) => acceptPty());
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
          } else if (cmd.includes('api.ip.sb/ip')) {
            // 公网 IP 探测命令
            mock.detectCalls++;
            stream.write(`${DETECTED_IP}\n`);
            stream.exit(0);
            stream.end();
          } else if (cmd.trim() === 'echo ok') {
            stream.write('ok\n');
            stream.exit(0);
            stream.end();
          } else if (cmd.includes('initnode-sshd-inspect')) {
            // sshd 公钥登录诊断脚本(场景 4):用闸门状态模拟"PubkeyAuthentication no"
            mock.inspectCalls++;
            const pk = mock.sshdPubkeyEnabled ? 'yes' : 'no';
            stream.write([
              'INITNODE_SSHD priv=root',
              'INITNODE_SSHD home=/root',
              'INITNODE_SSHD sshd=/usr/sbin/sshd',
              'INITNODE_SSHD config=/etc/ssh/sshd_config',
              'INITNODE_SSHD include=no',
              'INITNODE_SSHD dropin=no',
              'INITNODE_SSHD raw_pubkey_no=yes',
              'INITNODE_SSHD raw_root_no=yes',
              `INITNODE_SSHD effective_pubkey=${pk}`,
              'INITNODE_SSHD effective_password=yes',
              `INITNODE_SSHD effective_permitrootlogin=${mock.sshdPubkeyEnabled ? 'prohibit-password' : 'no'}`,
              'INITNODE_SSHD effective_authorizedkeysfile=.ssh/authorized_keys',
              'INITNODE_SSHD effective_authenticationmethods=',
              'INITNODE_SSHD effective_allowusers=',
              'INITNODE_SSHD effective_denyusers=',
              'INITNODE_SSHD effective_allowgroups=',
              'INITNODE_SSHD effective_denygroups=',
              'INITNODE_SSHD selinux=none',
              'INITNODE_SSHD END',
            ].join('\n') + '\n');
            stream.exit(0);
            stream.end();
          } else if (cmd.includes('initnode-sshd-fix')) {
            // sshd 修复脚本(场景 4):执行后公钥登录变为可用
            drain((input) => {
              mock.sshdFixInput = input;
              mock.sshdPubkeyEnabled = true;
              stream.write([
                'INITNODE_SSHD STEP include-added',
                'INITNODE_SSHD STEP dropin-written',
                'INITNODE_SSHD STEP validated',
                'INITNODE_SSHD STEP reload=systemctl reload sshd',
                'INITNODE_SSHD STEP effective pubkey=yes permitrootlogin=prohibit-password',
                'INITNODE_SSHD RESULT ok=yes',
              ].join('\n') + '\n');
              stream.exit(0);
              stream.end();
            });
          } else if (cmd.trim() === 'bash -s') {
            // agent-guard 清理服务安装脚本(stdin 送入 bootstrap)
            drain((input) => {
              mock.agentGuardInput = input;
              stream.write('ag-guard: ok\nINITNODE_AG_RESULT systemd=yes monitor=yes\n');
              stream.exit(0);
              stream.end();
            });
          } else if (cmd.includes('bash -s --')) {
            drain((input) => {
              mock.agentInstallInput = input;
              stream.write('[mock-agent] installed\n');
              stream.exit(0);
              stream.end();
            });
          } else if (cmd.includes('run.NodeQuality.com')) {
            // NodeQuality:交互式 PTY 场景,收到 'q' 后结束
            mock.nqInput = '';
            let nqDone = false;
            stream.write('[mock-nq] press q to continue: ');
            stream.on('data', (d) => {
              mock.nqInput += d.toString();
              if (!nqDone && mock.nqInput.includes('q')) {
                nqDone = true;
                stream.write('NQ-INPUT-OK\n');
                stream.exit(0);
                stream.end();
              }
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
// 预置一个已注册节点(名称/标签用于推导标签模板),当前测试节点 uuid 固定。
const SEED_NODE = { uuid: 'seed-0000', name: '雨云 - 香港 - 189', tags: '香港', updated_at: '2026-01-01T00:00:00Z' };
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
        mock.editBody = JSON.parse(b || '{}');
        send(200, { status: 'success' });
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/admin/client/list') {
      if (auth !== `Bearer ${ADMIN_KEY}`) return send(401, { code: 401, message: 'unauthorized' });
      mock.listRequests++;
      return send(200, [SEED_NODE, {
        uuid: 'uuid-mock-0001',
        name: mock.editBody?.name || `Auto-${mock.registeredName}`,
        tags: mock.editBody?.tags || '',
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
    server.listen(0, '127.0.0.1', () => resolve({ server, port: komariPort(server) }));
  });
}
function komariPort(server) {
  return server.address().port;
}

// ---------- 场景执行 ----------
const { server: sshServer, port: sshPort } = await startMockSsh();
const { server: komariServer } = await startMockKomari();
const KPORT = komariPort(komariServer);

let failed = false;
const t = (name, cond) => {
  if (cond) console.log(`  ok  ${name}`);
  else { failed = true; console.error(`  FAIL ${name}`); }
};

// 负例:错误密码应被拒绝并归一化为中文提示
try {
  await connectSSH({ host: '127.0.0.1', port: sshPort, username: 'root', auth: { password: 'definitely-wrong' } }, { timeoutMs: 8000 });
  t('负例:错误密码应被拒绝', false);
} catch (err) {
  t('负例:错误密码提示认证失败', /认证失败/.test(err.message));
}

async function runScenario(label, answers, { interact = null, setup = null, args = [] } = {}) {
  resetMock();
  if (setup) setup();
  console.log(`\n[e2e] 场景: ${label}`);
  const tmpSsh = fs.mkdtempSync(path.join(os.tmpdir(), 'initnode-e2e-'));
  const tmpConfig = path.join(tmpSsh, 'initnode-config.json');
  fs.writeFileSync(tmpConfig, JSON.stringify({
    komari: { endpoint: `http://127.0.0.1:${KPORT}`, adminApiKey: ADMIN_KEY },
  }), 'utf8');

  const child = spawn(NODE, ['index.js', ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      INITNODE_SSH_DIR: tmpSsh,
      INITNODE_CONFIG: tmpConfig,
      INITNODE_AGENT_INSTALL_URLS: `http://127.0.0.1:${KPORT}/agent/install.sh`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let errOut = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { errOut += d; });
  const exited = new Promise((resolve) => child.on('close', (c) => resolve([c])));
  child.stdin.write(answers.join('\n') + '\n');
  // 供交互场景用:轮询 stdout 直到出现指定子串
  const waitFor = (substr, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      if (out.includes(substr)) return resolve();
      if (Date.now() - t0 > timeoutMs) {
        return reject(new Error(`waitFor 超时: ${substr}\n---- stdout ----\n${out.split('\n').slice(-30).join('\n')}`));
      }
      setTimeout(poll, 50);
    };
    poll();
  });
  const interactPromise = interact ? interact({ stdin: child.stdin, waitFor }) : null;
  const timeout = setTimeout(() => {
    console.error('\n[e2e] 超时!子进程输出如下:\n---- stdout ----\n' + out);
    console.error('---- stderr ----\n' + errOut);
    child.kill();
  }, 60_000);
  const [code] = await exited;
  if (interactPromise) {
    try { await interactPromise; } catch (e) { console.error('[e2e] interact 错误:', e.message); }
  }
  clearTimeout(timeout);
  child.stdout.destroy();
  child.stderr.destroy();

  console.log(`[e2e] exit code = ${code}`);
  if (code !== 0) {
    console.error('---- stdout tail ----\n' + out.split('\n').slice(-40).join('\n'));
    console.error('---- stderr ----\n' + errOut);
  }
  return { code, out, tmpSsh };
}

// ===== 场景 1:自动探测公网 IP + 模板选标签(连接地址保持不变) =====
{
  const NAME = 'E2E自动IP节点';
  const { code, out, tmpSsh } = await runScenario('自动探测公网 IP + 模板标签', [
    '127.0.0.1',       // 服务器地址
    String(sshPort),   // SSH 端口
    '',                // SSH 用户名(默认 root)
    '1',               // 认证方式:密码
    PASSWORD,          // SSH 密码
    'y',               // 自动探测公网 IP
    'y',               // 信任主机指纹
    '',                // 公网 IP 用途:默认 1(仅密钥命名,连接地址不变)
    NAME,              // 节点名称
    '2',               // 标签:选模板 2(香港)
    'y',               // 安装 agent-guard 清理服务
    'n',               // 跳过 NodeQuality
  ]);

  t('S1 进程退出码 0', code === 0);
  t('S1 公网 IP 探测被执行', mock.detectCalls === 1);
  t('S1 输出展示探测到的公网 IP', out.includes(DETECTED_IP));
  t('S1 SSH 首连用密码认证', mock.authSequence[0] === 'password');
  t('S1 第二次连接用 publickey 认证', mock.authSequence[1] === 'publickey');
  t('S1 密钥以公网 IP 命名', fs.existsSync(path.join(tmpSsh, `${DETECTED_IP}_id_ed25519`))
    && fs.existsSync(path.join(tmpSsh, `${DETECTED_IP}_id_ed25519.pub`)));
  t('S1 密钥注释 = 节点名称', (() => {
    try { return fs.readFileSync(path.join(tmpSsh, `${DETECTED_IP}_id_ed25519.pub`), 'utf8').trim().endsWith(NAME); } catch { return false; }
  })());
  t('S1 公钥上传内容一致', (() => {
    try {
      return mock.receivedPubKey === fs.readFileSync(path.join(tmpSsh, `${DETECTED_IP}_id_ed25519.pub`), 'utf8').trim();
    } catch { return false; }
  })());
  t('S1 ssh config:别名 127 / HostName 保持原地址 / identity 指向公网 IP 密钥', (() => {
    try {
      const cfgText = fs.readFileSync(path.join(tmpSsh, 'config'), 'utf8');
      return cfgText.includes(`Host 127 127.0.0.1`)
        && cfgText.includes(`Port ${sshPort}`)
        && cfgText.includes(`# initnode: ${NAME}`)
        && cfgText.includes(`${DETECTED_IP}_id_ed25519`);
    } catch { return false; }
  })());
  t('S1 known_hosts 已写入', (() => {
    try {
      return fs.readFileSync(path.join(tmpSsh, 'known_hosts'), 'utf8').includes('127.0.0.1');
    } catch { return false; }
  })());
  t('S1 Komari 注册名为节点名称', mock.registeredName === NAME);
  t('S1 edit 写入名称+标签(模板「香港」)', mock.editBody?.name === NAME && mock.editBody?.tags === '香港');
  t('S1 安装脚本内容已通过 stdin 送入远端', mock.agentInstallInput === INSTALL_SH);
  t('S1 agent-guard bootstrap 已通过 stdin 送入远端', (() => {
    const i = mock.agentGuardInput || '';
    return i.includes('/usr/local/bin/agent-guard.sh') && i.includes('INITNODE_AG_RESULT');
  })());
  t('S1 输出包含 agent-guard 安装成功', out.includes('agent-guard 已安装'));
  t('S1 client/list 被轮询(等待上线)', mock.listRequests >= 1);
  t('S1 输出包含初始化完成', out.includes('初始化完成'));
  t('S1 输出包含公钥安装成功', out.includes('公钥已写入'));
  t('S1 输出包含新密钥登录成功', out.includes('新密钥登录成功'));

  if (!failed) {
    try { fs.rmSync(tmpSsh, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

// ===== 场景 2:关闭自动探测 + 自定义标签 =====
{
  const NAME = 'E2E手动节点';
  const { code, out, tmpSsh } = await runScenario('关闭探测 + 自定义标签', [
    '127.0.0.1',       // 服务器地址
    String(sshPort),   // SSH 端口
    '',                // SSH 用户名(默认 root)
    '1',               // 认证方式:密码
    PASSWORD,          // SSH 密码
    'n',               // 关闭自动探测公网 IP
    'y',               // 信任主机指纹
    NAME,              // 节点名称
    '美国;CN 云',       // 自定义标签
    'y',               // 安装 agent-guard 清理服务
    'n',               // 跳过 NodeQuality
  ]);

  t('S2 进程退出码 0', code === 0);
  t('S2 未执行公网 IP 探测', mock.detectCalls === 0);
  t('S2 密钥以原地址命名', fs.existsSync(path.join(tmpSsh, '127.0.0.1_id_ed25519'))
    && fs.existsSync(path.join(tmpSsh, '127.0.0.1_id_ed25519.pub')));
  t('S2 密钥注释 = 节点名称', (() => {
    try { return fs.readFileSync(path.join(tmpSsh, '127.0.0.1_id_ed25519.pub'), 'utf8').trim().endsWith(NAME); } catch { return false; }
  })());
  t('S2 ssh config 已追加', (() => {
    try {
      const cfgText = fs.readFileSync(path.join(tmpSsh, 'config'), 'utf8');
      return cfgText.includes('Host 127 127.0.0.1') && cfgText.includes(`# initnode: ${NAME}`);
    } catch { return false; }
  })());
  t('S2 Komari 注册名为节点名称', mock.registeredName === NAME);
  t('S2 edit 写入名称+自定义标签', mock.editBody?.name === NAME && mock.editBody?.tags === '美国;CN 云');
  t('S2 agent-guard bootstrap 已送入远端且输出安装成功', (mock.agentGuardInput || '').includes('agent-guard.sh') && out.includes('agent-guard 已安装'));
  t('S2 输出包含初始化完成', out.includes('初始化完成'));

  if (!failed) {
    try { fs.rmSync(tmpSsh, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

// ---- 场景 3:NodeQuality 交互输入转发(回归:prompts.close() 后 stdin 必须仍能流入远端) ----
{
  const NAME3 = 'E2E交互节点';
  const { code: code3, out: out3, tmpSsh: tmpSsh3 } = await runScenario('NodeQuality 交互输入转发', [
    '127.0.0.1',       // 服务器地址
    String(sshPort),   // SSH 端口
    '',                // SSH 用户名(默认 root)
    '1',               // 认证方式:密码
    PASSWORD,          // SSH 密码
    'n',               // 关闭自动探测公网 IP
    'y',               // 信任主机指纹
    NAME3,             // 节点名称
    '',                // 标签:跳过
    'y',               // 安装 agent-guard 清理服务
    'y',               // 运行 NodeQuality
  ], {
    interact: async ({ stdin, waitFor }) => {
      await waitFor('[mock-nq]');
      stdin.write('q');
      await waitFor('NQ-INPUT-OK');
    },
  });
  t('S3 进程退出码 0', code3 === 0);
  if (typeof mock.nqInput !== 'string') {
  }
  t('S3 NodeQuality 交互输入已到达远端', typeof mock.nqInput === 'string' && mock.nqInput.includes('q'));
  t('S3 远端确认收到输入', out3.includes('NQ-INPUT-OK'));
  if (!failed) {
    try { fs.rmSync(tmpSsh3, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

// ---- 场景 4:服务器禁用公钥登录 → 脚本自动启用(reportSshdFix 主动修复路径) ----
{
  const NAME4 = 'E2E公钥闸门节点';
  const { code: code4, out: out4, tmpSsh: tmpSsh4 } = await runScenario('服务器禁用公钥登录→自动启用', [
    '127.0.0.1',       // 服务器地址
    String(sshPort),   // SSH 端口
    '',                // SSH 用户名(默认 root)
    '1',               // 认证方式:密码
    PASSWORD,          // SSH 密码
    'n',               // 关闭自动探测公网 IP
    'y',               // 信任主机指纹
    NAME4,             // 节点名称
    '',                // 标签:跳过
    'n',               // 跳过 agent-guard(缩短路径)
    'n',               // 跳过 NodeQuality
  ], {
    // 开启闸门:只有 fix 脚本跑过,publickey 认证才被接受
    setup: () => { mock.enforcePubkeyGate = true; },
  });
  t('S4 进程退出码 0', code4 === 0);
  t('S4 执行了 sshd 诊断脚本', mock.inspectCalls >= 1);
  t('S4 执行了 sshd 修复脚本', typeof mock.sshdFixInput === 'string' && mock.sshdFixInput.length > 0);
  t('S4 修复脚本含 PubkeyAuthentication yes', /PubkeyAuthentication yes/.test(mock.sshdFixInput || ''));
  t('S4 修复脚本写入 drop-in 配置', /sshd_config\.d\/.+\.conf/.test(mock.sshdFixInput || ''));

  t('S4 提示已自动启用公钥登录', out4.includes('已自动启用'));
  t('S4 新密钥登录成功', out4.includes('新密钥登录成功'));
  t('S4 公钥认证未被拒(修复在验证前生效)', !mock.authSequence.includes('publickey-rejected'));
  if (!failed) {
    try { fs.rmSync(tmpSsh4, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

// ===== 场景 5:命令行直接给连接信息(跳过地址/端口/用户名问询) =====
{
  const NAME5 = 'E2E命令行节点';
  const { code: code5, out: out5, tmpSsh: tmpSsh5 } = await runScenario('命令行指定 root@host -p port', [
    // 地址/端口/用户名由 argv 提供,这里直接从认证方式开始
    '1',               // 认证方式:密码
    PASSWORD,          // SSH 密码
    'n',               // 关闭自动探测公网 IP
    'y',               // 信任主机指纹
    NAME5,             // 节点名称
    '',                // 标签:跳过
    'n',               // 跳过 agent-guard
    'n',               // 跳过 NodeQuality
  ], { args: ['root@127.0.0.1', '-p', String(sshPort)] });

  t('S5 进程退出码 0', code5 === 0);
  const plain5 = out5.replace(/\x1b\[[0-9;]*m/g, '');
  t('S5 输出的连接信息来自命令行', plain5.includes('→ root@127.0.0.1') && plain5.includes(`端口 ${sshPort}`));
  t('S5 不再问询地址/端口', !out5.includes('服务器地址(') && !/SSH 端口 \[22\]/.test(out5));
  t('S5 首连用密码认证', mock.authSequence[0] === 'password');
  t('S5 ssh config 写入命令行给的端口', (() => {
    try {
      const cfgText = fs.readFileSync(path.join(tmpSsh5, 'config'), 'utf8');
      return cfgText.includes('Host 127 127.0.0.1') && cfgText.includes(`Port ${sshPort}`);
    } catch { return false; }
  })());
  t('S5 输出包含初始化完成', out5.includes('初始化完成'));
  if (!failed) {
    try { fs.rmSync(tmpSsh5, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

sshServer.close();
komariServer.close();
console.log(failed ? '\n[e2e] 存在失败项' : `\n[e2e] 全部通过(tmp 已清理)`);
process.exit(failed ? 1 : 0);

