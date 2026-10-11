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

console.log(`\n[unit] ${passed} 项通过${process.exitCode ? '(存在失败)' : ''}`);
