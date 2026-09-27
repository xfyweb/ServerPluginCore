// querystring 形状真值（基线：WSL Ubuntu / node v24.20.0）
// 只报"规格表看不出来"的东西：别名身份、原型、escape 边界、坏转义回退。
import * as qs from 'node:querystring';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cjs = require('node:querystring');

const out = {
  namedExports: Object.keys(qs).sort(),
  cjsKeys: Object.keys(cjs).sort(),
  sameEncode: qs.encode === qs.stringify,
  sameDecode: qs.decode === qs.parse,
  escapeEdge: qs.escape("!'()*~ -._"),
  escapeNumber: qs.escape(42),
  escapeObject: qs.escape({ toString: () => 'a b' }),
  parseBadUtf8: qs.parse('a=%E4'),
  parseProto: Object.getPrototypeOf(qs.parse('a=1')) === null,
  parseEmpty: qs.parse(''),
  parseEmptyProto: Object.getPrototypeOf(qs.parse('')) === null,
  parseTrailing: qs.parse('a=1&'),
  parseNoEq: qs.parse('a&b=2'),
  parseEmptyKey: qs.parse('=b'),
  parsePlus: qs.parse('a+b=c+d'),
  parseDup: qs.parse('a=1&a=2&a=3'),
  parseMaxKeys: qs.parse('a=1&b=2&c=3', '&', '=', { maxKeys: 2 }),
  parseMaxKeysNeg: qs.parse('a=1&b=2&c=3', '&', '=', { maxKeys: -1 }),
  parseMaxKeysZero: qs.parse('a=1&b=2', '&', '=', { maxKeys: 0 }),
  parseAltSep: qs.parse('a=1;b=2', ';', '='),
  parseCustomDecode: qs.parse('a=%41', '&', '=', { decodeURIComponent: (s) => s.toLowerCase() }),
  parseNonString: qs.parse(42),
  unescapeBufferType: typeof cjs.unescapeBuffer,
  unescapeBufferBad: cjs.unescapeBuffer('%E4', true).toString('utf8'),
  unescapeBufferPlus: cjs.unescapeBuffer('a+b', true).toString('utf8'),
  unescapeBufferNoPlus: cjs.unescapeBuffer('a+b', false).toString('utf8'),
  unescapeBufferLone: cjs.unescapeBuffer('%zz%4', false).toString('utf8'),
  unescapeLone: qs.unescape('%zz%4'),
  unescapeBad: qs.unescape('%E4'),
  stringifyBasic: qs.stringify({ a: 1, b: 'x y', c: [1, 2], d: null, e: undefined, f: true, g: 1e21 }),
  stringifyEmptyArr: qs.stringify({ a: [] }),
  stringifyNonObject: qs.stringify('nope'),
  stringifyNull: qs.stringify(null),
  stringifyAltSep: qs.stringify({ a: 1, b: 2 }, ';', ':'),
  stringifyCustom: qs.stringify({ a: 'x y' }, '&', '=', { encodeURIComponent: encodeURIComponent }),
  stringifyCustomEmpty: qs.stringify({ a: '' }, '&', '=', { encodeURIComponent: (s) => 'X' + s }),
  stringifyNumberKey: qs.stringify({ 1: 'a' }),
  desc: Object.getOwnPropertyDescriptor(qs, 'parse') ? 'getter/plain' : 'missing',
};
console.log(JSON.stringify(out, null, 2));
