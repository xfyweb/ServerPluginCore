# 特权执行器设计（Privilege Gate）

- 状态：**已接受（设计）**；实现阶段：P5（生产加固）
- 关联：ADR-004（非 root 底线）、api-contract §4.1（任务模型）、docs/interface-audit-exec-fs.md（exec 模板）

## 1. 问题

spc daemon 以非 root 运行（ADR-004）后，以下操作无法直接执行：

- 写系统配置（/etc/nginx 等）、服务管理（systemctl reload）
- 防火墙规则（iptables/nftables）、低端口监听（80/443）
- 用户/权限管理（useradd/chown）

需要一个**最高权限的独立进程**承接这些操作——但必须是"最小、白名单、可审计"的，否则非 root 底线形同虚设。

## 2. 架构

```
┌──────────────────────────────────────────────────┐
│ spc daemon（spc 用户，非 root）                    │
│   exec 模板分两类：                                │
│     普通模板 → 自己执行（低权限，P1 已有）           │
│     特权模板 → 转发特权执行器（privileged: true）   │
└───────────────────┬──────────────────────────────┘
                    │ AF_UNIX socket（/run/spc/priv.sock）
                    │ JSON-RPC 2.0（复用 api-contract 信封）
                    │ SO_PEERCRED：仅接受 uid === spc
┌───────────────────▼──────────────────────────────┐
│ 特权执行器（root 独立小进程）                       │
│  操作白名单（root-owned 配置，spc 不可修改）         │
│  参数严格校验 · 命令数组传参（不拼 shell）           │
│  独立审计日志（root 写，spc 无法篡改）              │
└──────────────────────────────────────────────────┘
```

## 3. 特权操作分类与实现方式

| 类别 | 示例 | 方式 |
|---|---|---|
| 系统配置写 | /etc/nginx 配置落盘、/etc/hosts | 特权执行器 |
| 服务管理 | systemctl reload/restart | 特权执行器 |
| 防火墙 | iptables/nftables | **setcap 助手**（cap_net_admin+ep，无需 root 进程） |
| 低端口 | 监听 80/443 | **setcap 助手**（cap_net_bind_service） |
| 用户/权限 | useradd、chown | 特权执行器 |
| 系统包安装 | apt install | **默认拒绝**（显式配置才启用） |

## 4. 安全设计要点

1. **白名单是真正的边界**：SO_PEERCRED 只防"其他用户调用"；若 spc daemon 被攻破（攻击者 = spc 用户），本来就能调白名单内操作——**爆炸半径 = 白名单命令集**；
2. **白名单 root-owned**：配置 root:root，spc 不可写——防"spc 被攻破后往白名单加命令实现提权"；
3. **参数校验最高级别**：特权模板的 paramsSchema 枚举/正则硬校验，命令数组传参；
4. **双重审计**：spc daemon 侧 + 执行器侧各一份（执行器侧 root 日志防篡改销毁）；
5. **执行器最小化**：无网络监听、无插件概念、无业务逻辑——只有"白名单 + 校验 + 执行 + 审计"；
6. **实现语言：Go 静态二进制**（无依赖、内存安全、交叉编译；MCSM 的 PTY 二进制同款先例）——安全关键路径不放在 Node 运行时；
7. **模板标记**：exec 模板注册表加 `privileged: true` 字段；只有这类模板会走特权通道，且权限点 `exec.template.<action>.<op>` 必须由管理员**逐点授予**（没有"特权档插件自动获得"这回事，见 ADR-001 v3）。

## 5. 威胁模型

```
插件逃逸 → spc daemon 被攻破 → 攻击者 = spc 用户
    ├─► 可做：白名单内特权操作（nginx reload 等）
    ├─► 不可做：白名单外 root 操作 / 改白名单 / 删 root 审计
    └─► 爆炸半径 = 白名单命令集
```

## 6. 部署与阶段

- systemd 双 unit：`spc.service`（spc 用户）+ `spc-privileged.service`（root）；
- 开发环境不需要特权执行器（开发账号权限足够）；
- **接口设计现在定**（P1/P2：exec 模板加 `privileged` 标记 + 特权执行器协议），**实现 P5**（生产加固）。

## 7. 与已有设计的关系

- 复用 api-contract 的 JSON-RPC 信封 + exec 模板体系（不引入第三套协议）；
- 复用 interface-audit-exec-fs.md 的威胁建模方法（E1–E8 清单对特权模板同样适用，且更严）；
- 与 management-channel（CLI↔daemon）是两条独立通道：CLI 通道管"管理操作"，特权通道管"root 操作"。
