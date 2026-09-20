// 基线真值：finished/pipeline 的回调参数到底是 null 还是 undefined（v22.22.1）
import { Readable, Writable, Transform, finished, pipeline } from 'node:stream';

console.log('version', process.version);

const r = new Readable({ read() {} });
const w = new Writable({ write(_c, _e, cb) { cb(); } });
r.resume();
await new Promise((resolve) => {
  r.push('x');
  r.push(null);
  w.end('y');
  finished(r, (err) => {
    console.log('finished(readable) err =', err, '| typeof', typeof err, '| === null', err === null, '| === undefined', err === undefined);
    finished(w, (err2) => {
      console.log('finished(writable) err =', err2, '| === null', err2 === null, '| === undefined', err2 === undefined);
      resolve();
    });
  });
});

const r2 = new Readable({ objectMode: true, read() {} });
const t2 = new Transform({
  objectMode: true,
  transform(chunk, _e, cb) { this.push(String(chunk) + '!'); cb(); },
  flush(cb) { this.push(null); cb(); },
});
const w2 = new Writable({ objectMode: true, write(_c, _e, cb) { cb(); } });
await new Promise((resolve) => {
  pipeline(r2, t2, w2, (err) => {
    console.log('pipeline err =', err, '| typeof', typeof err, '| === null', err === null, '| === undefined', err === undefined);
    resolve();
  });
  r2.push('a');
  r2.push(null);
});

// 顶层返回形态：finished 拿回的是什么
const cleanup = finished(new Readable({ read() {} }), () => {});
console.log('finished returns:', typeof cleanup);
