// 第二轮取真值：填充空模式 + StringDecoder 的非法序列粒度（用码点打印，避免终端渲染误导）
import { StringDecoder } from 'node:string_decoder';
const cp = (s) => [...s].map((c) => c.codePointAt(0).toString(16)).join(',') || '<empty>';
const hex = (b) => Buffer.from(b).toString('hex');
const p = (label, fn) => {
  try {
    console.log(label.padEnd(42) + ' => ' + fn());
  } catch (e) {
    console.log(label.padEnd(42) + ' => THROW ' + e.name + ':' + e.code + '|' + e.message);
  }
};

console.log('--- fill 空模式 ---');
p("fill(new Uint8Array(0))", () => { const b = Buffer.alloc(4, 7); b.fill(new Uint8Array(0)); return hex(b); });
p("fill(Buffer.alloc(0))", () => { const b = Buffer.alloc(4, 7); b.fill(Buffer.alloc(0)); return hex(b); });
p("fill(new Uint8Array(0),1,3)", () => { const b = Buffer.alloc(4, 7); b.fill(new Uint8Array(0), 1, 3); return hex(b); });
p("fill(DataView)", () => { const b = Buffer.alloc(4, 7); b.fill(new DataView(new Uint8Array([1, 2]).buffer)); return hex(b); });
p("fill(Uint16Array)", () => { const b = Buffer.alloc(4, 7); b.fill(new Uint16Array([0x0102])); return hex(b); });
p("fill(u8 subarray 1,3)", () => { const b = Buffer.alloc(4, 7); b.fill(new Uint8Array([1, 2, 3]).subarray(1, 3)); return hex(b); });
p("alloc(4, new Uint8Array(0))", () => hex(Buffer.alloc(4, new Uint8Array(0))));

console.log('--- StringDecoder 非法 utf8 粒度 ---');
const w = (bytes, enc = 'utf8') => { const d = new StringDecoder(enc); return cp(d.write(Buffer.from(bytes))) + ' | need=' + d.lastNeed + ' total=' + d.lastTotal; };
const we = (bytes, enc = 'utf8') => { const d = new StringDecoder(enc); const a = d.write(Buffer.from(bytes)); return cp(a) + ' || end=' + cp(d.end()); };
p("[c0,80]", () => w([0xc0, 0x80]));
p("[c0]", () => w([0xc0]));
p("[c0] then [80]", () => { const d = new StringDecoder('utf8'); return cp(d.write(Buffer.from([0xc0]))) + '|' + cp(d.write(Buffer.from([0x80]))); });
p("[c0] then [41]", () => { const d = new StringDecoder('utf8'); return cp(d.write(Buffer.from([0xc0]))) + '|' + cp(d.write(Buffer.from([0x41]))); });
p("[e0]", () => w([0xe0]));
p("[e0,80]", () => w([0xe0, 0x80]));
p("[e0,80] end", () => we([0xe0, 0x80]));
p("[e0,a0]", () => w([0xe0, 0xa0]));
p("[e0,a0] then [80]", () => { const d = new StringDecoder('utf8'); return cp(d.write(Buffer.from([0xe0, 0xa0]))) + '|' + cp(d.write(Buffer.from([0x80]))); });
p("[ed,a0,80]", () => w([0xed, 0xa0, 0x80]));
p("[ed,a0,80] end", () => we([0xed, 0xa0, 0x80]));
p("[f0,9f,98]", () => w([0xf0, 0x9f, 0x98]));
p("[f0,9f,98,80]", () => w([0xf0, 0x9f, 0x98, 0x80]));
p("[f0,80,80,80]", () => w([0xf0, 0x80, 0x80, 0x80]));
p("[f4,90,80,80]", () => w([0xf4, 0x90, 0x80, 0x80]));
p("[f5,80]", () => w([0xf5, 0x80]));
p("[80]", () => w([0x80]));
p("[80,80,80,80,80]", () => w([0x80, 0x80, 0x80, 0x80, 0x80]));
p("[e2,82] then [41]", () => { const d = new StringDecoder('utf8'); return cp(d.write(Buffer.from([0xe2, 0x82]))) + '|' + cp(d.write(Buffer.from([0x41]))) + '|' + cp(d.end()); });
p("[e2,82] then [ac,41]", () => { const d = new StringDecoder('utf8'); return cp(d.write(Buffer.from([0xe2, 0x82]))) + '|' + cp(d.write(Buffer.from([0xac, 0x41]))); });
p("[41,e2] then [82,ac]", () => { const d = new StringDecoder('utf8'); return cp(d.write(Buffer.from([0x41, 0xe2]))) + '|' + cp(d.write(Buffer.from([0x82, 0xac]))); });
p("[61,ff,62]", () => w([0x61, 0xff, 0x62]));
p("[61,ff] then [e2]", () => { const d = new StringDecoder('utf8'); return cp(d.write(Buffer.from([0x61, 0xff]))) + '|' + d.lastNeed + '|' + cp(d.write(Buffer.from([0xe2]))) + '|' + d.lastNeed + '|' + cp(d.end()); });

console.log('--- StringDecoder 其它编码 ---');
p("ucs2 split surrogate", () => { const d = new StringDecoder('utf16le'); const a = Buffer.from('\ud83d\ude00', 'utf16le'); return cp(d.write(a.subarray(0, 2))) + '|need=' + d.lastNeed + '|total=' + d.lastTotal + '|' + cp(d.write(a.subarray(2))); });
p("ucs2 odd + odd", () => { const d = new StringDecoder('utf16le'); return cp(d.write(Buffer.from([0x61]))) + '|' + cp(d.write(Buffer.from([0x62]))) + '|' + cp(d.write(Buffer.from([0x00]))) + '|' + cp(d.write(Buffer.from([0x00]))); });
p("ucs2 3 bytes", () => { const d = new StringDecoder('utf16le'); return cp(d.write(Buffer.from([0x61, 0x00, 0x62]))) + '|need=' + d.lastNeed + '|total=' + d.lastTotal + '|char=' + hex(d.lastChar); });
p("base64 1 char", () => { const d = new StringDecoder('base64'); return cp(d.write(Buffer.from('a'))) + '|need=' + d.lastNeed + '|total=' + d.lastTotal; });
p("base64 1 then 3", () => { const d = new StringDecoder('base64'); return cp(d.write(Buffer.from('a'))) + '|' + cp(d.write(Buffer.from('GVs'))); });
p("base64 5 chars", () => { const d = new StringDecoder('base64'); return cp(d.write(Buffer.from('aGVsb'))) + '|need=' + d.lastNeed + '|total=' + d.lastTotal + '|char=' + hex(d.lastChar); });
p("base64 6 chars", () => { const d = new StringDecoder('base64'); return cp(d.write(Buffer.from('aGVsbG'))) + '|need=' + d.lastNeed + '|total=' + d.lastTotal; });
p("base64 4 + 4", () => { const d = new StringDecoder('base64'); return cp(d.write(Buffer.from('aGVs'))) + '|' + cp(d.write(Buffer.from('bG8='))) + '|' + cp(d.end()); });
p("base64 6 + end", () => { const d = new StringDecoder('base64'); d.write(Buffer.from('aGVsbG')); return cp(d.end()); });
p("hex whole", () => { const d = new StringDecoder('hex'); return cp(d.write(Buffer.from([0x61, 0x62, 0x63]))) + '|' + hex(d.lastChar); });
p("latin1 whole", () => { const d = new StringDecoder('latin1'); return cp(d.write(Buffer.from([0xe9, 0x41]))); });
p("ascii whole", () => { const d = new StringDecoder('ascii'); return cp(d.write(Buffer.from([0xe9, 0x41]))); });
p("empty chunk utf8", () => { const d = new StringDecoder('utf8'); return cp(d.write(Buffer.alloc(0))) + '|' + d.lastNeed; });
p("empty chunk then flush", () => { const d = new StringDecoder('utf8'); d.write(Buffer.alloc(0)); return cp(d.end()); });
p("write after end reuse", () => { const d = new StringDecoder('utf8'); d.write(Buffer.from([0xe2])); d.end(); return cp(d.write(Buffer.from([0x41]))) + '|need=' + d.lastNeed; });
p("lastChar after end", () => { const d = new StringDecoder('utf8'); d.write(Buffer.from([0xe2])); d.end(); return hex(d.lastChar) + '|' + d.lastNeed + '|' + d.lastTotal; });
p("subarray view of u16", () => { const d = new StringDecoder('utf8'); return cp(d.write(new Uint16Array([0x0041, 0x0042]))); });
p("dv offset view", () => { const d = new StringDecoder('utf8'); const ab = new Uint8Array([0x7a, 0x41, 0x42]).buffer; return cp(d.write(new DataView(ab, 1, 2))); });
p("text() legacy", () => { const d = new StringDecoder('utf8'); return cp(d.text(Buffer.from([0x41, 0x42, 0x43]), 1)); });
p("decoder.end('str')", () => { const d = new StringDecoder('utf8'); return cp(d.end('ab')); });
p("decoder.write('str') then end", () => { const d = new StringDecoder('utf8'); return JSON.stringify(d.write('ab')) + '|' + JSON.stringify(d.end()); });
p("decoder props enumerable", () => Object.keys(new StringDecoder('utf8')).join(','));
p("lastChar own?", () => Object.prototype.hasOwnProperty.call(new StringDecoder('utf8'), 'lastChar'));
p("SD is class?", () => typeof StringDecoder.prototype.write);
