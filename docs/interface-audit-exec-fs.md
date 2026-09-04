# 核心第一版接口审计：exec 模板 + fs 路径收敛

> 依据：ADR-001（接口审查 = 安全工程中心）、ADR-005 §10（核心第一版只审计 exec + fs）、api-contract.md v0.2 §5。
> 用途：本文件是**代码评审 checklist** 与**威胁建模清单**——每个危险接口的"恶意插件会怎么打 → 防御设计 → 测试用例"。

## 1. 目标与范围

核心第一版只实现并审计两个危险接口，其余（db/ssh/网络/pty）全部外置给驱动插件：

- **exec 模板**：`exec.runTemplate` —— 无自由命令，模板白名单；
- **fs 受限**：`fs.read/write/list/stat` —— 路径收敛。

设计原则（贯穿全文）：**沙箱插件是"半可信客户端"，不是"恶意代码"——防的是失控与越权，不是对抗内核级攻击**（内核兜底在子进程档，见 ADR-005 §8）。

---

## 2. exec 模板规范

### 2.1 模板定义（核心侧注册）

```json
{
  "action": "nginx",
  "op": "reload",
  "command": ["nginx", "-t"],                    // 固定数组，无拼接
  "params": {},                                   // 无参数 → 最安全
  "paramsSchema": {},                             // JSON Schema（有参数时）
  "cwd": "/etc/nginx",
  "env": ["PATH"],                                // 环境变量白名单
  "timeoutMs": 5000,
  "maxOutputBytes": 65536
}
```

### 2.2 铁律（代码评审第一条）

1. **禁止字符串拼接**：用户输入永远不能进入命令字符串，只能作为 `paramsSchema` 校验过的独立参数传入（数组传参，非 shell 字符串）；
2. **参数必须过 schema**：枚举 / 正则 / 白名单，三者取一；
3. **凭据禁明文**：命令行参数中**禁止出现密码**（`-p'xxx'` 会在 `/proc/<pid>/cmdline` 泄露）。凭据只能走：
   - 环境变量（`MYSQL_PWD`）——但注意 env 白名单要精确，不能把无关变量传下去；
   - `--defaults-extra-file`：临时文件，`chmod 600`，模板执行完立即删除（含失败路径）；
   - 模板自身不落盘凭据。
4. **输出限制**：`maxOutputBytes` 截断（防内存放大）；
5. **超时**：`timeoutMs` 硬超时（防失控进程）；
6. **工作目录固定**：`cwd` 由模板声明，不接受插件传入。

### 2.3 第一版模板清单（示例）

| action | op | 命令 | 参数 | 凭据 |
|---|---|---|---|---|
| nginx | test | `nginx -t` | 无 | — |
| nginx | reload | `nginx -s reload` | 无 | — |
| git | pull | `git -C <repo> pull --ff-only` | repo ∈ 白名单（管理员预配的仓库路径列表） | SSH key 由宿主管理 |
| mysql | query-file | `mysql --defaults-extra-file=<tmp> --batch --raw < <sql文件>` | sql 文件由插件先经 fs.write 写入数据目录 | defaults-extra-file（600，用完删） |
| psql | query-file | 同上（psql -f） | 同上 | 同上 |

**新增模板的流程**：提交模板定义 → 威胁建模评审（本文件清单）→ 进核心模板注册表 → 权限点 `exec.template.<action>.<op>` 自动生成。

### 2.4 exec 威胁建模清单（评审模板时逐条过）

| # | 攻击方式（恶意/失控插件） | 防御 | 测试用例 |
|---|---|---|---|
| E1 | 参数注入：`op` 传 `reload; rm -rf /` | paramsSchema 枚举校验；数组传参无 shell | 传注入串应返回 INVALID_ARGS |
| E2 | 路径穿越：git repo 传 `../../etc` | repo 白名单 + realpath 校验 | 白名单外路径被拒 |
| E3 | 凭据窃取：从 cmdline 读密码 | 禁明文 -p（§2.2-3） | 审计日志确认 cmdline 无密码 |
| E4 | 输出放大：`cat /dev/urandom` | maxOutputBytes 截断 | 大输出被截断且有标记 |
| E5 | 失控进程：`sleep 100000` | timeoutMs 硬超时 + 进程组 kill | 超时后进程被清理（pgrep 验证） |
| E6 | 环境泄露：读宿主无关环境变量 | env 白名单 | 非白名单变量不可见 |
| E7 | 写路径逃逸：命令写任意文件 | 命令固定无用户输入；确需写 → 经 fs 接口（受 §3 约束） | 模板命令无法被插件改写 |
| E8 | TOCTOU：模板执行期间配置被换 | cwd 固定 + 命令路径用绝对路径 | — |

---

## 3. fs 路径收敛规范

### 3.1 权限点与作用域

| 权限点 | 含义 | 范围 |
|---|---|---|
| `fs.read.data` | 读插件数据目录 | `/var/lib/spc/plugins/<id>/` |
| `fs.write.data` | 写插件数据目录 | 同上 |
| `fs.read.<granted-scope>` | manifest 额外授予的读目录 | 管理员/审核授予的显式目录列表 |

### 3.2 路径校验流程（每个 fs 调用，宿主侧强制）

1. **realpath 规范化**：解析 `..`、软链接后取绝对路径；
2. **前缀校验**：规范化后路径必须在允许作用域内；
3. **符号链接检查**：`lstat` 每级目录，拒绝指向作用域外的链接（含攻击者可控的软链）；
4. **特殊路径黑名单**：拒绝 `/dev/*`、`/proc/*`、`/sys/*`、socket 文件、FIFO；
5. **写操作附加**：目标文件不存在时检查父目录同样走 1–4；`O_NOFOLLOW` 打开；
6. **大小/类型限制**：单文件大小上限、拒绝超大文件（防读 /dev/zero 放大——由黑名单兜底）、扩展名/类型白名单由权限点配置决定。

### 3.3 fs 威胁建模清单

| # | 攻击方式 | 防御 | 测试用例 |
|---|---|---|---|
| F1 | 路径穿越：`../../etc/passwd` | realpath + 前缀校验 | 穿越路径被拒 |
| F2 | 符号链接逃逸：数据目录内软链指向 /etc | 逐级 lstat + O_NOFOLLOW | 软链读被拒 |
| F3 | 特殊文件：读 `/dev/urandom`、`/proc/self/mem` | 黑名单 | 特殊路径被拒 |
| F4 | 放大攻击：读超大文件 | 大小上限 | 超限截断/拒绝 |
| F5 | TOCTOU：校验后文件被换 | realpath 结果直接用于打开（校验与打开同一次 syscall 路径） | 竞态测试 |
| F6 | 写覆盖宿主文件：写 `../config.json` | 前缀校验 + 父目录校验 | 越界写被拒 |
| F7 | 硬链接逃逸：指向作用域外 inode | lstat 检查 nlink/ino | 硬链接写被拒 |

---

## 4. 审计字段（exec 与 fs 通用）

```
{ts, pluginId, method, templateAction/op 或 fsPath(摘要), paramsDigest,
 result(ok|denied|timeout|error), permission:{decision, reason},
 durationMs, outputBytes}
```

- 路径类参数落**摘要/哈希**（完整路径可能含敏感信息）；
- 凭据相关操作（defaults-extra-file 生命周期）单独审计（创建/删除时间戳）。

## 5. 测试清单（P1 验收用）

- [ ] E1–E8、F1–F7 全部有自动化测试用例；
- [ ] 恶意参数语料（注入串、穿越串、超长输入）通过 fuzz 框架跑；
- [ ] 并发测试：同插件并发调 exec/fs，权限判定无竞态；
- [ ] 审计日志完整性：每个调用一条记录，无丢失；
- [ ] 权限拒绝路径：deny 时不执行任何副作用（命令不跑、文件不写）。

## 6. 后续演进

- 本清单是**驱动插件方法评审的模板**——社区贡献 db/ssh 能力时，按同样格式补威胁建模；
- 模板注册表与权限注册表联动：新增模板自动生成权限点（api-contract §6）。
