// 最小示例：插件怎么读写**自己的数据目录**
//
// 关键点只有一条：**`fs` 的作用域就是这个插件的数据目录**。
//   · 写相对路径 `'counter.txt'` → 宿主解析成 `<dataDir>/counter.txt`
//   · 写绝对路径或 `../` → 越界，`PATH_OUT_OF_SCOPE`（不是"被静默改写"）
//   · 父目录不存在时宿主会补建——但**仅当最近的已存在祖先确实在本插件数据目录内**
//
// 数据目录由宿主创建并保证存在，插件不需要（也无法）自己 mkdir 一个"家"。
import { fs } from '@host/api';

const COUNTER_FILE = 'counter.txt';

export async function init(ctx) {
  // ctx.dataDir 是**只读事实**（沙箱侧 deepFreeze），仅用于打日志/自查
  ctx.logger.info(`数据目录：${ctx.dataDir}`);

  // ① 读：相对路径按数据目录解析
  let count = 0;
  try {
    const r = fs.read(COUNTER_FILE);
    count = Number.parseInt(r.content.trim(), 10) || 0;
    ctx.logger.info(`读到计数 = ${count}（${r.bytes} 字节）`);
  } catch (e) {
    // 首次运行时文件还不存在。按 code 分支，不要匹配文案。
    ctx.logger.info(`没有读到 ${COUNTER_FILE}（code=${e.code}），从 0 开始`);
  }

  // ② 迭代 +1
  count += 1;

  // ③ 写回（覆盖语义）。返回值带实际落盘路径与字节数——可核对作用域解析结果
  const w = fs.write(COUNTER_FILE, `${count}\n`);
  ctx.logger.info(`写回 ${count} → ${w.path}（${w.bytes} 字节）`);

  // ④ 列目录：看看"自己的目录"里到底有什么
  const listed = fs.list('.');
  ctx.logger.info(
    `目录内容：${listed.entries.map((e) => `${e.name}(${e.type},${e.size}B)`).join(', ') || '(空)'}`,
  );
}
