// 标签(Tags)处理:Komari 的 tags 是单个字符串,多标签用 ";" 分隔
// (模型定义:Tags string `json:"tags"` // split by ';')

// 把用户输入归一化为 Komari tags 字符串:"香港, 测试；cn" -> "香港;测试;cn"
export function normalizeTags(input) {
  const seen = [];
  for (const part of String(input || '').split(/[,，;；、|]+/)) {
    const t = part.trim();
    if (t && !seen.includes(t)) seen.push(t);
  }
  return seen.join(';');
}

// 解析用户标签输入:
//   - 空输入 -> ''
//   - 全为数字且落在模板范围内 -> 按编号取模板(如 "1 3")
//   - 其他 -> 视为自定义文本,按分隔符归一化
export function parseTagInput(raw, templates = []) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const tokens = s.split(/[\s,，;；、|]+/).filter(Boolean);
  const allNumeric = tokens.length > 0 && tokens.every((t) => /^\d+$/.test(t));
  if (allNumeric && tokens.every((t) => Number(t) >= 1 && Number(t) <= templates.length)) {
    return normalizeTags(tokens.map((t) => templates[Number(t) - 1]).join(';'));
  }
  return normalizeTags(s);
}

// 从已注册节点推导常用标签模板:
//   - 节点名按惯例是 "厂商 - 地区 - IP尾段",拆出各段
//   - 已设置的 tags 值也作为模板
//   - 丢弃纯数字/IP 形态的尾段(如 "192"、"2404")
export function deriveTagTemplates(clients = []) {
  const out = [];
  const push = (s) => {
    const t = String(s || '').trim();
    if (t && !out.includes(t) && !/^[0-9.:\[\]]+$/.test(t)) out.push(t);
  };
  for (const c of clients) {
    for (const seg of String(c.name || '').split(' - ')) push(seg);
    for (const t of String(c.tags || '').split(';')) push(t);
  }
  return out;
}
