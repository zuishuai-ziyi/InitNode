// sshd 侧公钥登录的自动启用:只读诊断 → 受控修改(备份/校验/回滚)→ 重载 → 复验。
//
// 触发场景:服务器 sshd_config(或 drop-in)写了 PubkeyAuthentication no / PermitRootLogin no,
// 导致 authorized_keys 明明写好了、公钥登录仍被拒(客户端只看到 "All configured
// authentication methods failed")。
//
// 修改策略(全部可回滚,不碰 PasswordAuthentication):
//   1. 主配置缺 `Include /etc/ssh/sshd_config.d/*.conf` 时补到文件头
//   2. 写 /etc/ssh/sshd_config.d/00-initnode-pubkey.conf:
//        PubkeyAuthentication yes
//        PermitRootLogin prohibit-password   (仅当 root 被 PermitRootLogin no 挡住时)
//      sshd 对多数关键字采用「首次出现的值生效」,Include 在文件头 → 该 drop-in 生效
//   3. sshd -t 校验;失败则还原备份并删除 drop-in,绝不留坏配置
//   4. systemctl/service reload(不断开现有连接);都失败才尝试 restart
//   5. 顺手修 home/.ssh 权限与 SELinux 标签(常见的 "bad ownership or modes" 拒绝原因)
//   6. sshd -T 复验 pubkeyauthentication=yes
//
// 另:AuthorizedKeysFile 被改成非 ~/.ssh/authorized_keys 时,把公钥补写到实际路径
// (第 5 步写入的文件对 sshd 无效,这是另一类「配置看着对但登不上」)。
//
// 脚本统一用 `sh -s -- <tag>` 执行(纯 POSIX,不依赖 bash)。
import { execSSH } from './ssh.js';

export const MARK = 'INITNODE_SSHD';
export const DROPIN_PATH = '/etc/ssh/sshd_config.d/00-initnode-pubkey.conf';
const DEFAULT_AUTHORIZED_KEYS_FILE = '.ssh/authorized_keys .ssh/authorized_keys2';

// POSIX shell 单引号转义
export function shQuote(value) {
  return `'${String(value).split("'").join("'\\''")}'`;
}

// ---------- 只读诊断 ----------
export function buildInspectScript() {
  return [
    '#!/bin/sh',
    '# initnode: 只读读取 sshd 公钥登录相关配置(不修改任何文件)',
    'set -u',
    `M=${MARK}`,
    'note() { echo "$M $*"; }',
    'SSHD=$(command -v sshd 2>/dev/null || true)',
    '[ -n "$SSHD" ] || SSHD=/usr/sbin/sshd',
    'CFG=/etc/ssh/sshd_config',
    'PV=no',
    'if [ "$(id -u)" = 0 ]; then PV=root',
    'elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then PV=sudo',
    'fi',
    'HOME_DIR=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)',
    'if [ -z "${HOME_DIR:-}" ]; then HOME_DIR=$(awk -F: -v u="$(id -un)" \'$1==u {print $6; exit}\' /etc/passwd 2>/dev/null); fi',
    '[ -n "${HOME_DIR:-}" ] || HOME_DIR=${HOME:-}',
    'EFF=',
    'case "$PV" in',
    '  root) EFF=$("$SSHD" -T 2>/dev/null) ;;',
    '  sudo) EFF=$(sudo -n "$SSHD" -T 2>/dev/null) ;;',
    'esac',
    'pick() { echo "$EFF" | awk -v k="$1" \'tolower($1)==k { $1=""; sub(/^[ \\t]+/,""); print; exit }\'; }',
    'readcfg() {',
    '  case "$PV" in',
    '    root) cat "$CFG" 2>/dev/null ;;',
    '    sudo) sudo -n cat "$CFG" 2>/dev/null ;;',
    '    *) cat "$CFG" 2>/dev/null ;;',
    '  esac',
    '}',
    'CFGT=$(readcfg)',
    'inc=no',
    'echo "$CFGT" | grep -qE \'^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\\.d/\' && inc=yes',
    'drop=no',
    `[ -f ${DROPIN_PATH} ] && drop=yes`,
    'rawpk=no',
    'echo "$CFGT" | grep -qiE \'^[[:space:]]*PubkeyAuthentication[[:space:]]+no\' && rawpk=yes',
    'rawroot=no',
    'echo "$CFGT" | grep -qiE \'^[[:space:]]*PermitRootLogin[[:space:]]+no\' && rawroot=yes',
    'note "priv=$PV"',
    'note "home=$HOME_DIR"',
    'note "sshd=$SSHD"',
    'note "config=$CFG"',
    'note "include=$inc"',
    'note "dropin=$drop"',
    'note "raw_pubkey_no=$rawpk"',
    'note "raw_root_no=$rawroot"',
    'note "effective_pubkey=$(pick pubkeyauthentication)"',
    'note "effective_password=$(pick passwordauthentication)"',
    'note "effective_permitrootlogin=$(pick permitrootlogin)"',
    'note "effective_authorizedkeysfile=$(pick authorizedkeysfile)"',
    'note "effective_authenticationmethods=$(pick authenticationmethods)"',
    'note "effective_allowusers=$(pick allowusers)"',
    'note "effective_denyusers=$(pick denyusers)"',
    'note "effective_allowgroups=$(pick allowgroups)"',
    'note "effective_denygroups=$(pick denygroups)"',
    'note "selinux=$(command -v getenforce >/dev/null 2>&1 && getenforce 2>/dev/null || echo none)"',
    'note "END"',
    '',
  ].join('\n');
}

// 解析诊断输出。known=false 表示根本没读到 sshd 配置(无权限/无 sshd/非 Linux)。
export function parseInspect(stdout) {
  const kv = {};
  let known = false;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.startsWith(`${MARK} `)) continue;
    const body = line.slice(MARK.length + 1).trim();
    if (body === 'END') { known = true; continue; }
    if (!/^[a-z_]+=/.test(body)) continue;
    const eq = body.indexOf('=');
    kv[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return {
    known,
    priv: kv.priv || null,
    home: kv.home || '',
    sshdPath: kv.sshd || '',
    configPath: kv.config || '/etc/ssh/sshd_config',
    include: kv.include === 'yes',
    dropin: kv.dropin === 'yes',
    rawPubkeyNo: kv.raw_pubkey_no === 'yes',
    rawRootNo: kv.raw_root_no === 'yes',
    pubkey: kv.effective_pubkey || null,
    password: kv.effective_password || null,
    permitRootLogin: kv.effective_permitrootlogin || null,
    authorizedKeysFile: kv.effective_authorizedkeysfile || DEFAULT_AUTHORIZED_KEYS_FILE,
    authenticationMethods: kv.effective_authenticationmethods || '',
    allowUsers: kv.effective_allowusers || '',
    denyUsers: kv.effective_denyusers || '',
    allowGroups: kv.effective_allowgroups || '',
    denyGroups: kv.effective_denygroups || '',
    selinux: kv.selinux || 'none',
  };
}

export async function inspectSshd(conn) {
  const r = await execSSH(conn, 'sh -s -- initnode-sshd-inspect', {
    input: buildInspectScript(),
    timeoutMs: 60_000,
  });
  const state = parseInspect(r.stdout);
  state.exitCode = r.code;
  state.stderr = r.stderr;
  return state;
}

// ---------- 修改:写入 drop-in + 校验 + 重载 + 复验 ----------
// permitRootLogin=true 时追加 PermitRootLogin prohibit-password(仅 root 被 no 挡住时)。
export function buildSshdFixScript({ permitRootLogin = false } = {}) {
  return [
    '#!/bin/sh',
    '# initnode: 启用 sshd 公钥登录(drop-in → 校验 → 重载 → 复验;任一失败自动回滚)',
    'set -u',
    `M=${MARK}`,
    'note() { echo "$M $*"; }',
    "SUDO=''",
    'if [ "$(id -u)" != 0 ]; then',
    '  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"; else',
    '    note "RESULT ok=no reason=no-privilege"',
    '    exit 0',
    '  fi',
    'fi',
    'SSHD=$(command -v sshd 2>/dev/null || true)',
    '[ -n "$SSHD" ] || SSHD=/usr/sbin/sshd',
    'CFG=/etc/ssh/sshd_config',
    'DDIR=/etc/ssh/sshd_config.d',
    `DROPIN=${DROPIN_PATH}`,
    'HOME_DIR=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)',
    'if [ -z "${HOME_DIR:-}" ]; then HOME_DIR=$(awk -F: -v u="$(id -un)" \'$1==u {print $6; exit}\' /etc/passwd 2>/dev/null); fi',
    '[ -n "${HOME_DIR:-}" ] || HOME_DIR=${HOME:-}',
    'if [ ! -f "$CFG" ]; then note "RESULT ok=no reason=no-sshd-config"; exit 0; fi',
    'TMPD=$(mktemp -d 2>/dev/null || true)',
    'if [ -z "${TMPD:-}" ] || [ ! -d "$TMPD" ]; then TMPD=/tmp/initnode-sshd-$$; mkdir -p "$TMPD" || exit 1; fi',
    "trap 'rm -rf \"$TMPD\"' EXIT",
    'if ! $SUDO cp -a "$CFG" "$TMPD/sshd_config.bak"; then note "RESULT ok=no reason=backup-failed"; exit 0; fi',
    'HAD_DROPIN=no',
    'if [ -f "$DROPIN" ]; then $SUDO cp -a "$DROPIN" "$TMPD/dropin.bak" && HAD_DROPIN=yes; fi',
    '',
    '# 1) 主配置必须 include drop-in(sshd 关键字首次出现的值生效,include 在文件头才压得住后面写的 no)',
    'if ! $SUDO sh -c "grep -qE \'^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\\.d/\' \'$CFG\'"; then',
    '  { echo \'Include /etc/ssh/sshd_config.d/*.conf\'; $SUDO cat "$CFG"; } > "$TMPD/newcfg" \\',
    '    && $SUDO cp "$TMPD/newcfg" "$CFG" && note "STEP include-added"',
    'fi',
    '',
    '# 2) 写入 drop-in',
    '{',
    '  echo \'# managed by initnode: 允许公钥登录(删除本文件即可回滚)\'',
    '  echo \'PubkeyAuthentication yes\'',
    permitRootLogin ? "  echo 'PermitRootLogin prohibit-password'" : '  : # 无需改动 PermitRootLogin',
    '} > "$TMPD/dropin"',
    '$SUDO mkdir -p "$DDIR" && $SUDO cp "$TMPD/dropin" "$DROPIN" && note "STEP dropin-written"',
    '',
    '# 3) 校验,失败立即回滚',
    'if $SUDO "$SSHD" -t -f "$CFG" > "$TMPD/check.log" 2>&1; then',
    '  note "STEP validated"',
    'else',
    '  $SUDO cp "$TMPD/sshd_config.bak" "$CFG"',
    '  if [ "$HAD_DROPIN" = yes ]; then $SUDO cp "$TMPD/dropin.bak" "$DROPIN"; else $SUDO rm -f "$DROPIN"; fi',
    '  note "RESULT ok=no reason=config-invalid"',
    '  head -n 3 "$TMPD/check.log" 2>/dev/null | while IFS= read -r l; do note "ERR $l"; done',
    '  exit 0',
    'fi',
    '',
    '# 4) 重载(不中断现有连接);都失败才 restart',
    'RELOAD=none',
    "for c in 'systemctl reload sshd' 'systemctl reload ssh' 'service sshd reload' 'service ssh reload' 'systemctl restart sshd' 'systemctl restart ssh'; do",
    '  if $SUDO sh -c "$c" >/dev/null 2>&1; then RELOAD="$c"; break; fi',
    'done',
    'note "STEP reload=$RELOAD"',
    '',
    '# 5) 权限与 SELinux 标签(常见的「公钥被拒」原因)',
    'if [ -n "$HOME_DIR" ] && [ -d "$HOME_DIR" ]; then',
    '  $SUDO chmod go-w "$HOME_DIR" 2>/dev/null || true',
    '  if [ -d "$HOME_DIR/.ssh" ]; then',
    '    $SUDO chmod 700 "$HOME_DIR/.ssh" 2>/dev/null || true',
    '    if [ -f "$HOME_DIR/.ssh/authorized_keys" ]; then $SUDO chmod 600 "$HOME_DIR/.ssh/authorized_keys" 2>/dev/null || true; fi',
    '  fi',
    '  if command -v restorecon >/dev/null 2>&1; then $SUDO restorecon -R "$HOME_DIR/.ssh" >/dev/null 2>&1 || true; fi',
    '  note "STEP perms-checked"',
    'fi',
    '',
    '# 6) 复验生效值',
    'EFF=$($SUDO "$SSHD" -T -f "$CFG" 2>/dev/null)',
    'PK=$(echo "$EFF" | awk \'tolower($1)=="pubkeyauthentication" {print $2; exit}\')',
    'RL=$(echo "$EFF" | awk \'tolower($1)=="permitrootlogin" {print $2; exit}\')',
    'note "STEP effective pubkey=${PK:-unknown} permitrootlogin=${RL:-unknown}"',
    'if [ "${PK:-}" = yes ]; then',
    '  note "RESULT ok=yes"',
    'else',
    '  note "RESULT ok=no reason=not-applied"',
    'fi',
    '',
  ].join('\n');
}

// 解析修复脚本输出:RESULT ok=yes|no [reason=..] + STEP 记录
export function parseFixOutput(stdout) {
  const steps = [];
  let ok = false;
  let reason = null;
  let reload = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.startsWith(`${MARK} `)) continue;
    const body = line.slice(MARK.length + 1).trim();
    if (body.startsWith('STEP ')) {
      const step = body.slice(5);
      if (step.startsWith('effective ')) steps.push(`生效值: ${step.slice(10)}`);
      else if (step.startsWith('reload=')) {
        reload = step.slice(7);
        steps.push(reload === 'none' ? '重载 sshd 失败(可能需要手动 reload)' : `已重载: ${reload}`);
      } else steps.push(step);
      continue;
    }
    if (body.startsWith('ERR ')) { steps.push(`sshd -t: ${body.slice(4)}`); continue; }
    if (body.startsWith('RESULT ')) {
      for (const part of body.slice(7).split(/\s+/).filter(Boolean)) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const k = part.slice(0, eq);
        const v = part.slice(eq + 1);
        if (k === 'ok') ok = v === 'yes';
        else if (k === 'reason') reason = v;
        else if (k === 'reload') reload = v;
      }
    }
  }
  return { ok, reason, reload, steps };
}

export async function applySshdFix(conn, { permitRootLogin = false } = {}) {
  const r = await execSSH(conn, 'sh -s -- initnode-sshd-fix', {
    input: buildSshdFixScript({ permitRootLogin }),
    timeoutMs: 120_000,
  });
  const parsed = parseFixOutput(r.stdout);
  parsed.exitCode = r.code;
  return parsed;
}

// ---------- AuthorizedKeysFile 指向别处时,把公钥补写到实际路径 ----------
// 展开 sshd 的 %h(home)/%u(用户名)/%%(百分号);相对路径按 home 解析。
export function resolveAuthorizedKeysPaths(value, { home = '', user = '' } = {}) {
  const raw = String(value || DEFAULT_AUTHORIZED_KEYS_FILE).trim().split(/\s+/).filter(Boolean);
  const homeBase = String(home || '').replace(/\/+$/, '');
  const out = [];
  for (const token of raw) {
    const expanded = token
      .split('%h').join(homeBase)
      .split('%u').join(user)
      .split('%%').join('%');
    const abs = expanded.startsWith('/')
      ? expanded
      : (homeBase ? `${homeBase}/${expanded}` : '');
    if (abs && abs.startsWith('/') && !out.includes(abs)) out.push(abs);
  }
  return out;
}

export function buildKeyPathScript(paths, pubkey) {
  const list = paths.map((p) => shQuote(p)).join(' ');
  return [
    '#!/bin/sh',
    '# initnode: 把公钥写到 sshd 实际使用的 AuthorizedKeysFile 路径',
    'set -u',
    `M=${MARK}`,
    'note() { echo "$M $*"; }',
    "SUDO=''",
    'if [ "$(id -u)" != 0 ]; then',
    '  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"; else',
    '    note "RESULT ok=no reason=no-privilege"',
    '    exit 0',
    '  fi',
    'fi',
    'KEYFILE=$(mktemp 2>/dev/null || echo /tmp/initnode-key-$$)',
    'cat > "$KEYFILE" <<\'INITNODE_KEY_EOF\'',
    String(pubkey || '').trimEnd(),
    'INITNODE_KEY_EOF',
    'KEYLINE=$(head -n 1 "$KEYFILE")',
    'FAIL=0',
    `for P in ${list}; do`,
    '  D=$(dirname "$P")',
    '  $SUDO mkdir -p "$D" 2>/dev/null || true',
    '  if [ ! -f "$P" ]; then $SUDO touch "$P" 2>/dev/null || { note "ERR cannot-create $P"; FAIL=1; continue; }; fi',
    '  if $SUDO grep -qxF "$KEYLINE" "$P" 2>/dev/null; then',
    '    note "STEP key-present $P"',
    '  else',
    '    if $SUDO sh -c "cat \'$KEYFILE\' >> \'$P\'" >/dev/null 2>&1; then note "STEP key-appended $P"; else note "ERR cannot-append $P"; FAIL=1; fi',
    '  fi',
    '  $SUDO chmod 600 "$P" 2>/dev/null || true',
    '  if command -v restorecon >/dev/null 2>&1; then $SUDO restorecon "$P" >/dev/null 2>&1 || true; fi',
    'done',
    'rm -f "$KEYFILE" 2>/dev/null || true',
    'if [ "$FAIL" = 0 ]; then note "RESULT ok=yes"; else note "RESULT ok=no reason=key-path-write-failed"; fi',
    '',
  ].join('\n');
}

// 返回 true 表示至少写入了一个非标准路径
export async function appendKeyToPaths(conn, paths, pubkey) {
  const r = await execSSH(conn, 'sh -s -- initnode-sshd-keypaths', {
    input: buildKeyPathScript(paths, pubkey),
    timeoutMs: 60_000,
  });
  return String(r.stdout || '').includes(`${MARK} STEP key-appended `);
}

// ---------- 编排:诊断 → 按需修复 → 复验 ----------
// 返回 { ok, already, unknown, reason, steps, before, after, authorizedKeysPaths }
export async function ensurePubkeyAuth(conn, { user = 'root', pubkey = '' } = {}) {
  const before = await inspectSshd(conn);
  if (!before.known) {
    return {
      ok: false,
      already: false,
      unknown: true,
      reason: '读不到 sshd 配置(无 root/免密 sudo 权限,或系统没有 sshd)',
      steps: [],
      before,
      after: before,
      authorizedKeysPaths: [],
    };
  }

  const needPubkey = before.pubkey !== 'yes';
  const needRoot = user === 'root' && before.permitRootLogin === 'no';
  const authorizedKeysPaths = resolveAuthorizedKeysPaths(before.authorizedKeysFile, {
    home: before.home,
    user,
  });
  const standardPath = before.home ? `${before.home.replace(/\/+$/, '')}/.ssh/authorized_keys` : '';
  const needExtraPaths = Boolean(pubkey)
    && authorizedKeysPaths.length > 0
    && !authorizedKeysPaths.includes(standardPath);

  if (!needPubkey && !needRoot && !needExtraPaths) {
    return {
      ok: true, already: true, unknown: false, reason: null, steps: [],
      before, after: before, authorizedKeysPaths,
    };
  }

  const steps = [];
  let fix = null;
  let ok = true;
  let reason = null;

  if (needPubkey || needRoot) {
    fix = await applySshdFix(conn, { permitRootLogin: needRoot });
    steps.push(...fix.steps);
    if (!fix.ok) { ok = false; reason = fix.reason || 'sshd 配置未生效'; }
  }

  if (needExtraPaths) {
    const appended = await appendKeyToPaths(conn, authorizedKeysPaths, pubkey);
    steps.push(appended
      ? `AuthorizedKeysFile 指向 ${authorizedKeysPaths.join(', ')},已补写公钥`
      : `AuthorizedKeysFile 指向 ${authorizedKeysPaths.join(', ')}(公钥已存在或写入失败)`);
  }

  const after = await inspectSshd(conn);
  if (after.known) {
    const pubkeyOk = after.pubkey === 'yes';
    const rootOk = !(user === 'root' && after.permitRootLogin === 'no');
    if (!pubkeyOk || !rootOk) {
      ok = false;
      reason = reason || (pubkeyOk ? 'root 仍被 PermitRootLogin no 禁止登录' : 'pubkeyauthentication 仍为 no');
    }
  }

  return { ok, already: false, unknown: false, reason, steps, fix, before, after, authorizedKeysPaths };
}
