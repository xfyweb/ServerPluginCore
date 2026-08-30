// 管理面握手鉴权测试（node:test）
// 覆盖：全流程、防重放、防假冒、防篡改、无效 token
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HandshakeServer, verifyDaemon } from '../handshake';

test('握手全流程：challenge → 验签 → 会话 token 有效', () => {
  const srv = new HandshakeServer();
  const { challenge, signature } = srv.issueChallenge();
  assert.equal(verifyDaemon(srv.publicKeyB64, challenge, signature), true);
  const session = srv.openSession(challenge);
  assert.ok(session);
  assert.equal(srv.isValidToken(session.token), true);
});

test('防重放：同一 challenge 只能换一次会话', () => {
  const srv = new HandshakeServer();
  const { challenge } = srv.issueChallenge();
  assert.ok(srv.openSession(challenge));
  assert.equal(srv.openSession(challenge), null); // 重放被拒
});

test('防假冒：另一个 daemon 的公钥验签失败', () => {
  const real = new HandshakeServer();
  const fake = new HandshakeServer();
  const { challenge, signature } = real.issueChallenge();
  assert.equal(verifyDaemon(fake.publicKeyB64, challenge, signature), false);
});

test('防篡改：challenge 被改后验签失败', () => {
  const srv = new HandshakeServer();
  const { challenge, signature } = srv.issueChallenge();
  assert.equal(verifyDaemon(srv.publicKeyB64, challenge + 'x', signature), false);
});

test('无效公钥/签名输入不抛异常（返回 false）', () => {
  const srv = new HandshakeServer();
  const { challenge, signature } = srv.issueChallenge();
  assert.equal(verifyDaemon('not-a-key', challenge, signature), false);
  assert.equal(verifyDaemon(srv.publicKeyB64, challenge, 'not-a-sig'), false);
});

test('未知 token 无效', () => {
  const srv = new HandshakeServer();
  assert.equal(srv.isValidToken('fake-token'), false);
});

test('重启即失效：新 daemon 实例不认旧 token', () => {
  const srv1 = new HandshakeServer();
  const { challenge } = srv1.issueChallenge();
  const session = srv1.openSession(challenge)!;
  const srv2 = new HandshakeServer(); // 模拟重启（新密钥对 + 新会话表）
  assert.equal(srv2.isValidToken(session.token), false);
});
