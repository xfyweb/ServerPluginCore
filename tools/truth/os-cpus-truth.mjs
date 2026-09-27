// 基线真值：os.cpus() 的形状、availableParallelism、以及 cpus 的 model/speed 到底给什么
// （基线 = WSL Ubuntu / node v24.20.0；本机宿主 v24 也可以对比，但结论以基线为准）
import * as os from 'node:os';

const cpus = os.cpus();
console.log(JSON.stringify({
  version: process.version,
  count: cpus.length,
  available: os.availableParallelism(),
  first: cpus[0],
  keys: Object.keys(cpus[0]),
  timesKeys: Object.keys(cpus[0].times),
  modelSame: cpus.every((c) => c.model === cpus[0].model),
  speedSame: cpus.every((c) => c.speed === cpus[0].speed),
  speedType: typeof cpus[0].speed,
  timesType: typeof cpus[0].times.user,
  // 是不是同一个对象（每次调用返回新的数组吗）
  freshArray: os.cpus() !== cpus,
  freshEntry: os.cpus()[0] !== cpus[0],
}, null, 2));
