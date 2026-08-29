// 沙箱内只有注入的 @host/api 可用——没有 require、没有 process、没有 fs
import { write } from '@host/api';

const result = write('~/test.txt', 'HelloWorld');
console.log('[plugin] write result:', result);