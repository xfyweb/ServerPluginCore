// 规范化 JSON（docs/plugin-signature-design.md §4）
//
// 签名对象 = 规范化后的 JSON 字节。这里的两个函数分工明确：
// - canonicalize：**签名方**用（构建工具 / 测试），产出唯一确定形式；
// - parseStrictJson：**验签方**用，只做"语法合法性"校验（重复键 / 浮点 / 注释 / 尾随逗号一律拒绝），
//   验签直接对**原始字节**做，不做"重新序列化后比对"（§4 第 7 条）。
import { SpcError } from '../errors';

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** 值 → 规范化 JSON 文本（键按 UTF-8 字节序升序、无空白、只允许整数） */
export function canonicalize(value: unknown): string {
  return write(value);
}

function write(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number': {
      if (!Number.isSafeInteger(v) || Object.is(v, -0)) {
        throw new SpcError('PACKAGE_META_MALFORMED', { reason: `仅允许整数：${String(v)}` });
      }
      return String(v);
    }
    case 'string':
      return quote(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map(write).join(',')}]`;
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).sort(byUtf8);
      return `{${keys.map((k) => `${quote(k)}:${write(obj[k])}`).join(',')}}`;
    }
    default:
      throw new SpcError('PACKAGE_META_MALFORMED', { reason: `不支持的类型：${typeof v}` });
  }
}

/** UTF-8 字节序比较（不是 UTF-16 code unit 序） */
function byUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"' || ch === '\\') out += `\\${ch}`;
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** 文本是否为规范形式（供构建工具自检；验签方不依赖它做安全判定） */
export function isCanonical(text: string): boolean {
  try {
    return canonicalize(parseStrictJson(text)) === text;
  } catch {
    return false;
  }
}

/**
 * 严格 JSON 解析：拒绝重复键、浮点/指数/前导零、注释、尾随逗号、非法转义。
 * 失败一律抛 PACKAGE_META_MALFORMED（对外只暴露码）。
 */
export function parseStrictJson(text: string): unknown {
  if (text.charCodeAt(0) === 0xfeff) {
    throw malformed('禁止 BOM');
  }
  const p = new Parser(text);
  const value = p.parseValue();
  p.skipWs();
  if (!p.eof()) throw malformed('末尾存在多余内容');
  return value;
}

function malformed(reason: string): SpcError {
  return new SpcError('PACKAGE_META_MALFORMED', { reason });
}

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  eof(): boolean {
    return this.i >= this.s.length;
  }

  skipWs(): void {
    while (!this.eof() && (this.s[this.i] === ' ' || this.s[this.i] === '\n' || this.s[this.i] === '\r' || this.s[this.i] === '\t')) {
      this.i++;
    }
  }

  parseValue(): unknown {
    this.skipWs();
    const c = this.s[this.i];
    if (c === '{') return this.parseObject();
    if (c === '[') return this.parseArray();
    if (c === '"') return this.parseString();
    if (c === 't' && this.s.startsWith('true', this.i)) {
      this.i += 4;
      return true;
    }
    if (c === 'f' && this.s.startsWith('false', this.i)) {
      this.i += 5;
      return false;
    }
    if (c === 'n' && this.s.startsWith('null', this.i)) {
      this.i += 4;
      return null;
    }
    if (c === '-' || (c >= '0' && c <= '9')) return this.parseNumber();
    throw malformed(`非法字面量（偏移 ${this.i}）`);
  }

  private parseObject(): Record<string, unknown> {
    this.i++; // {
    const obj: Record<string, unknown> = {};
    this.skipWs();
    if (this.s[this.i] === '}') {
      this.i++;
      return obj;
    }
    for (;;) {
      this.skipWs();
      if (this.s[this.i] !== '"') throw malformed(`对象键必须是字符串（偏移 ${this.i}）`);
      const key = this.parseString();
      if (Object.prototype.hasOwnProperty.call(obj, key)) throw malformed(`重复键：${key}`);
      this.skipWs();
      if (this.s[this.i] !== ':') throw malformed(`缺少 ':'（偏移 ${this.i}）`);
      this.i++;
      obj[key] = this.parseValue();
      this.skipWs();
      const c = this.s[this.i];
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === '}') {
        this.i++;
        return obj;
      }
      throw malformed(`对象未闭合（偏移 ${this.i}）`);
    }
  }

  private parseArray(): unknown[] {
    this.i++; // [
    const arr: unknown[] = [];
    this.skipWs();
    if (this.s[this.i] === ']') {
      this.i++;
      return arr;
    }
    for (;;) {
      arr.push(this.parseValue());
      this.skipWs();
      const c = this.s[this.i];
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === ']') {
        this.i++;
        return arr;
      }
      throw malformed(`数组未闭合（偏移 ${this.i}）`);
    }
  }

  private parseString(): string {
    this.i++; // "
    let out = '';
    for (;;) {
      if (this.eof()) throw malformed('字符串未闭合');
      const ch = this.s[this.i];
      if (ch === '"') {
        this.i++;
        return out;
      }
      if (ch === '\\') {
        const esc = this.s[this.i + 1];
        if (esc === 'u') {
          const hex = this.s.slice(this.i + 2, this.i + 6);
          if (!/^[0-9a-f]{4}$/.test(hex)) throw malformed(`非法 \\u 转义：\\u${hex}`);
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 6;
          continue;
        }
        const mapped = ESCAPES[esc];
        if (!mapped) throw malformed(`非法转义：\\${esc}`);
        out += mapped;
        this.i += 2;
        continue;
      }
      const code = this.s.charCodeAt(this.i);
      if (code < 0x20) throw malformed('字符串中出现未转义控制字符');
      out += ch;
      this.i++;
    }
  }

  private parseNumber(): number {
    const start = this.i;
    if (this.s[this.i] === '-') this.i++;
    if (this.s[this.i] === '0' && /\d/.test(this.s[this.i + 1] ?? '')) throw malformed('数字不得有前导零');
    while (/\d/.test(this.s[this.i] ?? '')) this.i++;
    if (this.s[this.i] === '.' || this.s[this.i] === 'e' || this.s[this.i] === 'E') {
      throw malformed('仅允许整数（禁浮点与指数）');
    }
    const raw = this.s.slice(start, this.i);
    if (raw === '-0') throw malformed('禁止 -0');
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) throw malformed(`整数超出安全范围：${raw}`);
    return n;
  }
}
