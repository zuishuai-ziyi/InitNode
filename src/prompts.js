// 交互式问询封装:文本输入(带默认值)、密码(隐藏回显)、确认、编号选择。
// 读行采用队列模式:stdin 中先于提问到达的行会被缓存,不会丢失(便于管道/脚本化)。
import readline from 'node:readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

rl.on('SIGINT', () => {
  process.stdout.write('\n已取消。\n');
  process.exit(130);
});

// 行队列:提问间隙到达的行不丢失
const lineQueue = [];
const lineWaiters = [];
rl.on('line', (line) => {
  if (lineWaiters.length > 0) lineWaiters.shift()(line);
  else lineQueue.push(line);
});

function nextLine() {
  if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift());
  return new Promise((resolve) => lineWaiters.push(resolve));
}

export function ask(question, { def = '' } = {}) {
  const suffix = def !== '' ? ` [${def}]` : '';
  process.stdout.write(`${question}${suffix}: `);
  return nextLine().then((answer) => {
    const trimmed = answer.trim();
    return trimmed === '' ? String(def) : trimmed;
  });
}

export async function askInt(question, def) {
  for (;;) {
    const raw = await ask(question, { def: String(def) });
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    console.log('  ! 请输入有效端口 (1-65535)');
  }
}

export async function askPassword(question) {
  process.stdout.write(`${question}: `);
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true; // 隐藏回显
  try {
    return await nextLine();
  } finally {
    process.stdout.write = originalWrite;
    originalWrite('\n');
  }
}

export async function confirm(question, def = true) {
  const hint = def ? '[Y/n]' : '[y/N]';
  const a = (await ask(`${question} ${hint}`)).trim().toLowerCase();
  if (a === '') return def;
  return a === 'y' || a === 'yes' || a === '是';
}

// 选择: options = [{ label, value }], 返回 value
export async function choose(question, options) {
  console.log(question);
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt.label}`));
  for (;;) {
    const raw = await ask('选择', { def: '1' });
    const idx = Number.parseInt(raw, 10);
    if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) {
      return options[idx - 1].value;
    }
    console.log(`  ! 请输入 1-${options.length}`);
  }
}

// 交给交互式远端程序(如 NodeQuality)前关闭 readline,避免抢占 stdin。
export function close() {
  rl.close();
  // rl.close() 会把 stdin 置于 paused 且不再恢复;必须显式 resume,
  // 否则后续把 stdin 让给远端交互(如 NodeQuality PTY)时一个字节都收不到。
  process.stdin.resume();
}

export function print(msg) {
  console.log(msg);
}
