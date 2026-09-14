// pnpm spike：走**真实链路**（记录 → 装载 → init/start → 停 → 卸载），
// 而不是像 P1 那样"写死一个目录跑一次"（plugin-lifecycle-design.md §11 验收）。
//
// 首次运行会真的把内置样板插件装进状态目录（reserved ⇒ 可禁用、不可卸载）；
// 之后每次运行都从 plugins.json 读记录、按 enabled 装载。
import { join } from 'node:path';
import { initAudit } from './audit';
import { configFile, loadConfig, pluginsFile, stateDir } from './config';
import { manager } from './plugin/manager';
import { registry } from './permissions/registry';

const SAMPLE_ID = '@xfy2412/sample';
const sampleDir = join(import.meta.dirname, '..', 'plugin', 'sample');

/** 只授予**确实注册过**的权限点：权限点不存在时"授予"是没有意义的（UNKNOWN_POINT） */
function sampleGrants(): string[] {
  return registry.get('exec.template.git.version') ? ['exec.template.git.version'] : [];
}

function printStatus(): void {
  const rows = manager.list();
  console.log(`[spc] plugins=${rows.length}`);
  for (const p of rows) {
    console.log(
      `  · ${p.id}@${p.version.name} [${p.state}] enabled=${p.enabled} reserved=${p.reserved}` +
        ` grants=[${p.grants.join(',')}] caps=[${p.capabilities.join(',')}]`,
    );
    if (p.lastError) console.log(`    lastError=${p.lastError.code}`);
  }
}

async function main() {
  // 0) 审计链路启动探测（写不了就退出，fail-closed at startup）
  initAudit();
  const cfg = loadConfig();
  console.log(`[spc] state=${stateDir()}`);
  console.log(`[spc] config=${configFile()} records=${pluginsFile()}`);
  console.log(
    `[spc] limits: mem=${cfg.plugin.limits.memoryBytes}B stack=${cfg.plugin.limits.maxStackBytes}B` +
      ` init=${cfg.plugin.limits.initTimeoutMs}ms start=${cfg.plugin.limits.startTimeoutMs}ms` +
      ` stop=${cfg.plugin.limits.stopTimeoutMs}ms failedRestart=${cfg.plugin.failedRestart}`,
  );

  // 1) 首次运行：安装内置样板插件（写记录 → 立即装载 → init/start）
  const existing = manager.list().find((p) => p.id === SAMPLE_ID);
  if (!existing) {
    console.log(`[spc] installing ${SAMPLE_ID} from ${sampleDir} ...`);
    await manager.install(sampleDir, { reserved: true, grants: sampleGrants() });
  } else {
    // 2) 之后每次：按记录启动（startAll 幂等，已装载的会跳过）
    await manager.startAll();
  }
  printStatus();

  const status = manager.status(SAMPLE_ID);
  console.log(`[spc] sample: state=${status.state} dataDir=${status.dataDir}`);

  // 3) 停机：stop → 撤销能力登记 → 释放沙箱
  console.log('[spc] stopping all plugins ...');
  await manager.stopAll('shutdown');
  printStatus();
  console.log('[spc] done.');
}

main().catch((err) => {
  console.error('[spc] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
