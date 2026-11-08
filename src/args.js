// 命令行参数解析(纯函数,便于单元测试)。
// 支持直接给出连接信息,写法对齐 ssh 的常见习惯:
//   initnode root@192.168.1.123 -p 12223
//   initnode 192.168.1.123 -l deploy -p 2222 -i ~/.ssh/id_ed25519
//   initnode -p 12223              // 只预设端口,地址仍交互问询
// 未给地址时 target 为 null,由交互流程补齐。

export const DEFAULT_PORT = 22;
export const DEFAULT_USER = 'root';

// "[user@][host]" 或 "[user@][[v6]]" → { user, host }
export function parseTarget(spec, { user: flagUser = null } = {}) {
  const at = spec.lastIndexOf('@');
  let user = flagUser;
  let host = spec;
  if (at >= 0) {
    const u = spec.slice(0, at);
    if (!flagUser && u) user = u;
    host = spec.slice(at + 1);
  }
  host = host.trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return { host, user: user || DEFAULT_USER };
}

function isValidPort(v) {
  return /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;
}

// argv → { help, version, error, target, overrides }
//   target    : 给出了地址时的连接信息 { user, host, port, identityFile }
//   overrides : 没给地址时,命令行打偏的端口/用户/私钥(供交互问询问出默认值)
export function parseArgs(argv) {
  const out = { help: false, version: false, error: null, target: null };
  const overrides = { port: null, user: null, identityFile: null };
  let spec = null;
  let endOfOpts = false;

  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline; // --opt=value 形式的值
    if (!endOfOpts && a === '--') {
      endOfOpts = true;
      continue;
    }
    if (!endOfOpts && a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
    }

    const takeValue = () => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      return v === undefined ? null : v;
    };

    if (!endOfOpts && (a === '-h' || a === '--help')) {
      out.help = true;
    } else if (!endOfOpts && (a === '-V' || a === '--version')) {
      out.version = true;
    } else if (!endOfOpts && (a === '-p' || a === '--port')) {
      const v = takeValue();
      if (v === null) return { ...out, overrides, error: `option '${a}' requires an argument` };
      if (!isValidPort(v)) return { ...out, overrides, error: `invalid port '${v}' (1-65535)` };
      overrides.port = Number(v);
    } else if (!endOfOpts && (a === '-l' || a === '--user')) {
      const v = takeValue();
      if (v === null || !v) return { ...out, overrides, error: `option '${a}' requires an argument` };
      overrides.user = v;
    } else if (!endOfOpts && (a === '-i' || a === '--identity')) {
      const v = takeValue();
      if (v === null || !v) return { ...out, overrides, error: `option '${a}' requires an argument` };
      overrides.identityFile = v;
    } else if (!endOfOpts && a.startsWith('-') && a !== '-') {
      return { ...out, overrides, error: `unrecognized option '${a}'` };
    } else if (spec === null) {
      spec = a;
    } else {
      return { ...out, overrides, error: `unexpected argument '${a}'` };
    }
  }

  if (spec !== null) {
    const { host, user } = parseTarget(spec, { user: overrides.user });
    if (!host) return { ...out, overrides, error: `missing host in '${spec}'` };
    out.target = {
      host,
      user,
      port: overrides.port === null ? DEFAULT_PORT : overrides.port,
      identityFile: overrides.identityFile,
    };
  }
  out.overrides = overrides;
  return out;
}
