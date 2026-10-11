// Komari 面板 API 封装(适配 komari 1.5.x):
//   GET  /api/admin/settings/            -> data.auto_discovery_key(自动发现密钥)
//   POST /api/clients/register?name=<n>  -> data.{uuid,token}(Bearer <AD key>;服务端会加 "Auto-" 前缀)
//   POST /api/admin/client/:uuid/edit    -> 部分更新(改回真实节点名)
//   GET  /api/admin/client/list          -> Client[](updated_at 可判断 agent 是否已上报)
const UA = 'initnode/0.1';

async function request(url, { method = 'GET', headers = {}, body, okStatus = 200 } = {}) {
  let resp;
  try {
    resp = await fetch(url, { method, headers: { 'User-Agent': UA, ...headers }, body });
  } catch (err) {
    throw new Error(`无法访问 Komari (${url}): ${err.cause?.message || err.message}`);
  }
  const text = await resp.text();
  if (resp.status !== okStatus) {
    throw new Error(`Komari 返回 HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Komari 返回非 JSON 响应: ${text.slice(0, 200)}`);
  }
}

const admin = (endpoint, adminApiKey) => ({
  Authorization: `Bearer ${adminApiKey}`,
  'Content-Type': 'application/json',
  endpoint,
});

// 验证 admin key 并顺带拿自动发现密钥。返回 { autoDiscoveryKey, siteName }
export async function fetchAutoDiscoveryKey(endpoint, adminApiKey) {
  const data = await request(`${endpoint}/api/admin/settings/`, { headers: admin(endpoint, adminApiKey) });
  const d = data?.data || {};
  return { autoDiscoveryKey: d.auto_discovery_key || '', siteName: d.website_name || '' };
}

// 自动发现注册:返回 { uuid, token }。注意服务端把名字存为 "Auto-<name>"。
export async function registerClient(endpoint, autoDiscoveryKey, name) {
  const data = await request(
    `${endpoint}/api/clients/register?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${autoDiscoveryKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key: autoDiscoveryKey }),
    },
  );
  if (data?.status !== 'success' || !data?.data?.uuid || !data?.data?.token) {
    throw new Error(`自动发现注册失败: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.data; // { uuid, token }
}

// 修正节点名/写入标签(部分更新;tags 为分号分隔的字符串,传空串清除)。
export function updateClient(endpoint, adminApiKey, uuid, fields) {
  return request(`${endpoint}/api/admin/client/${uuid}/edit`, {
    method: 'POST',
    headers: admin(endpoint, adminApiKey),
    body: JSON.stringify(fields),
  });
}

// 兼容旧调用:仅改名
export function renameClient(endpoint, adminApiKey, uuid, name) {
  return updateClient(endpoint, adminApiKey, uuid, { name });
}

// 已注册节点列表(admin)
export async function fetchClients(endpoint, adminApiKey) {
  const data = await request(`${endpoint}/api/admin/client/list`, { headers: admin(endpoint, adminApiKey) });
  return Array.isArray(data) ? data : [];
}

// 等待 agent 上线:轮询 admin client 列表,updated_at 晚于 since 视为已上报。
export async function waitForOnline(endpoint, adminApiKey, uuid, since, { timeoutMs = 180_000, intervalMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await fetchClients(endpoint, adminApiKey);
    const me = list.find((c) => c.uuid === uuid);
    if (me) {
      const updated = Date.parse(me.updated_at || '');
      if (Number.isFinite(updated) && updated >= since - 30_000) return me;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待节点上线超时(${timeoutMs / 1000}s):agent 可能未连上 Komari,请到面板检查`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
