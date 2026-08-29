import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transform } from 'esbuild';
import { hostApi } from './hostApi';
import { createSandbox } from './sandbox';

const pluginDir = join(import.meta.dirname, '..', 'plugin', 'sample');

async function main() {
  // 1) 读插件清单与源码（spike：跳过 manifest 校验）
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8'));
  const source = readFileSync(join(pluginDir, manifest.entry), 'utf8');

  // 1.5) 构建层雏形：TS → ESM JS（正式版走 esbuild 白名单 bundle，见 ADR-005 §6）
  const { code } = await transform(source, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });

  // 2) 建沙箱，注入宿主 API（无鉴权）
  const sandbox = await createSandbox(hostApi);

  try {
    // 3) 加载并执行插件（ESM）
    await sandbox.runModule(manifest.id, code);
    console.log(`[core] plugin "${manifest.id}" executed.`);
  } finally {
    sandbox.dispose();
  }
}

main().catch((err) => {
  console.error('[core] failed:', err);
  process.exit(1);
});