// 单元测试:纯函数逻辑(不联网、不改真实 ~/.ssh)。
// 运行:node test/unit.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 重定向 SSH 目录到临时目录,必须在 import 被测模块之前设置
const tmpSsh = fs.mkdtempSync(path.join(os.tmpdir(), 'initnode-unit-'));
process.env.INITNODE_SSH_DIR = tmpSsh;

const { sanitizeHost, keyPathsFor, SSH_DIR } = await import('../src/keys.js');
const {
  existingTokens, deriveAlias, isIPv6, findConflictingHost, appendEntry, addToKnownHosts,
} = await import('../src/sshconfig.js');
const { hostKeyFingerprint } = await import('../src/ssh.js');
const { extractReportUrl } = await import('../src/nodequality.js');
const { normalizeTags, parseTagInput, deriveTagTemplates } = await import('../src/tags.js');
const { isValidIP, isPrivateOrLocalIP, normalizeHost, DETECT_PUBLIC_IP_CMD } = await import('../src/publicip.js');
const { parseArgs } = await import('../src/args.js');
const { buildAgentGuardBootstrap, AGENT_GUARD_ASSETS } = await import('../src/agentguard.js');
const {
  buildInspectScript, parseInspect, buildSshdFixScript, parseFixOutput,
  resolveAuthorizedKeysPaths, buildKeyPathScript, DROPIN_PATH,
} = await import('../src/sshd.js');

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

console.log(`[unit] SSH_DIR = ${SSH_DIR}`);

// ---- keys.js ----
t('sanitizeHost: IPv4 不变', () => {
  assert.equal(sanitizeHost('77.93.157.132'), '77.93.157.132');
});
t('sanitizeHost: IPv6 冒号转下划线', () => {
  assert.equal(sanitizeHost('2404:8c80:85:8001::51'), '2404_8c80_85_8001__51');
});
t('keyPathsFor: 文件名遵循惯例', () => {
  const p = keyPathsFor('2404:8c80:85:8001::51');
  assert.ok(p.privateKeyPath.endsWith('2404_8c80_85_8001__51_id_ed25519'));
  assert.ok(p.publicKeyPath.endsWith('2404_8c80_85_8001__51_id_ed25519.pub'));
});

// ---- sshconfig.js ----
t('deriveAlias: IPv4 首段', () => {
  assert.equal(deriveAlias('77.93.157.132'), '77');
});
t('deriveAlias: IPv6 首组', () => {
  assert.equal(deriveAlias('2404:8c80:85:8001::51'), '2404');
});
t('deriveAlias: 域名首段', () => {
  assert.equal(deriveAlias('mail.example.com'), 'mail');
});
t('isIPv6', () => {
  assert.equal(isIPv6('1.2.3.4'), false);
  assert.equal(isIPv6('::1'), true);
});
t('existingTokens: 空目录返回空集', () => {
  assert.equal(existingTokens().size, 0);
});
t('appendEntry + existingTokens + findConflictingHost', () => {
  appendEntry({
    alias: '77', host: '77.93.157.132', port: 12698, user: 'root',
    identityFile: 'C:\\Users\\ZiYi\\.ssh\\77.93.157.132_id_ed25519', comment: '零零壹云 - 香港 - 77',
  });
  const tokens = existingTokens();
  assert.ok(tokens.has('77'), 'alias token');
  assert.ok(tokens.has('77.93.157.132'), 'host token');
  assert.equal(findConflictingHost('77'), '77.93.157.132');
  assert.equal(findConflictingHost('nonexist'), null);
});
t('appendEntry: IPv6 HostName 加方括号', () => {
  appendEntry({
    alias: '2404', host: '2404:8c80:85:8001::51', port: 22, user: 'root',
    identityFile: 'X:\\k', comment: 'test',
  });
  const text = fs.readFileSync(path.join(tmpSsh, 'config'), 'utf8');
  assert.ok(text.includes('HostName [2404:8c80:85:8001::51]'), 'bracketed HostName');
  assert.ok(text.includes('# initnode: test'), 'comment marker');
  assert.ok(/Host 2404 2404:8c80:85:8001::51/.test(text), 'Host line has both tokens');
});

// ---- ssh.js ----
t('hostKeyFingerprint 格式', () => {
  const fp = hostKeyFingerprint(Buffer.from('fake-host-key-bytes'));
  assert.match(fp, /^SHA256:[A-Za-z0-9+/]{43}$/);
});

// ---- nodequality.js ----
t('extractReportUrl: 提取报告链接', () => {
  const out = 'some log\nReport: https://nodequality.com/r/AbC123xyz\nmore';
  assert.equal(extractReportUrl(out), 'https://nodequality.com/r/AbC123xyz');
});
t('extractReportUrl: 无链接返回 null', () => {
  assert.equal(extractReportUrl('no link here'), null);
});

// ---- tags.js ----
t('normalizeTags: 中西分隔符归一化+去重', () => {
  assert.equal(normalizeTags('香港, 测试；CN、云|dc2'), '香港;测试;CN;云;dc2');
  assert.equal(normalizeTags(''), '');
});
t('parseTagInput: 空输入跳过', () => {
  assert.equal(parseTagInput('', ['香港']), '');
  assert.equal(parseTagInput('  ', ['香港']), '');
});
t('parseTagInput: 编号取模板(空格多选)', () => {
  const tpl = ['雨云', '香港', '阿里云'];
  assert.equal(parseTagInput('2', tpl), '香港');
  assert.equal(parseTagInput('1 3', tpl), '雨云;阿里云');
});
t('parseTagInput: 非编号视为自定义文本', () => {
  assert.equal(parseTagInput('美国;CN 云', ['雨云']), '美国;CN 云');
});
t('parseTagInput: 编号越界回退为文本', () => {
  assert.equal(parseTagInput('9', ['雨云']), '9');
});
t('deriveTagTemplates: 节点名分段+tags,丢弃纯数字尾段,去重', () => {
  const clients = [
    { name: '雨云 - 湖北十堰 - 192', tags: '' },
    { name: '雨云 - 香港 - 189', tags: '香港' },
    { name: 'ByteVirt - 美国盐湖城 - 77', tags: '' },
  ];
  assert.deepEqual(deriveTagTemplates(clients), ['雨云', '湖北十堰', '香港', 'ByteVirt', '美国盐湖城']);
});

// ---- publicip.js ----
t('isValidIP: IPv4 严格校验', () => {
  assert.equal(isValidIP('192.140.166.198'), true);
  assert.equal(isValidIP('256.1.1.1'), false);
  assert.equal(isValidIP('1.2.3'), false);
  assert.equal(isValidIP('noip'), false);
});
t('isValidIP: IPv6 宽松校验', () => {
  assert.equal(isValidIP('240e:95d:3020:1d::d5'), true);
  assert.equal(isValidIP('::1'), true);
  assert.equal(isValidIP('https://error.page'), false);
});
t('isPrivateOrLocalIP', () => {
  assert.equal(isPrivateOrLocalIP('127.0.0.1'), true);
  assert.equal(isPrivateOrLocalIP('192.168.1.139'), true);
  assert.equal(isPrivateOrLocalIP('10.0.0.2'), true);
  assert.equal(isPrivateOrLocalIP('172.16.0.1'), true);
  assert.equal(isPrivateOrLocalIP('172.32.0.1'), false);
  assert.equal(isPrivateOrLocalIP('77.93.157.132'), false);
  assert.equal(isPrivateOrLocalIP('fe80::1'), true);
  assert.equal(isPrivateOrLocalIP('2404:8c80::51'), false);
});
t('normalizeHost: 去方括号', () => {
  assert.equal(normalizeHost('[2404::51]'), '2404::51');
  assert.equal(normalizeHost('1.2.3.4'), '1.2.3.4');
});
t('DETECT_PUBLIC_IP_CMD: 含多端点与 IP 校验模式', () => {
  assert.ok(DETECT_PUBLIC_IP_CMD.includes('api.ip.sb/ip'), 'endpoint');
  assert.ok(DETECT_PUBLIC_IP_CMD.includes('ip.3322.net'), '国内端点');
  assert.ok(DETECT_PUBLIC_IP_CMD.includes('wget'), 'wget 兑底');
  assert.ok(DETECT_PUBLIC_IP_CMD.includes('exit 0'), '提前退出');
});

// ---- agentguard.js ----
t('agentguard: bootstrap 写出全部 5 个目标文件', () => {
  const s = buildAgentGuardBootstrap();
  [
    '/usr/local/bin/agent-guard.sh',
    '/usr/local/bin/agent-guard-monitor.py',
    '/etc/systemd/system/agent-guard.service',
    '/etc/systemd/system/agent-guard.timer',
    '/etc/systemd/system/agent-guard-monitor.service',
  ].forEach((p) => assert.ok(s.includes(p), p));
});
t('agentguard: heredoc 定界符全部加引号(防远端展开)', () => {
  const s = buildAgentGuardBootstrap();
  assert.equal((s.match(/<<'AG_[A-Z]+_EOF'/g) || []).length, 5, '5 个带引号定界符');
  assert.ok(!/<<AG_/.test(s), '不允许无引号定界符');
});
t('agentguard: 依赖处理(systemd 必须/flock 缺失去锁/python3 尝试安装)', () => {
  const s = buildAgentGuardBootstrap();
  assert.ok(s.includes('command -v systemctl'), 'systemd 检查');
  assert.ok(s.includes('[ ! -d /run/systemd/system ]'), '运行态检查');
  assert.ok(s.includes('command -v flock'), 'flock 检查');
  assert.ok(s.includes("sed -i '/agent-guard\\.lock/d'"), 'flock 缺失自动去锁');
  assert.ok(s.includes('apt-get install -y python3'), 'apt 安装 python3');
  assert.ok(s.includes('dnf install -y -q python3'), 'dnf 安装 python3');
  assert.ok(s.includes('apk add --no-cache python3'), 'apk 安装 python3');
  // 重装/升级必须显式重启已在运行的单元(enable --now 对 active 单元是空操作)
  assert.ok(s.includes('systemctl restart agent-guard-monitor.service'), 'monitor 显式重启');
  assert.ok(s.includes('systemctl restart agent-guard.timer'), 'timer 显式重启');
  assert.ok(s.includes('INITNODE_AG_RESULT systemd='), '结果标记');
});
t('agentguard: 内嵌资产关键内容(guard 范围/monitor 偏移修复回归)', () => {
  const { guard, monitor, oneshotUnit, timerUnit, monitorUnit } = AGENT_GUARD_ASSETS;
  assert.ok(guard.includes('qemu-guest-agent'), 'guard 覆盖 qemu');
  assert.ok(guard.includes('open-vm-tools'), 'guard 覆盖 vmware');
  assert.ok(guard.includes('lxd-agent-loader'), 'guard 覆盖 lxd');
  assert.ok(guard.includes('NOT touched: komari-agent, cloud-init'), '不碰 komari/cloud-init');
  assert.ok(guard.includes('flock -n 9'), '并发锁');
  assert.ok(guard.includes("<<'VENDOR_PAT_EOF'"), 'guard 自带 heredoc 也加引号');
  // 厂商范围扩到 14 家(与 src/vendorclean/vendor-clean.sh 同步)
  [
    'walinuxagent', 'amazon-ssm-agent', 'amazon-cloudwatch-agent',
    'google-guest-agent', 'google-osconfig-agent',
    'aliyun-service', 'AliYunDun', 'cloudmonitor',
    'barad_agent', 'tat_agent', 'YDService',
    'hostguard', 'jdog', 'oracle-cloud-agent', 'do-agent',
    'xe-daemon', 'hv_kvp_daemon',
  ].forEach((v) => assert.ok(guard.includes(v), 'guard 覆盖 ' + v));
  // 明示的保护名单(不碰的东西必须写在脚本注释里,防止后人误扩)
  ['komari-agent', 'cloud-init', 'BT-Panel', 'docker/containerd', 'netdata'].forEach(
    (v) => assert.ok(guard.includes(v), 'guard 明示不动 ' + v)
  );
  // 幂等:已 mask 的 unit 跳过,避免每分钟重复 systemctl 动作
  assert.ok(guard.includes('[ "$(systemctl is-enabled "$u" 2>/dev/null)" = masked ]'), '已 mask 跳过');
  assert.ok(guard.includes('unit_present()'), 'unit 存在性检查');
  // netlink cn_proc 解析偏移回归(曾因 cn_msg 头 16/20 字节算错导致全部事件被丢)
  assert.equal(/CN_MSG_HDRLEN = (\d+)/.exec(monitor)[1], '20');
  assert.equal(/PROC_WHAT_OFF = (\d+)/.exec(monitor)[1], '0');
  assert.equal(/PROC_DATA_OFF = (\d+)/.exec(monitor)[1], '16');
  assert.equal(/PROC_COMM_OFF = (\d+)/.exec(monitor)[1], '24');
  assert.ok(monitor.includes('PROC_EVENT_COMM'), '监听 comm 事件(PID namespace 内也可命中)');
  assert.ok(monitor.includes('def match_comm'), 'comm 15 字节截断兼容');
  assert.ok(monitor.includes('PROC_EVENT_EXEC'), '监听 exec 事件');
  // python/perl 型代理靠 cmdline 片段识别
  assert.ok(monitor.includes('CMD_TOKENS'), 'monitor 支持命令行匹配');
  assert.ok(monitor.includes('def is_vendor_agent'), 'monitor 判定函数');
  assert.ok(/"hostguard"/.test(monitor) && /"AliYunDun"/.test(monitor), 'monitor 覆盖腾讯/阿里');
  assert.ok(monitor.includes('"hv_vss_daemon"'), 'monitor 覆盖 Hyper-V');
  assert.ok(oneshotUnit.includes('ExecStart=/usr/local/bin/agent-guard.sh'));
  assert.ok(timerUnit.includes('OnCalendar='), 'timer 每分钟');
  assert.ok(monitorUnit.includes('agent-guard-monitor.py'));
});

// ---- sshd.js:公钥登录自动启用 ----
const INSPECT_SAMPLE = [
  'INITNODE_SSHD priv=root',
  'INITNODE_SSHD home=/root',
  'INITNODE_SSHD sshd=/usr/sbin/sshd',
  'INITNODE_SSHD config=/etc/ssh/sshd_config',
  'INITNODE_SSHD include=no',
  'INITNODE_SSHD dropin=no',
  'INITNODE_SSHD raw_pubkey_no=yes',
  'INITNODE_SSHD raw_root_no=yes',
  'INITNODE_SSHD effective_pubkey=no',
  'INITNODE_SSHD effective_password=yes',
  'INITNODE_SSHD effective_permitrootlogin=no',
  'INITNODE_SSHD effective_authorizedkeysfile=.ssh/authorized_keys /etc/ssh/keys/%u',
  'INITNODE_SSHD effective_authenticationmethods=',
  'INITNODE_SSHD effective_allowusers=root deploy',
  'INITNODE_SSHD effective_denyusers=',
  'INITNODE_SSHD effective_allowgroups=',
  'INITNODE_SSHD effective_denygroups=',
  'INITNODE_SSHD selinux=none',
  'INITNODE_SSHD END',
  '',
].join('\n');

t('sshd: parseInspect 解析诊断输出(含带空格的值)', () => {
  const s = parseInspect(INSPECT_SAMPLE);
  assert.equal(s.known, true);
  assert.equal(s.priv, 'root');
  assert.equal(s.home, '/root');
  assert.equal(s.include, false);
  assert.equal(s.rawPubkeyNo, true);
  assert.equal(s.pubkey, 'no');
  assert.equal(s.permitRootLogin, 'no');
  assert.equal(s.authorizedKeysFile, '.ssh/authorized_keys /etc/ssh/keys/%u');
  assert.equal(s.allowUsers, 'root deploy');
});
t('sshd: parseInspect 无标记时 known=false(无权限/无 sshd)', () => {
  assert.equal(parseInspect('bash: sshd: command not found\n').known, false);
  assert.equal(parseInspect('').known, false);
  assert.equal(parseInspect('INITNODE_SSHD priv=root').known, false, '缺 END 视为未完成');
});
t('sshd: buildInspectScript 只读且覆盖关键字段', () => {
  const s = buildInspectScript();
  assert.ok(s.includes('sshd'), 'sshd');
  assert.ok(s.includes('-T'), 'sshd -T 取生效值');
  assert.ok(s.includes('effective_pubkey='), 'pubkey 字段');
  assert.ok(s.includes('effective_authorizedkeysfile='), 'authorizedkeysfile 字段');
  assert.ok(s.includes('note "END"'), '结束标记');
  assert.ok(!/>\s*\/etc\/ssh/.test(s), '不得写 /etc/ssh');
});
t('sshd: buildSshdFixScript 写 drop-in + 校验 + 回滚 + 重载', () => {
  const s = buildSshdFixScript({ permitRootLogin: true });
  assert.ok(s.includes(DROPIN_PATH), 'drop-in 路径');
  assert.ok(s.includes("echo 'PubkeyAuthentication yes'"), 'PubkeyAuthentication yes');
  assert.ok(s.includes('PermitRootLogin prohibit-password'), 'root 被拒时補 prohibit-password');
  assert.ok(s.includes('sshd_config.bak'), '备份');
  assert.ok(s.includes('"/usr/sbin/sshd" -t -f "$CFG"') || s.includes('"$SSHD" -t -f "$CFG"'), 'sshd -t 校验');
  assert.ok(s.includes('reason=config-invalid'), '校验失败标记');
  assert.ok(s.includes('systemctl reload sshd'), '重载候选');
  assert.ok(s.includes('restorecon'), 'SELinux 标签修复');
  assert.ok(!s.includes('PasswordAuthentication'), '不碰密码登录');
});
t('sshd: buildSshdFixScript 不强制补 PermitRootLogin', () => {
  const s = buildSshdFixScript({ permitRootLogin: false });
  assert.ok(!s.includes('PermitRootLogin prohibit-password'), '不需要时不加');
});
t('sshd: parseFixOutput 解析 STEP/RESULT', () => {
  const out = [
    'INITNODE_SSHD STEP include-added',
    'INITNODE_SSHD STEP reload=systemctl reload ssh',
    'INITNODE_SSHD STEP effective pubkey=yes permitrootlogin=prohibit-password',
    'INITNODE_SSHD RESULT ok=yes',
  ].join('\n');
  const r = parseFixOutput(out);
  assert.equal(r.ok, true);
  assert.equal(r.reload, 'systemctl reload ssh');
  assert.equal(r.steps.length, 3);
  assert.ok(r.steps[1].includes('已重载'), r.steps[1]);
  assert.equal(parseFixOutput('INITNODE_SSHD RESULT ok=no reason=no-privilege').reason, 'no-privilege');
  assert.equal(parseFixOutput('garbage').ok, false);
});
t('sshd: resolveAuthorizedKeysPaths 展开 %h/%u 与默认值', () => {
  assert.deepEqual(
    resolveAuthorizedKeysPaths('.ssh/authorized_keys .ssh/authorized_keys2', { home: '/root', user: 'root' }),
    ['/root/.ssh/authorized_keys', '/root/.ssh/authorized_keys2'],
  );
  assert.deepEqual(
    resolveAuthorizedKeysPaths('/etc/ssh/keys/%u %h/.ssh/ak', { home: '/home/deploy', user: 'deploy' }),
    ['/etc/ssh/keys/deploy', '/home/deploy/.ssh/ak'],
  );
  assert.deepEqual(
    resolveAuthorizedKeysPaths('', { home: '/root', user: 'root' }),
    ['/root/.ssh/authorized_keys', '/root/.ssh/authorized_keys2'],
  );
  assert.deepEqual(resolveAuthorizedKeysPaths('.ssh/authorized_keys', {}), [], '未知 home 时不给相对路径');
});
t('sshd: buildKeyPathScript 带引号路径 + 带引号 heredoc + 幂等去重', () => {
  const s = buildKeyPathScript(['/etc/ssh/keys/a b', '/root/.ssh/authorized_keys'], 'ssh-ed25519 AAAA test@x');
  assert.ok(s.includes("for P in '/etc/ssh/keys/a b' '/root/.ssh/authorized_keys'; do"), '路径引用');
  assert.ok(s.includes("<<'INITNODE_KEY_EOF'"), '带引号 heredoc(防远端展开)');
  assert.ok(s.includes('grep -qxF "$KEYLINE"'), '幂等去重');
  assert.ok(s.includes('chmod 600'), '权限修正');
  assert.ok(s.includes('reason=key-path-write-failed'), '写入失败上报');
});
t('sshd: 脚本均为纯 POSIX sh(不依赖 bash 语法)', () => {
  for (const s of [buildInspectScript(), buildSshdFixScript({ permitRootLogin: true }), buildKeyPathScript(['/x'], 'k')]) {
    assert.ok(s.startsWith('#!/bin/sh'), 'shebang');
    assert.ok(!/\[\[ /.test(s), '不得使用 [[ ]]');
    assert.ok(!/<<</.test(s), '不得使用 herestring');
  }
});

// ---- args.js(命令行连接信息)----
t('args: user@host + -p', () => {
  const r = parseArgs(['root@192.168.1.123', '-p', '12223']);
  assert.equal(r.error, null);
  assert.deepEqual(r.target, {
    host: '192.168.1.123', user: 'root', port: 12223, identityFile: null,
  });
});
t('args: 只给地址 → 端口 22 / 用户 root', () => {
  const r = parseArgs(['192.168.1.5']);
  assert.deepEqual(r.target, { host: '192.168.1.5', user: 'root', port: 22, identityFile: null });
});
t('args: -l 覆盖 user@、支持 --port=', () => {
  const r = parseArgs(['-l', 'deploy', 'root@h.example', '--port=2200']);
  assert.deepEqual(r.target, { host: 'h.example', user: 'deploy', port: 2200, identityFile: null });
});
t('args: IPv6 方括号 + -i 私钥', () => {
  const r = parseArgs(['admin@[2001:db8::1]', '-i', '~/.ssh/k']);
  assert.equal(r.target.host, '2001:db8::1');
  assert.equal(r.target.user, 'admin');
  assert.equal(r.target.identityFile, '~/.ssh/k');
});
t('args: 未给地址 → target 为 null,端口进 overrides', () => {
  const r = parseArgs(['-p', '12223']);
  assert.equal(r.target, null);
  assert.equal(r.overrides.port, 12223);
});
t('args: 非法输入均报错', () => {
  assert.match(parseArgs(['h', '-p', '70000']).error, /invalid port/);
  assert.match(parseArgs(['h', '-p']).error, /requires an argument/);
  assert.match(parseArgs(['-Z', 'h']).error, /unrecognized option/);
  assert.match(parseArgs(['h1', 'h2']).error, /unexpected argument/);
  assert.match(parseArgs(['-l', '', 'h']).error, /requires an argument/);
});
t('args: -V / -h 标记', () => {
  assert.equal(parseArgs(['-V']).version, true);
  assert.equal(parseArgs(['--version', 'h']).version, true);
  assert.equal(parseArgs(['-h']).help, true);
});

console.log(`\n[unit] ${passed} 项通过${process.exitCode ? '(存在失败)' : ''}`);