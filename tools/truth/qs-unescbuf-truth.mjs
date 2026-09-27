// 补测：unescapeBuffer 的返回长度在**基线 v24.20.0** 上到底是什么
import * as qs from 'node:querystring';

const out = {
  version: process.version,
  hexLen: qs.unescapeBuffer('%41%42', false).length,
  hexStr: qs.unescapeBuffer('%41%42', false).toString(),
  plainLen: qs.unescapeBuffer('abc', true).length,
  plainStr: qs.unescapeBuffer('abc', true).toString(),
  badLen: qs.unescapeBuffer('%E4', true).length,
  badStr: qs.unescapeBuffer('%E4', true).toString(),
  escapeEdge: qs.escape("!'()*~ -._"),
};
console.log(JSON.stringify(out, null, 2));
