// `path.win32` 的**共用测试用例**（Windows 判卷人与沙箱 shim 各跑一遍，再逐条比）
//
// 覆盖重点（都是"照着直觉写就会错"的地方）：
//   · 盘符 / UNC 根 / `\\?\` 长路径前缀 / `\\.\` 设备根 —— `resolve`/`normalize`/`dirname`/`parse` 各一套；
//   · **保留设备名**（`CON`/`NUL`/`COM1`，含 `C:CON` 这种带盘符的写法）—— `join` 里还有一处"跳过 normalize"的特判；
//   · `normalize` 的**冒名绝对路径补偿**（`a:C:`、`x:y:z`、`C:` 这些相对写法不能变成绝对路径）；
//   · 两种分隔符混用（`/` 与 `\` 都算分隔符）；
//   · `relative` 的"同路径不同大小写"（Windows 不敏感）与跨盘符；
//   · `basename`/`extname` 对 `..`、`.`、尾随分隔符的边角；
//   · `toNamespacedPath` 的 UNC 与非 UNC 两条分支。
//
// 约定：每个用例 = `{ id, fn, args }`；`fn` 是 `path.win32` 上的方法名。
export default [
  // ── resolve ──
  { id: 'resolve.empty', fn: 'resolve', args: [] },
  { id: 'resolve.dot', fn: 'resolve', args: ['.'] },
  { id: 'resolve.rel', fn: 'resolve', args: ['a\\b'] },
  { id: 'resolve.rel-slash', fn: 'resolve', args: ['a/b'] },
  { id: 'resolve.abs-drive', fn: 'resolve', args: ['C:\\x\\..\\y'] },
  { id: 'resolve.abs-forward', fn: 'resolve', args: ['C:/x/y'] },
  { id: 'resolve.drive-only', fn: 'resolve', args: ['C:'] },
  { id: 'resolve.drive-rel', fn: 'resolve', args: ['C:a'] },
  { id: 'resolve.other-drive', fn: 'resolve', args: ['D:\\z'] },
  { id: 'resolve.root-only', fn: 'resolve', args: ['\\'] },
  { id: 'resolve.unc', fn: 'resolve', args: ['\\\\server\\share\\a\\..\\b'] },
  { id: 'resolve.unc-root-only', fn: 'resolve', args: ['\\\\server\\share'] },
  { id: 'resolve.device', fn: 'resolve', args: ['\\\\.\\PHYSICALDRIVE0'] },
  { id: 'resolve.long-prefix', fn: 'resolve', args: ['\\\\?\\C:\\x\\y'] },
  { id: 'resolve.multi', fn: 'resolve', args: ['C:\\a', 'b', '..', 'c'] },
  { id: 'resolve.multi-abs-wins', fn: 'resolve', args: ['C:\\a', 'D:\\b'] },
  { id: 'resolve.up-above-root', fn: 'resolve', args: ['C:\\..\\..\\a'] },
  { id: 'resolve.empty-seg', fn: 'resolve', args: [''] },
  { id: 'resolve.slash-only', fn: 'resolve', args: ['/'] },
  { id: 'resolve.reserved', fn: 'resolve', args: ['CON'] },
  { id: 'resolve.reserved-drive', fn: 'resolve', args: ['C:CON'] },

  // ── normalize ──
  { id: 'normalize.empty', fn: 'normalize', args: [''] },
  { id: 'normalize.single-slash', fn: 'normalize', args: ['/'] },
  { id: 'normalize.single-letter', fn: 'normalize', args: ['a'] },
  { id: 'normalize.dots', fn: 'normalize', args: ['C:\\a\\..\\..\\b'] },
  { id: 'normalize.trailing', fn: 'normalize', args: ['C:\\a\\b\\'] },
  { id: 'normalize.mixed', fn: 'normalize', args: ['C:/a//b/./c/'] },
  { id: 'normalize.unc', fn: 'normalize', args: ['\\\\server\\share'] },
  { id: 'normalize.unc-leftover', fn: 'normalize', args: ['\\\\server\\share\\a\\..'] },
  { id: 'normalize.device-root', fn: 'normalize', args: ['\\\\.\\PHYSICALDRIVE0'] },
  { id: 'normalize.long-unc', fn: 'normalize', args: ['\\\\?\\UNC\\server\\share\\x'] },
  { id: 'normalize.reserved', fn: 'normalize', args: ['CON'] },
  { id: 'normalize.reserved-drive', fn: 'normalize', args: ['C:CON'] },
  { id: 'normalize.reserved-long', fn: 'normalize', args: ['\\\\?\\COM1'] },
  { id: 'normalize.fake-abs-1', fn: 'normalize', args: ['a:C:'] },
  { id: 'normalize.fake-abs-2', fn: 'normalize', args: ['x:y:z'] },
  { id: 'normalize.fake-abs-3', fn: 'normalize', args: ['..\\C:'] },
  { id: 'normalize.drive-rel', fn: 'normalize', args: ['C:a\\b'] },
  { id: 'normalize.double-slash', fn: 'normalize', args: ['//server/share'] },
  { id: 'normalize.dots-only', fn: 'normalize', args: ['..'] },
  { id: 'normalize.dot-only', fn: 'normalize', args: ['.'] },

  // ── isAbsolute ──
  { id: 'isAbsolute.empty', fn: 'isAbsolute', args: [''] },
  { id: 'isAbsolute.drive-root', fn: 'isAbsolute', args: ['C:\\'] },
  { id: 'isAbsolute.drive-only', fn: 'isAbsolute', args: ['C:'] },
  { id: 'isAbsolute.drive-rel', fn: 'isAbsolute', args: ['C:a'] },
  { id: 'isAbsolute.slash', fn: 'isAbsolute', args: ['\\a'] },
  { id: 'isAbsolute.forward', fn: 'isAbsolute', args: ['/a'] },
  { id: 'isAbsolute.unc', fn: 'isAbsolute', args: ['\\\\server\\share'] },
  { id: 'isAbsolute.rel', fn: 'isAbsolute', args: ['a\\b'] },

  // ── join ──
  { id: 'join.none', fn: 'join', args: [] },
  { id: 'join.basic', fn: 'join', args: ['a', 'b'] },
  { id: 'join.drive', fn: 'join', args: ['C:\\a', 'b'] },
  { id: 'join.unc', fn: 'join', args: ['//server', 'share'] },
  { id: 'join.triple-slash', fn: 'join', args: ['///a', 'b'] },
  { id: 'join.reserved', fn: 'join', args: ['CON', 'x'] },
  { id: 'join.reserved-drive', fn: 'join', args: ['C:CON', 'x'] },
  { id: 'join.dots', fn: 'join', args: ['a', '..', 'b'] },
  { id: 'join.empty-args', fn: 'join', args: ['', '', 'a'] },
  { id: 'join.mixed-sep', fn: 'join', args: ['a/b', 'c\\d'] },

  // ── relative ──
  { id: 'relative.same', fn: 'relative', args: ['C:\\a\\b', 'C:\\a\\b'] },
  { id: 'relative.case', fn: 'relative', args: ['C:\\A\\B', 'c:\\a\\b\\c'] },
  { id: 'relative.cross-drive', fn: 'relative', args: ['C:\\a', 'D:\\b'] },
  { id: 'relative.up', fn: 'relative', args: ['C:\\a\\b\\c', 'C:\\a'] },
  { id: 'relative.down', fn: 'relative', args: ['C:\\a', 'C:\\a\\b\\c'] },
  { id: 'relative.device-root', fn: 'relative', args: ['C:\\', 'C:\\a'] },
  { id: 'relative.device-root-back', fn: 'relative', args: ['C:\\a', 'C:\\'] },
  { id: 'relative.rel-args', fn: 'relative', args: ['a', 'b'] },
  { id: 'relative.unc', fn: 'relative', args: ['\\\\server\\share\\a', '\\\\server\\share\\b'] },

  // ── toNamespacedPath ──
  { id: 'toNs.empty', fn: 'toNamespacedPath', args: [''] },
  { id: 'toNs.drive', fn: 'toNamespacedPath', args: ['C:\\a\\b'] },
  { id: 'toNs.drive-root', fn: 'toNamespacedPath', args: ['C:\\'] },
  { id: 'toNs.unc', fn: 'toNamespacedPath', args: ['\\\\server\\share\\a'] },
  { id: 'toNs.long', fn: 'toNamespacedPath', args: ['\\\\?\\C:\\a'] },
  { id: 'toNs.device', fn: 'toNamespacedPath', args: ['\\\\.\\PHYSICALDRIVE0'] },
  { id: 'toNs.rel', fn: 'toNamespacedPath', args: ['a\\b'] },

  // ── dirname ──
  { id: 'dirname.empty', fn: 'dirname', args: [''] },
  { id: 'dirname.slash', fn: 'dirname', args: ['/'] },
  { id: 'dirname.drive-root', fn: 'dirname', args: ['C:\\'] },
  { id: 'dirname.drive-only', fn: 'dirname', args: ['C:'] },
  { id: 'dirname.drive-rel', fn: 'dirname', args: ['C:a'] },
  { id: 'dirname.file', fn: 'dirname', args: ['C:\\a\\b.txt'] },
  { id: 'dirname.trailing', fn: 'dirname', args: ['C:\\a\\b\\'] },
  { id: 'dirname.forward', fn: 'dirname', args: ['C:/a/b'] },
  { id: 'dirname.unc-root', fn: 'dirname', args: ['\\\\server\\share'] },
  { id: 'dirname.unc-deep', fn: 'dirname', args: ['\\\\server\\share\\a\\b'] },
  { id: 'dirname.rel', fn: 'dirname', args: ['a\\b'] },
  { id: 'dirname.dot', fn: 'dirname', args: ['.'] },

  // ── basename ──
  { id: 'basename.empty', fn: 'basename', args: [''] },
  { id: 'basename.file', fn: 'basename', args: ['C:\\a\\b.txt'] },
  { id: 'basename.suffix', fn: 'basename', args: ['C:\\a\\b.txt', '.txt'] },
  { id: 'basename.suffix-mismatch', fn: 'basename', args: ['C:\\a\\b.txt', '.md'] },
  { id: 'basename.suffix-eq', fn: 'basename', args: ['b.txt', 'b.txt'] },
  { id: 'basename.trailing', fn: 'basename', args: ['C:\\a\\b\\'] },
  { id: 'basename.drive-only', fn: 'basename', args: ['C:'] },
  { id: 'basename.root', fn: 'basename', args: ['C:\\'] },
  { id: 'basename.dots', fn: 'basename', args: ['..'] },
  { id: 'basename.unc', fn: 'basename', args: ['\\\\server\\share'] },

  // ── extname ──
  { id: 'extname.empty', fn: 'extname', args: [''] },
  { id: 'extname.file', fn: 'extname', args: ['C:\\a\\b.txt'] },
  { id: 'extname.multi-dot', fn: 'extname', args: ['a.tar.gz'] },
  { id: 'extname.dotfile', fn: 'extname', args: ['.gitignore'] },
  { id: 'extname.dots', fn: 'extname', args: ['..'] },
  { id: 'extname.trailing-dot', fn: 'extname', args: ['a.'] },
  { id: 'extname.drive', fn: 'extname', args: ['C:.txt'] },
  { id: 'extname.dir-dot', fn: 'extname', args: ['C:\\a.b\\c'] },

  // ── format / parse ──
  { id: 'format.dir-base', fn: 'format', args: [{ dir: 'C:\\a', base: 'b.txt' }] },
  { id: 'format.root-base', fn: 'format', args: [{ root: 'C:\\', base: 'b.txt' }] },
  { id: 'format.name-ext', fn: 'format', args: [{ dir: 'C:\\a', name: 'b', ext: 'txt' }] },
  { id: 'format.ext-dot', fn: 'format', args: [{ dir: 'C:\\a', name: 'b', ext: '.txt' }] },
  { id: 'format.only-name', fn: 'format', args: [{ name: 'b' }] },
  { id: 'format.unc', fn: 'format', args: [{ root: '\\\\server\\share\\', base: 'b' }] },
  { id: 'parse.empty', fn: 'parse', args: [''] },
  { id: 'parse.file', fn: 'parse', args: ['C:\\a\\b.txt'] },
  { id: 'parse.drive-root', fn: 'parse', args: ['C:\\'] },
  { id: 'parse.drive-only', fn: 'parse', args: ['C:'] },
  { id: 'parse.trailing', fn: 'parse', args: ['C:\\a\\b\\'] },
  { id: 'parse.unc', fn: 'parse', args: ['\\\\server\\share\\a\\b.txt'] },
  { id: 'parse.unc-root', fn: 'parse', args: ['\\\\server\\share'] },
  { id: 'parse.forward', fn: 'parse', args: ['C:/a/b.txt'] },
  { id: 'parse.dotfile', fn: 'parse', args: ['C:\\a\\.gitignore'] },
  { id: 'parse.slash-only', fn: 'parse', args: ['/'] },
  { id: 'parse.rel', fn: 'parse', args: ['a\\b.txt'] },
];
