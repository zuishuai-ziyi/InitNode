// 配置持久化:config.json(与 package.json 同目录,已被 .gitignore 排除)。
// 存放 Komari endpoint 与 admin API Key;自动发现密钥可自动从 settings 接口拉取。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, askPassword } from './prompts.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// INITNODE_CONFIG 环境变量用于测试重定向。
export const CONFIG_PATH = process.env.INITNODE_CONFIG || path.join(ROOT, 'config.json');

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// 确保 komari 配置就绪(endpoint + adminApiKey),并顺带验证 admin key 可用。
// 返回 { endpoint, adminApiKey, autoDiscoveryKey }(autoDiscoveryKey 可为空字符串,由 komari.js 现场拉取)。
export async function ensureKomariConfig(cfg) {
  cfg.komari ||= {};
  let { endpoint = '', adminApiKey = '', autoDiscoveryKey = '' } = cfg.komari;
  let changed = false;

  if (!endpoint) {
    endpoint = await ask('Komari 面板地址', { def: 'https://komari.zyhome.xiaoziyi.com' });
    changed = true;
  }
  if (!adminApiKey) {
    printHint('需要 Komari 管理员 API Key(WebUI -> 个人设置/安全 中创建,格式 komari-xxxx)。');
    printHint('用于:读取自动发现密钥、注册后修正节点名、确认节点上线。');
    adminApiKey = await askPassword('Komari admin API Key');
    changed = true;
  }

  if (changed) {
    cfg.komari = { ...cfg.komari, endpoint, adminApiKey, autoDiscoveryKey };
    saveConfig(cfg);
  }
  return { endpoint: endpoint.replace(/\/+$/, ''), adminApiKey, autoDiscoveryKey };
}

function printHint(msg) {
  console.log(`  \x1b[2m${msg}\x1b[0m`);
}
