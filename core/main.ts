import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transform } from 'esbuild';
import { validateManifest } from '../sdk/validate';
import type { Manifest } from '../sdk/types';
import { initAudit } from './audit';
import { hostApi } from './hostApi';
import { createSandbox } from './sandbox';

const pluginDir = join(import.meta.dirname, '..', 'plugin', 'sample');

async function main() {
  // 0) 审计链路启动探测（写不了就退出，fail-closed at startup）
  initAudit();

  // 1) 读插件清单并校验（schema 单一事实源：sdk/schema/manifest.schema.json）
  const raw = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8'));
  const check = validateManifest(raw);
  if (!check.ok) {
    console.error(`[core] manifest 校验失败（${pluginDir}/manifest.json）：`);
    for (const e of check.errors) console.error('  -', e);
    process.exit(1);
  }
  const manifest = raw as Manifest;
  const source = readFileSync(join(pluginDir, manifest.entry ?? 'main.ts'), 'utf8');

  // 1.5) 构建层雏形：TS → ESM JS（正式版走 esbuild 白名单 bundle，见 ADR-005 §6）
  const { code } = await transform(source, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });

  // 2) 插件上下文：manifest 权限请求 + 管理员授予 → 权限检查 + 审计
  //    spike：授予写死在这里；正式版由安装流写入安装记录（plugin-signature-design.md §9）
  const sandbox = await createSandbox(hostApi, {
    pluginId: manifest.id,
    permissions: manifest.permissions.map((p) => p.name),
    grants: ['fs.write.home', 'exec.template.git.version'],
  });

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
