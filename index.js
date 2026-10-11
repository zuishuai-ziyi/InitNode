#!/usr/bin/env node
// initnode —— 新云服务器初始化 CLI
// 流程:Komari 配置 → 询问节点信息 → 生成并上传 SSH 密钥 → 写入 ssh config/known_hosts
//       → 新密钥验证 → Komari 自动发现注册 + agent 安装 → NodeQuality 质量检测
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import * as prompts from './src/prompts.js';
import { loadConfig, saveConfig, ensureKomariConfig } from './src/config.js';
import {
  connectSSH, execSSH, execSSHStream, installPubKey, normalizeSshError,
} from './src/ssh.js';
import {
  keyPathsFor, keyExists, generateKeyPair, readPublicKey,
} from './src/keys.js';
import {
  existingTokens, deriveAlias, findConflictingHost, appendEntry, addToKnownHosts,
} from './src/sshconfig.js';
import {
  fetchAutoDiscoveryKey, registerClient, renameClient, waitForOnline,
} from './src/komari.js';
import { runNodeQuality } from './src/nodequality.js';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function step(n, total, msg) {
  prompts.print(`\n${c.bold(c.cyan(`[${n}/${total}]`))} ${c.bold(msg)}`);
}
const ok = (msg) => prompts.print(`  ${c.green('✓')} ${msg}`);
const warn = (msg) => prompts.print(`  ${c.yellow('!')} ${msg}`);
const fail = (msg) => prompts.print(`  ${c.red('×')} ${msg}`);

function die(msg) {
  fail(msg);
  prompts.close();
  process.exitCode = 1;
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// 运行中产生的痕迹,失败时提示/回滚
const trail = { keyCreated: null, configBlock: null, komariUuid: null };

const TOTAL = 7;

async function main() {
  prompts.print(c.bold('initnode —— 新服务器初始化'));

  // ---------- [1/7] Komari 配置 ----------
  step(1, TOTAL, 'Komari 面板配置');
  const config = loadConfig();
  const kcfg = await ensureKomariConfig(config);
  saveConfig(config);
  let adKey;
  try {
    const { autoDiscoveryKey } = await fetchAutoDiscoveryKey(kcfg.endpoint, kcfg.adminApiKey);
    if (!autoDiscoveryKey) throw new Error('未启用自动发现:面板设置里 auto_discovery 为空');
    adKey = autoDiscoveryKey;
    ok(`Komari 连接成功,自动发现密钥已获取(${adKey.slice(0, 6)}***)`);
  } catch (err) {
    return die(`Komari 配置无效: ${err.message}`);
  }
  const { endpoint, adminApiKey } = kcfg;

  // ---------- [2/7] 节点信息 ----------
  step(2, TOTAL, '节点信息');
  const name = (await prompts.ask('节点名称(用于密钥注释与 Komari 节点名,如:雨云 - 湖北十堰 - 192)')).trim();
  if (!name) return die('节点名称不能为空');
  const host = (await prompts.ask('服务器地址(IPv4 / IPv6 / 域名)')).trim();
  if (!host) return die('服务器地址不能为空');
  const port = await prompts.askInt('SSH 端口', 22);
  const user = (await prompts.ask('SSH 用户名', { def: 'root' })).trim();
  if (!user) return die('SSH 用户名不能为空');

  const choice = await prompts.choose('首次连接的认证方式', [
    { label: '密码', value: 'password' },
    { label: '已有 SSH 私钥', value: 'key' },
  ]);
  let auth;
  let firstPassphrase = '';
  if (choice === 'password') {
    auth = { password: await prompts.askPassword('SSH 密码') };
  } else {
    const kp = (await prompts.ask('已有私钥路径(~ 可代 home)', { def: '' })).trim();
    const keyPath = expandHome(kp);
    if (!kp || !fs.existsSync(keyPath)) return die(`私钥不存在: ${keyPath}`);
    firstPassphrase = await prompts.askPassword('私钥口令(无则回车)');
    auth = { privateKeyPath: keyPath };
  }

  // 短别名(惯例:IPv4 首段 / IPv6 首组)
  let alias = deriveAlias(host);
  const tokens = existingTokens();
  if (tokens.has(alias.toLowerCase()) || tokens.has(host.toLowerCase())) {
    const conflicting = findConflictingHost(alias);
    if (!conflicting || conflicting !== host) {
      warn(`短别名 "${alias}" 已被占用${conflicting ? `(HostName: ${conflicting})` : ''}`);
      alias = (await prompts.ask('请为该节点另指定一个短别名')).trim();
      if (!alias) return die('别名不能为空');
      if (tokens.has(alias.toLowerCase())) return die(`别名 "${alias}" 也已存在,请手动处理 ~/.ssh/config 后重试`);
    }
  }

  // ---------- [3/7] SSH 密钥 ----------
  step(3, TOTAL, 'SSH 密钥');
  const { privateKeyPath, publicKeyPath } = keyPathsFor(host);
  if (keyExists({ privateKeyPath, publicKeyPath })) {
    prompts.print(`  已存在密钥: ${privateKeyPath}`);
    if (!(await prompts.confirm('复用该密钥?', true))) {
      await generateKeyPair(privateKeyPath, name);
      ok(`已重新生成密钥对: ${privateKeyPath}`);
    }
  } else {
    await generateKeyPair(privateKeyPath, name);
    trail.keyCreated = host;
    ok(`已生成密钥对: ${privateKeyPath}`);
  }
  const pubKey = readPublicKey(publicKeyPath).trim();

  // ---------- [4/7] 首连 + 上传公钥 ----------
  step(4, TOTAL, `连接 ${host}:${port} 并上传公钥`);
  let conn;
  let fingerprint;
  for (;;) {
    try {
      ({ conn, hostFingerprint: fingerprint } = await connectSSH({ host, port, username: user, auth, passphrase: firstPassphrase }));
      break;
    } catch (err) {
      fail(normalizeSshError(err));
      if (!(await prompts.confirm('重试连接?', true))) return die('已中止');
    }
  }
  prompts.print(`  主机指纹 (SHA256): ${c.bold(fingerprint)}`);
  if (!(await prompts.confirm('确认并信任该主机(写入 known_hosts)?', true))) {
    conn.end();
    return die('已中止');
  }

  try {
    await installPubKey(conn, pubKey);
    ok(`公钥已写入 ${user}@ 的 authorized_keys`);
  } catch (err) {
    conn.end();
    return die(`公钥上传失败: ${normalizeSshError(err)}`);
  }

  // ---------- [5/7] ssh config + known_hosts ----------
  step(5, TOTAL, '写入 ssh config / known_hosts');
  appendEntry({ alias, host, port, user, identityFile: privateKeyPath, comment: name });
  trail.configBlock = { alias, host };
  ok(`已追加 ~/.ssh/config:ssh ${alias}`);
  try {
    const r = await addToKnownHosts(host, port);
    ok(r === 'added' ? 'known_hosts 已更新' : 'known_hosts 已有条目,跳过');
  } catch (err) {
    warn(`known_hosts 写入失败(不影响使用): ${err.message.split('\n')[0]}`);
  }
  conn.end();

  // ---------- [6/7] 新密钥验证(保留连接供后续步骤复用) ----------
  step(6, TOTAL, '用新密钥验证登录');
  let mainConn;
  try {
    const v = await connectSSH({
      host, port, username: user,
      auth: { privateKeyPath },
      passphrase: '',
    });
    const { code } = await execSSH(v.conn, 'echo ok');
    if (code !== 0) {
      v.conn.end();
      throw new Error('echo 校验失败');
    }
    mainConn = v.conn;
    ok(`新密钥登录成功(此后可 ${c.bold(`ssh ${alias}`)} 直连)`);
  } catch (err) {
    return die(`新密钥验证失败: ${normalizeSshError(err)}\n  ${c.dim('注意:authorized_keys 已写入,可手动 ssh -i 排查;中止后本机痕迹将保留。')}`);
  }

  // ---------- [7/7] Komari 注册 + agent ----------
  step(7, TOTAL, 'Komari 注册与 agent 安装');
  let uuid;
  let token;
  try {
    ({ uuid, token } = await registerClient(endpoint, adKey, name));
    trail.komariUuid = uuid;
    ok(`已注册自动发现节点(uuid: ${uuid.slice(0, 8)}…)`);
  } catch (err) {
    return die(`Komari 注册失败: ${err.message}`);
  }

  try {
    prompts.print('  拉取 komari-agent 安装脚本...');
    const script = await fetchAgentInstallScript();
    prompts.print('  在服务器上安装 komari-agent...');
    let r;
    if (script) {
      r = await execSSHStream(mainConn, agentInstallCmd(null, endpoint, token), { input: script, timeoutMs: 10 * 60 * 1000 });
    } else {
      warn('本机拉取安装脚本失败,改由服务器直接下载(带镜像回退)');
      const base = 'https://raw.githubusercontent.com/komari-monitor/komari-agent/refs/heads/main/install.sh';
      r = await execSSHStream(
        mainConn,
        `bash -c "curl -fsSL '${base}' || curl -fsSL 'https://ghfast.top/${base}' || curl -fsSL 'https://gh-proxy.com/${base}'" | ${agentInstallCmd(null, endpoint, token)}`,
        { timeoutMs: 10 * 60 * 1000 },
      );
    }
    if (r.code !== 0) throw new Error(`安装脚本退出码 ${r.code}`);
    ok('komari-agent 安装完成');
  } catch (err) {
    mainConn.end();
    return die(`agent 安装失败: ${err.message}\n  ${c.dim(`可手动安装:endpoint ${endpoint.replace(/'/g, '')} / token ${token}`)}`);
  }

  try {
    await renameClient(endpoint, adminApiKey, uuid, name);
    ok(`节点已命名为 "${name}"`);
  } catch (err) {
    warn(`节点改名失败(面板中仍是 Auto- 前缀名): ${err.message}`);
  }

  try {
    prompts.print('  等待 agent 上线(最长 3 分钟)...');
    await waitForOnline(endpoint, adminApiKey, uuid, Date.now());
    ok('agent 已上线');
  } catch (err) {
    warn(err.message);
  }

  // ---------- [8] NodeQuality ----------
  prompts.print('');
  if (await prompts.confirm('运行 NodeQuality 节点质量检测?(约 5-15 分钟)', true)) {
    prompts.close(); // 让出 stdin 给远端交互
    step(TOTAL, TOTAL, 'NodeQuality 质量检测');
    try {
      const { code, reportUrl } = await runNodeQuality(mainConn);
      if (reportUrl) ok(`检测报告: ${c.bold(reportUrl)}`);
      else if (code === 0) warn('检测完成,但未提取到报告链接');
      else warn(`检测退出码 ${code}(可能被手动中断)`);
    } catch (err) {
      fail(`NodeQuality 执行失败: ${normalizeSshError(err)}`);
    }
  } else {
    warn('已跳过 NodeQuality 检测');
  }
  mainConn.end();

  // ---------- 总结 ----------
  prompts.print(`\n${c.bold(c.green('初始化完成'))}`);
  prompts.print(`  SSH      : ${c.bold(`ssh ${alias}`)}  ${c.dim(`(${user}@${host}:${port})`)}`);
  prompts.print(`  密钥     : ${privateKeyPath}`);
  prompts.print(`  Komari   : ${endpoint}  节点 "${name}"${trail.komariUuid ? `  ${c.dim(`uuid ${trail.komariUuid}`)}` : ''}`);
  prompts.close();
}

function agentInstallCmd(script, endpoint, token) {
  const ep = endpoint.replace(/'/g, '');
  const tk = token.replace(/'/g, '');
  return `bash -s -- -e '${ep}' -t '${tk}'`;
}

// 本地拉取安装脚本(GitHub 直连 + 国内镜像),全部失败则返回 null(改用远端 curl + 镜像)。
// INITNODE_AGENT_INSTALL_URLS 环境变量可覆盖(逗号分隔),用于测试。
async function fetchAgentInstallScript() {
  const base = 'https://raw.githubusercontent.com/komari-monitor/komari-agent/refs/heads/main/install.sh';
  const urls = (process.env.INITNODE_AGENT_INSTALL_URLS || [
    base,
    `https://ghfast.top/${base}`,
    `https://gh-proxy.com/${base}`,
  ].join(',')).split(',').filter(Boolean);
  for (const u of urls) {
    try {
      const resp = await fetch(u);
      if (!resp.ok) continue;
      const text = await resp.text();
      if (text.length > 500) return text;
    } catch { /* 换下一个源 */ }
  }
  return null;
}

main().catch((err) => {
  die(`未预期的错误: ${err?.stack || err}`);
});
