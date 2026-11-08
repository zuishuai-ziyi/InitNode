#!/usr/bin/env node
// initnode —— 新云服务器初始化 CLI
// 流程:Komari 配置 → 连接信息问询 → 连接(TOFU,可选探测公网 IP)→ 节点名称/标签/SSH 密钥
//       → 公钥部署 + ssh config/known_hosts → 新密钥验证 → Komari 注册(名称+标签)+ agent → 厂商监控清理服务(可选)
//       → NodeQuality 质量检测
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import * as prompts from './src/prompts.js';
import { parseArgs } from './src/args.js';
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
  fetchAutoDiscoveryKey, fetchClients, registerClient, updateClient, waitForOnline,
} from './src/komari.js';
import { runNodeQuality } from './src/nodequality.js';
import { installAgentGuard } from './src/agentguard.js';
import {
  detectPublicIP, normalizeHost, isPrivateOrLocalIP,
} from './src/publicip.js';
import { deriveTagTemplates, parseTagInput } from './src/tags.js';
import { ensurePubkeyAuth } from './src/sshd.js';

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
  finish(1);
}

// 统一出口:readline close 后 stdin 已被 resume,若不销毁会一直等 stdin EOF 导致进程挂住。
// 先销毁 stdin,再留 100ms 兜底强制退出(正常情况下事件循环自然排空,stdout 冲刷不受影响)。
function finish(code) {
  process.exitCode = code;
  prompts.close();
  process.stdin.destroy();
  setTimeout(() => process.exit(code), 100);
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// 运行中产生的痕迹,失败时提示/回滚
const trail = { keyCreated: null, configBlock: null, komariUuid: null, agentGuard: false };

const TOTAL = 7;

// ---- 命令行元信息(注册为全局命令后使用;行为对齐 ssh 的 -V / -h)----
const PKG_VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

const USAGE = `usage: initnode [user@]host [-p port] [-i key] [-l user]
       initnode                     交互式逐项问询
       initnode -V | -h

初始化一台新云服务器。给出连接信息时跳过对应问询,其余步骤照旧:
  initnode root@192.168.1.123 -p 12223
  initnode 192.168.1.123 -l deploy -p 2222 -i ~/.ssh/id_ed25519

流程(共 7 步):
  1) Komari 面板配置与自动发现密钥
  2) 服务器连接信息(地址 / 端口 / 用户 / 密码或已有私钥)
  3) 连接并信任主机指纹(TOFU),可选探测公网 IP
  4) 节点名称、标签、SSH 密钥(缺失则生成)
  5) 部署公钥、写 ~/.ssh/config 与 known_hosts
  6) 用新密钥验证登录(失败自动修 sshd 公钥登录)
  7) Komari 注册 + 安装 komari-agent + 可选 agent-guard,之后可选 NodeQuality

options:
  -p, --port <port>      SSH 端口(默认 22)
  -l, --user <user>      SSH 用户名(默认 root;与 user@host 同时给出时以 -l 为准)
  -i, --identity <path>  首次连接用的已有私钥(~ 可代 home;不给则询问认证方式)
  -V, --version          显示版本号并退出
  -h, --help             显示本帮助并退出

完成后可 \`ssh <短别名>\` 直连。`;

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.version) {
    prompts.print(`initnode ${PKG_VERSION}`);
    return finish(0);
  }
  if (parsed.help) {
    prompts.print(USAGE);
    return finish(0);
  }
  if (parsed.error) {
    process.stderr.write(`initnode: ${parsed.error}\n${USAGE}\n`);
    return finish(2);
  }
  // 命令行预设的连接信息;缺失项仍走交互问询
  const preset = {
    host: parsed.target?.host ?? null,
    port: parsed.target?.port ?? parsed.overrides.port ?? null,
    user: parsed.target?.user ?? parsed.overrides.user ?? null,
    identityFile: parsed.target?.identityFile ?? parsed.overrides.identityFile ?? null,
  };
  prompts.print(c.bold('initnode —— 新服务器初始化'));

  // ---------- [1/7] Komari 配置 ----------
  step(1, TOTAL, 'Komari 面板配置');
  const config = loadConfig();
  const kcfg = await ensureKomariConfig(config);
  saveConfig(config);
  let adKey;
  let tagTemplates = [];
  try {
    const { autoDiscoveryKey } = await fetchAutoDiscoveryKey(kcfg.endpoint, kcfg.adminApiKey);
    if (!autoDiscoveryKey) throw new Error('未启用自动发现:面板设置里 auto_discovery 为空');
    adKey = autoDiscoveryKey;
    ok(`Komari 连接成功,自动发现密钥已获取(${adKey.slice(0, 6)}***)`);
    try {
      tagTemplates = deriveTagTemplates(await fetchClients(kcfg.endpoint, kcfg.adminApiKey));
    } catch { /* 模板仅是便利功能,失败不阻塞 */ }
  } catch (err) {
    return die(`Komari 配置无效: ${err.message}`);
  }
  const { endpoint, adminApiKey } = kcfg;

  // ---------- [2/7] 连接信息 ----------
  step(2, TOTAL, '服务器连接信息');
  let host = preset.host;
  if (!host) {
    host = (await prompts.ask('服务器地址(IPv4 / IPv6 / 域名)')).trim();
    if (!host) return die('服务器地址不能为空');
  }
  let port = preset.port;
  if (port === null) port = await prompts.askInt('SSH 端口', 22);
  let user = preset.user;
  if (!user) {
    user = (await prompts.ask('SSH 用户名', { def: 'root' })).trim();
    if (!user) return die('SSH 用户名不能为空');
  }
  prompts.print(`  ${c.dim('→')} ${c.bold(`${user}@${host}`)}  ${c.dim(`端口 ${port}`)}`);

  let auth;
  let firstPassphrase = '';
  if (preset.identityFile) {
    const keyPath = expandHome(preset.identityFile);
    if (!fs.existsSync(keyPath)) return die(`私钥不存在: ${keyPath}`);
    auth = { privateKeyPath: keyPath };
    prompts.print(`  ${c.dim(`使用私钥 ${keyPath}`)}`);
  } else {
    const choice = await prompts.choose('首次连接的认证方式', [
      { label: '密码', value: 'password' },
      { label: '已有 SSH 私钥', value: 'key' },
    ]);
    if (choice === 'password') {
      auth = { password: await prompts.askPassword('SSH 密码') };
    } else {
      const kp = (await prompts.ask('已有私钥路径(~ 可代 home)', { def: '' })).trim();
      const keyPath = expandHome(kp);
      if (!kp || !fs.existsSync(keyPath)) return die(`私钥不存在: ${keyPath}`);
      firstPassphrase = await prompts.askPassword('私钥口令(无则回车)');
      auth = { privateKeyPath: keyPath };
    }
  }
  const autoIP = await prompts.confirm('连接后自动探测服务器公网 IP?(用于密钥命名/别名,可选替换连接地址)', true);

  // ---------- [3/7] 连接服务器 ----------
  step(3, TOTAL, `连接 ${host}:${port}`);
  let conn;
  let fingerprint;
  for (;;) {
    try {
      ({ conn, hostFingerprint: fingerprint } = await connectSSH({ host, port, username: user, auth, passphrase: firstPassphrase }));
      break;
    } catch (err) {
      fail(normalizeSshError(err));
      // -i 指定的私钥若有口令,首次连接会被拒;此处补问一次而不是让用户重试整个流程
      if (auth.privateKeyPath && !firstPassphrase
        && /passphrase|encrypted|decrypt/i.test(String(err.message))) {
        firstPassphrase = await prompts.askPassword('该私钥有口令,请输入(无则回车)');
        continue;
      }
      if (!(await prompts.confirm('重试连接?', true))) return die('已中止');
    }
  }
  prompts.print(`  主机指纹 (SHA256): ${c.bold(fingerprint)}`);
  if (!(await prompts.confirm('确认并信任该主机(写入 known_hosts)?', true))) {
    conn.end();
    return die('已中止');
  }

  // 公网 IP 探测与用途选择
  let detected = null;
  let ipUsage = 'none'; // 'name' = 仅密钥命名/别名; 'all' = 连接地址也替换; 'none' = 忽略
  if (autoIP) {
    prompts.print('  探测服务器公网 IP...');
    detected = await detectPublicIP(conn);
    if (!detected) {
      warn('公网 IP 探测失败(服务器无 curl/wget 或网络受限),继续使用原地址');
    } else if (normalizeHost(host) === detected) {
      ok(`公网 IP 与连接地址一致: ${detected}`);
    } else {
      prompts.print(`  ${c.bold('检测到公网 IP: ' + detected)}  ${c.dim(`(当前连接地址: ${host})`)}`);
      const opts = [
        { label: `密钥命名/别名用公网 IP,连接地址保持 ${host}`, value: 'name' },
        { label: `密钥命名与连接地址都改为公网 IP`, value: 'all' },
        { label: `忽略探测结果,全部沿用 ${host}`, value: 'none' },
      ];
      if (!isPrivateOrLocalIP(host)) opts.push(opts.shift()); // 公网地址直连时推荐连地址也替换
      ipUsage = await prompts.choose('公网 IP 的用途', opts);
      if (ipUsage === 'none') detected = null;
    }
  }
  // connHost: ssh config / known_hosts / 后续重连使用的地址;keyHost: 密钥文件命名
  const connHost = ipUsage === 'all' && detected ? detected : host;
  const keyHost = detected || host;

  // ---------- [4/7] 节点名称 / 标签 / SSH 密钥 ----------
  step(4, TOTAL, '节点名称与 SSH 密钥');
  const nameHint = `节点名称(用于密钥注释与 Komari 节点名,惯例:厂商 - 地区 - IP尾段,如:雨云 - 香港 - 189)`;
  const name = (await prompts.ask(nameHint)).trim();
  if (!name) return die('节点名称不能为空');

  const tags = await askTags(tagTemplates);

  const { privateKeyPath, publicKeyPath } = keyPathsFor(keyHost);
  if (keyExists({ privateKeyPath, publicKeyPath })) {
    prompts.print(`  已存在密钥: ${privateKeyPath}`);
    if (!(await prompts.confirm('复用该密钥?', true))) {
      await generateKeyPair(privateKeyPath, name);
      ok(`已重新生成密钥对: ${privateKeyPath}`);
    }
  } else {
    await generateKeyPair(privateKeyPath, name);
    trail.keyCreated = keyHost;
    ok(`已生成密钥对: ${privateKeyPath}`);
  }
  const pubKey = readPublicKey(publicKeyPath).trim();

  // ---------- [5/7] 公钥部署 + ssh config ----------
  step(5, TOTAL, '部署公钥并写入 ssh config');
  try {
    await execSSH(conn, 'true', { timeoutMs: 10_000 });
  } catch {
    warn('原连接已断开,重新连接...');
    try {
      ({ conn } = await connectSSH({ host, port, username: user, auth, passphrase: firstPassphrase }));
    } catch (err) {
      return die(`重连失败: ${normalizeSshError(err)}`);
    }
  }
  try {
    await installPubKey(conn, pubKey);
    ok(`公钥已写入 ${user}@ 的 authorized_keys`);
  } catch (err) {
    conn.end();
    return die(`公钥上传失败: ${normalizeSshError(err)}`);
  }

  // 顺手确认服务器 sshd 允许公钥登录(被禁用则自动启用,失败不阻塞,步骤 6 还有一次兜底)
  try {
    reportSshdFix(await ensurePubkeyAuth(conn, { user, pubkey: pubKey }));
  } catch (err) {
    prompts.print(`  ${c.dim(`sshd 配置自检跳过: ${String(err.message).split('\n')[0]}`)}`);
  }

  // 短别名(惯例:IPv4 首段 / IPv6 首组),冲突时另指定
  let alias = deriveAlias(connHost);
  const tokens = existingTokens();
  if (tokens.has(alias.toLowerCase()) || tokens.has(connHost.toLowerCase())) {
    const conflicting = findConflictingHost(alias);
    if (!conflicting || conflicting !== connHost) {
      warn(`短别名 "${alias}" 已被占用${conflicting ? `(HostName: ${conflicting})` : ''}`);
      alias = (await prompts.ask('请为该节点另指定一个短别名')).trim();
      if (!alias) return die('别名不能为空');
      if (tokens.has(alias.toLowerCase())) return die(`别名 "${alias}" 也已存在,请手动处理 ~/.ssh/config 后重试`);
    }
  }

  appendEntry({ alias, host: connHost, port, user, identityFile: privateKeyPath, comment: name });
  trail.configBlock = { alias, host: connHost };
  ok(`已追加 ~/.ssh/config:ssh ${alias}`);
  try {
    const r = await addToKnownHosts(connHost, port);
    ok(r === 'added' ? 'known_hosts 已更新' : 'known_hosts 已有条目,跳过');
  } catch (err) {
    warn(`known_hosts 写入失败(不影响使用): ${err.message.split('\n')[0]}`);
  }
  conn.end();

  // ---------- [6/7] 新密钥验证(保留连接供后续步骤复用) ----------
  step(6, TOTAL, '用新密钥验证登录');
  let mainConn;
  let verifyErr = null;
  for (let attempt = 1; attempt <= 2 && !mainConn; attempt++) {
    try {
      const v = await connectSSH({
        host: connHost, port, username: user,
        auth: { privateKeyPath },
        passphrase: '',
      });
      const { code } = await execSSH(v.conn, 'echo ok');
      if (code !== 0) {
        v.conn.end();
        throw new Error('echo 校验失败');
      }
      mainConn = v.conn;
    } catch (err) {
      verifyErr = err;
    }
    if (mainConn || attempt === 2) break;

    // 第一次失败:用首连认证方式重连,自动启用服务器端公钥登录后重试
    warn(`新密钥验证失败: ${normalizeSshError(verifyErr).message}`);
    prompts.print(`  ${c.dim('自动排查:检查 sshd 公钥登录 / PermitRootLogin / AuthorizedKeysFile 路径 / 密钥文件权限...')}`);
    let fixConn = null;
    try {
      ({ conn: fixConn } = await connectSSH({ host: connHost, port, username: user, auth, passphrase: firstPassphrase }));
    } catch (err) {
      warn(`无法用原认证方式重新连接,跳过自动修复(${normalizeSshError(err).message})`);
      break;
    }
    try {
      reportSshdFix(await ensurePubkeyAuth(fixConn, { user, pubkey: pubKey }));
      await installPubKey(fixConn, pubKey); // 幂等:配置/权限修正后重写一遍,确保内容与路径都对
      ok('已重新写入 authorized_keys');
    } catch (err) {
      warn(`自动修复未完成: ${String(err.message).split('\n')[0]}`);
    } finally {
      fixConn.end();
    }
  }
  if (!mainConn) {
    return die(`新密钥验证失败: ${normalizeSshError(verifyErr)}\n  ${c.dim('注意:authorized_keys 已写入,可手动 ssh -i 排查;中止后本机痕迹将保留。')}`);
  }
  ok(`新密钥登录成功(此后可 ${c.bold(`ssh ${alias}`)} 直连)`);

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
    const fields = { name };
    if (tags) fields.tags = tags;
    await updateClient(endpoint, adminApiKey, uuid, fields);
    ok(`节点已命名为 "${name}"${tags ? `  ${c.dim(`标签: ${tags.split(';').join(', ')}`)}` : ''}`);
  } catch (err) {
    warn(`节点改名/标签写入失败(面板中仍是 Auto- 前缀名): ${err.message}`);
  }

  try {
    prompts.print('  等待 agent 上线(最长 3 分钟)...');
    await waitForOnline(endpoint, adminApiKey, uuid, Date.now());
    ok('agent 已上线');
  } catch (err) {
    warn(err.message);
  }

  // ---------- 厂商监控清理服务(可选,失败不阻塞) ----------
  prompts.print('');
  if (await prompts.confirm('安装厂商监控清理服务 agent-guard?(自动清除 qemu-guest-agent/open-vm-tools/lxd 等厂商代理,不碰 komari)', true)) {
    prompts.print('  写入清理脚本与 systemd 单元(开机清理 + 秒级进程触发 + 每分钟兜底)...');
    try {
      const r = await installAgentGuard(mainConn);
      if (!r.systemd) {
        warn('服务器无 systemd,已跳过 agent-guard 安装');
      } else {
        trail.agentGuard = true;
        if (r.monitor) ok('agent-guard 已安装:清理脚本 + 开机单元 + 秒级监听(python3) + 每分钟 timer');
        else ok('agent-guard 已安装:清理脚本 + 开机单元 + 每分钟 timer(无 python3,秒级监听跳过)');
      }
    } catch (err) {
      warn(`agent-guard 安装失败(不影响其他步骤): ${err.message}`);
    }
  } else {
    warn('已跳过 agent-guard 清理服务');
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
  prompts.print(`  SSH      : ${c.bold(`ssh ${alias}`)}  ${c.dim(`(${user}@${connHost}:${port})`)}`);
  prompts.print(`  密钥     : ${privateKeyPath}`);
  prompts.print(`  Komari   : ${endpoint}  节点 "${name}"${tags ? `  ${c.dim(`[${tags.split(';').join(', ')}]`)}` : ''}${trail.komariUuid ? `  ${c.dim(`uuid ${trail.komariUuid}`)}` : ''}`);
  if (trail.agentGuard) prompts.print(`  清理服务 : agent-guard  ${c.dim('(自动清除厂商监控代理,日志 /var/log/agent-guard.log)')}`);
  finish(0);
}

// 打印 sshd 公钥登录自检/修复结果
function reportSshdFix(r) {
  if (!r) return;
  if (r.unknown) {
    prompts.print(`  ${c.dim(`sshd 公钥登录自检跳过: ${r.reason}`)}`);
    return;
  }
  if (r.already) {
    prompts.print(`  ${c.dim('sshd 已允许公钥登录')}`);
    return;
  }
  for (const s of r.steps || []) prompts.print(`    ${c.dim(`- ${s}`)}`);
  if (r.ok) {
    ok('服务器 sshd 原本不允许公钥登录,已自动启用(PubkeyAuthentication yes,密码登录保持不变)');
  } else {
    const hint = r.reason === 'no-privilege' ? '(需要 root 或免密 sudo 才能改 sshd 配置)' : '';
    warn(`自动启用公钥登录未成功: ${r.reason || '未知原因'}${hint}`);
  }
}

// 标签问询:常用模板来自已注册节点(名称分段 + 已设 tags)
async function askTags(templates) {
  let raw;
  if (templates.length > 0) {
    prompts.print(`  ${c.dim('常用标签(来自已注册节点):')}`);
    templates.slice(0, 12).forEach((t, i) => prompts.print(`    ${c.cyan(String(i + 1))}. ${t}`));
    raw = await prompts.ask('标签(选择编号,空格分隔可多选;或直接输入;回车跳过)');
  } else {
    raw = await prompts.ask('节点标签(可选,多个用 ; 分隔,如:香港;测试)');
  }
  const tags = parseTagInput(raw, templates);
  if (tags) ok(`标签: ${tags.split(';').join(', ')}`);
  return tags;
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
