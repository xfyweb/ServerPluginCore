// 源与 keyring（docs/plugin-signature-design.md §5）
//
// 信任根 = 管理员 keyring，**以域名为主键**；一个源一套密钥；
// pub 可缺省（缺省时由核心远程拉取 = TOFU，失败则不添加该源）；
// 永不自动新增源：任何包、任何依赖、任何轮换文档都不能替管理员往这里加条目。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SpcError } from '../errors';
import { assertFingerprint, fingerprintOf } from './keys';

/** 官方市场（内置默认条目；其余源一律由管理员显式添加） */
export const DEFAULT_ORIGIN = 'market.spc.xfyweb.cn';

export interface SuspendedState {
  at: string;
  /** §7.3 的判定码（如 KEY_CHAIN_INVALID / KEY_ROTATION_UNVERIFIABLE / KEY_STATUS_ROLLBACK / KEY_STATUS_MALFORMED） */
  reason: string;
  pendingFingerprint?: string;
}

export interface HighWater {
  rotatedAt: string;
  fingerprint: string;
  /** 累计的吊销指纹：**仅展示/审计，不参与判定**（§6.1.1） */
  revoked: string[];
}

export interface SourceEntry {
  /** 主键：域名（不可为空、不可重复、不可修改） */
  origin: string;
  pub?: string;
  fingerprint?: string;
  /** 管理员可改，仅用于显示（"来源"标签就是它） */
  alias: string;
  enabled: boolean;
  addedAt: string;
  firstTrust: 'tofu' | 'manual';
  suspended: SuspendedState | null;
  highWater?: HighWater;
}

interface KeyringFile {
  keyringSchema: 1;
  sources: SourceEntry[];
}

/** 域名合法性（本机开发市场用 localhost 或 localhost:port） */
export function isValidOrigin(origin: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/.test(origin);
}

export function keyringDir(): string {
  return process.env.SPC_KEYRING_DIR ?? join(import.meta.dirname, '..', '..', '.spc');
}

export class Keyring {
  private sources = new Map<string, SourceEntry>();

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as KeyringFile;
      for (const s of parsed.sources ?? []) {
        // 缺 origin 的条目视为无效条目：忽略并告警，不使核心启动失败
        if (typeof s?.origin !== 'string' || !isValidOrigin(s.origin)) {
          console.error('[keyring] 忽略无效条目（origin 缺失或非法）');
          continue;
        }
        this.sources.set(s.origin, s);
      }
    }
  }

  static open(dir = keyringDir()): Keyring {
    return new Keyring(join(dir, 'keyring.json'));
  }

  list(): SourceEntry[] {
    return [...this.sources.values()];
  }

  get(origin: string): SourceEntry | undefined {
    return this.sources.get(origin);
  }

  /** 新增源（等价于管理员的显式动作；已存在则报错，避免静默覆盖） */
  add(entry: SourceEntry): void {
    if (!isValidOrigin(entry.origin)) {
      throw new SpcError('SOURCE_ORIGIN_INVALID', { origin: entry.origin });
    }
    if (this.sources.has(entry.origin)) {
      throw new SpcError('SOURCE_ALREADY_EXISTS', { origin: entry.origin });
    }
    if (entry.pub !== undefined) assertFingerprint(entry.pub, entry.fingerprint ?? fingerprintOf(entry.pub));
    this.sources.set(entry.origin, entry);
    this.save();
  }

  /** 更新已有条目（轮换 / 暂停 / 启停 / 别名） */
  update(origin: string, patch: Partial<Omit<SourceEntry, 'origin'>>): SourceEntry {
    const cur = this.sources.get(origin);
    if (!cur) throw new SpcError('SOURCE_NOT_CONFIGURED', { origin });
    const next: SourceEntry = { ...cur, ...patch, origin };
    if (next.pub !== undefined) assertFingerprint(next.pub, next.fingerprint ?? fingerprintOf(next.pub));
    this.sources.set(origin, next);
    this.save();
    return next;
  }

  remove(origin: string): boolean {
    const ok = this.sources.delete(origin);
    if (ok) this.save();
    return ok;
  }

  setEnabled(origin: string, enabled: boolean): SourceEntry {
    return this.update(origin, { enabled });
  }

  suspend(origin: string, reason: string, pendingFingerprint?: string): SourceEntry {
    return this.update(origin, {
      suspended: { at: new Date().toISOString(), reason, pendingFingerprint },
    });
  }

  clearSuspended(origin: string): SourceEntry {
    return this.update(origin, { suspended: null });
  }

  /** 内置官方源：缺失时补一条（无公钥 → 首次使用时 TOFU 拉取） */
  ensureDefaultOrigin(alias = '官方市场'): SourceEntry {
    const cur = this.sources.get(DEFAULT_ORIGIN);
    if (cur) return cur;
    const entry: SourceEntry = {
      origin: DEFAULT_ORIGIN,
      alias,
      enabled: true,
      addedAt: new Date().toISOString(),
      firstTrust: 'manual',
      suspended: null,
    };
    this.sources.set(DEFAULT_ORIGIN, entry);
    this.save();
    return entry;
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const data: KeyringFile = { keyringSchema: 1, sources: this.list() };
    writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
}
