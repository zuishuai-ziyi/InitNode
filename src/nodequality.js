// NodeQuality 节点质量检测:在远端以 PTY 运行 bash <(curl -sL https://run.NodeQuality.com),
// 实时回显输出,最后提取报告链接。
import { execInteractive } from './ssh.js';

// 远端缺 bash/curl 时先尽力安装(debian/ubuntu 用 apt,alpine 用 apk,centos 用 yum/dnf)。
const PRECHECK = [
  'command -v bash >/dev/null 2>&1 || { echo "[initnode] 安装 bash..."; apt-get install -y -qq bash 2>/dev/null || apk add --no-cache bash 2>/dev/null || yum install -y -q bash 2>/dev/null || dnf install -y -q bash 2>/dev/null; }',
  'command -v curl >/dev/null 2>&1 || { echo "[initnode] 安装 curl..."; apt-get install -y -qq curl 2>/dev/null || apk add --no-cache curl 2>/dev/null || yum install -y -q curl 2>/dev/null || dnf install -y -q curl 2>/dev/null; }',
  'echo "[initnode] 启动 NodeQuality(约 5-15 分钟,输出为实时结果,Ctrl-C 可中断)..."',
].join('\n');

export function extractReportUrl(output) {
  const m = output.match(/https?:\/\/(?:www\.)?nodequality\.com\/r\/[A-Za-z0-9_-]+/i);
  return m ? m[0] : null;
}

// 返回 { code, reportUrl }
export async function runNodeQuality(conn) {
  // 外层用 bash -c 包裹:登录 shell 可能是 ash/dash,不支持 <(...) 过程替换。
  const cmd = `${PRECHECK}\nbash -c 'bash <(curl -sL https://run.NodeQuality.com)'`;
  const { code, output } = await execInteractive(conn, cmd, {
    timeoutMs: 45 * 60 * 1000,
  });
  return { code, reportUrl: extractReportUrl(output) };
}
