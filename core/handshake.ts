// 管理面鉴权：ed25519 临时密钥挑战握手 + 短时会话 token
// 设计见 docs/management-channel.md §3
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

const SESSION_TTL_MS = 5 * 60 * 1000; // 会话 5 分钟

export interface SessionToken {
  token: string;
  expiresAt: number;
}

/**
 * daemon 侧握手状态：临时密钥对（私钥仅内存）+ 一次性 challenge + 会话表
 */
export class HandshakeServer {
  private readonly publicKeyDer: Buffer;
  private readonly privateKey: KeyObject;
  private readonly usedChallenges = new Set<string>();
  private readonly sessions = new Map<string, number>(); // token -> expiresAt

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    this.privateKey = privateKey;
  }

  /** 公钥（base64 DER），可公开，CLI 用于验签 */
  get publicKeyB64(): string {
    return this.publicKeyDer.toString('base64');
  }

  /** ① 生成一次性 challenge + daemon 签名（CLI 验签确认 daemon 身份） */
  issueChallenge(): { challenge: string; signature: string } {
    const challenge = randomBytes(32).toString('hex');
    const sig = sign(null, Buffer.from(challenge), this.privateKey);
    return { challenge, signature: sig.toString('base64') };
  }

  /** ③ 校验一次性 challenge（防重放）并签发会话 token */
  openSession(challenge: string): SessionToken | null {
    if (this.usedChallenges.has(challenge)) return null; // 已用过（重放）
    this.usedChallenges.add(challenge);
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.sessions.set(token, expiresAt);
    return { token, expiresAt };
  }

  /** ④ 校验请求的 Bearer token */
  isValidToken(token: string): boolean {
    const expiresAt = this.sessions.get(token);
    if (expiresAt === undefined) return false;
    if (Date.now() > expiresAt) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  /** 重启即失效：旧 token/challenge 全部作废（新实例即新密钥） */
  dispose(): void {
    this.usedChallenges.clear();
    this.sessions.clear();
  }
}

/**
 * CLI 侧：用 pubkey 验签 daemon 的 challenge 签名，确认 daemon 身份
 */
export function verifyDaemon(pubkeyB64: string, challenge: string, signatureB64: string): boolean {
  try {
    const pub = createPublicKey({
      key: Buffer.from(pubkeyB64, 'base64'),
      type: 'spki',
      format: 'der',
    });
    return verify(null, Buffer.from(challenge), pub, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/** 工具：内容摘要（审计日志等用） */
export function digest(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}


