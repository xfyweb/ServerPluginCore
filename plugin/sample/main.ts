// 样板插件：fs 分组 API（权限由宿主侧检查 + 审计）
import { fs } from '@host/api';

const result = fs.write('~/test.txt', 'HelloWorld');
console.log('[plugin] write result:', result);
