// 生成 `build/api-permission-map.json`（构建层的权限对账要用它）。
//
//   node node_modules/tsx/dist/cli.mjs build/refresh-api-map.mts
//
// 只在 `core/hostApi.ts` 的方法/权限点变化后跑；跑完 `pnpm test` 里的守卫用例会确认快照与源码一致。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_EXPECTED_METHODS, extractApiMap } from './extract-api-map';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const sourcePath = join(repo, 'core', 'hostApi.ts');
const outPath = join(here, 'api-permission-map.json');

const { methods } = extractApiMap(readFileSync(sourcePath, 'utf8'));
const count = Object.keys(methods).length;
if (count < MIN_EXPECTED_METHODS) {
  console.error(`抽取只拿到 ${count} 个方法（下限 ${MIN_EXPECTED_METHODS}）—— 多半是 core/hostApi.ts 的形状变了，停手。`);
  process.exit(1);
}

const sorted: Record<string, string> = {};
for (const key of Object.keys(methods).sort()) sorted[key] = methods[key];

writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      mapSchema: 1,
      source: 'core/hostApi.ts',
      generator: 'build/refresh-api-map.mts',
      note: '宿主方法 → 权限点。**生成物**：改 core/hostApi.ts 后重跑生成器；守卫用例会比对。',
      methods: sorted,
    },
    null,
    2,
  )}\n`,
  'utf8',
);
console.log(`已写出 ${outPath}：${count} 个方法 → ${new Set(Object.values(methods)).size} 个权限点`);
