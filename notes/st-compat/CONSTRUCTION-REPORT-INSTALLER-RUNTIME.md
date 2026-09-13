# ST 兼容施工报告 —— P2 安装器运行时闭环（dev/st-extension-installer-runtime）

日期：2026-09-13。任务：把只读扩展分析器补成完整但**默认不执行扩展代码**的安装系统（ST-Prompt-Template 兼容试点的前置）。

## 派工单回执

- 基线：`413fbad979bee059e679ab2c4082fa004ca388d4`（PLUGIN_KERNEL_BASE 后的验收基线，为 `dev/system-plugins` 祖先）
- 施工分支：`dev/st-extension-installer-runtime`；worktree：`D:/workspace/小项目/iris-st-extension-installer-runtime`
- 实际切出点：`dev/system-plugins` HEAD `4ade2b2`（该 HEAD 已包含 P2 分析器 `a3d1d9c` 与 lockfile 收口 `934ae1c`；基线 413fbad 上分析器尚不存在，任务要求"把现有扩展分析器补成……"，故从含分析器的集成分支顶端开工）
- 合并目标：`dev/system-plugins`
- 最终完整 SHA：本报告随实现同一提交落盘，以仓库 HEAD 为准（即包含本文件的提交）。

## 实现

新增 `packages/iris-extension-installer/`（`@iris/extension-installer`，零运行时依赖，ESM，node --test 直跑 TS，与 analyzer 同约定）：

| 模块 | 职责 |
| --- | --- |
| `src/source.ts` | 三种来源（local-archive / local-directory / git 固定提交）；仅接受 https://（file:// 仅为测试选项）；仅接受 40-hex 完整 commit（移动 ref 会让 lock 说谎）；git 以固定 argv spawnSync `git`，每条命令 `-c core.hooksPath=` 禁钩子、`--no-recurse-submodules`、`GIT_TERMINAL_PROMPT=0`，checkout 后 `rev-parse HEAD` 必须等于 pin |
| `src/archive.ts` | zip 中央目录解析（store/deflate，zlib），全守卫提取 + 受控目录拷贝 + 事后越界审计 |
| `src/hash.ts` | 文件 SHA-256 与确定性树哈希（排序后 `relPath\0fileHash\n` 再哈希），跨平台可复现 |
| `src/lock.ts` | `InstalledExtensionLock` 写入与严格解析（每个字段类型检查，`enabled` 必须恰为 `false`） |
| `src/transaction.ts` | `ExtensionInstallTransaction` 状态机（downloading→staged→validated→hashed→promoting→installed，任意点→failed），txn.json 存于 staging 内、原子写 |
| `src/staging.ts` | 目录布局（staging/claims/installed）+ 每扩展 O_EXCL 安装声明（并发拒绝、stale 声明按证据接管） |
| `src/recovery.ts` | 只读证据扫描 + 逐例处置（矩阵见下） |
| `src/installer.ts` | 编排：先 staging 后提升；lock 写入后才算 installed；成功后自清 staging；绝不置 enabled；不执行任何来自产物的代码 |

磁盘布局（`<root>` 由调用方给，无自动越权路径）：

```text
<root>/staging/<txnId>/txn.json + material/content/   # 在途事务
<root>/claims/<extensionId>.lock                      # O_EXCL 并发声明
<root>/installed/<extensionId>/lock.json + 产物        # 提升完成
```

## 关键问答（任务要求逐项）

**真实安装目录与 staging 目录**：如上布局；事务记录里的 `stagingPath`/`targetPath` 是绝对路径、随 txn.json 持久化，恢复扫描以它们为唯一事实源。

**原子提升方式**：`fs.rename(content → installed/<id>)`（同卷目录改名，单步原子）+ 之后同目录临时文件 rename 写 `lock.json`。两步无法合成一个原子操作，因此正确性由证据规则保证：**有目录无 lock = 未安装**（现场回滚或由 recovery 删除），**有 lock = 安装完成**（recovery 确认完成、清理 staging）。提升全程持有每扩展声明锁。

**Windows 上符号链接和 junction 的拒绝方式**：
- zip 条目：中央目录 unix mode 高 16 位 `S_IFMT == S_IFLNK` → 创建前拒绝（`symlink`），绝不生成链接再删。
- 本地目录源与事后审计：每个条目 `lstat`，`isSymbolicLink()` 为真即拒绝——Windows 上 junction 经 libuv 同样上报为 symlink，故 junction 由同一检查覆盖（测试用真实 `fs.symlinkSync(..., 'junction')` 夹具验证）。
- 审计 `auditContainment` 在提取/拷贝**之后**重走整树：任何 symlink/junction、任何解析出根的路径都拒绝（守卫与审计独立取证）。

**崩溃恢复矩阵**（recovery.ts 的每行处置，测试全部覆盖）：

| 现场证据 | 处置 |
| --- | --- |
| staging + txn 阶段 downloading/staged/validated/hashed | 删 staging，rolled-back |
| staging + txn 阶段 failed | 删 staging，already-failed |
| staging + txn 阶段 promoting + 目标 lock 有效 | 删 staging，completed（安装被确认） |
| staging + txn 阶段 promoting + 目标无 lock | 删目标 + staging，rolled-back |
| staging + txn 阶段 installed（staging 残留） | 删 staging，completed |
| staging 无可读 txn.json | 删 staging，orphaned |
| installed/ 下无有效 lock.json 的目录 | 删除，lockless-target（绝不被列出/启用） |
| claim 的 owner 事务不存在或已终结 | 删 claim，stale-claim（扩展不再被卡死） |

**lock 文件示例**（真实测试产物形状）：

```json
{
  "extensionId": "demo-ext",
  "source": { "kind": "git", "repository": "https://…", "commit": "f9a07da0fbe25cd310eee746c2f5af24ed61f62b" },
  "resolvedCommit": "f9a07da0fbe25cd310eee746c2f5af24ed61f62b",
  "artifactSha256": "87285f97b91842e9027b9c2ef23e2d18f8fb3f09f79518e522a152c5d257fb9b",
  "installedAt": "2026-09-13T08:21:07.412Z",
  "enabled": false
}
```

**攻击夹具及结果**（zip 夹具全部由测试内自建 zip 写入器构造，无二进制夹具、无第三方依赖）：

| 夹具 | 结果 |
| --- | --- |
| `../../outside.js`、`a/../../outside.js` | 拒绝 `traversal` |
| `/absolute/path.js` | 拒绝 `absolute-path` |
| `//server/share/x.js` | 拒绝 `unc-path` |
| `C:/evil.js`、`C:evil.js` | 拒绝 `drive-letter` |
| `C:\evil.js`（反斜杠） | 拒绝 `bad-name`（反斜杠先拒） |
| `a/./b.js`、`a//b.js`、`stream:hidden.js`（冒号/ADS） | 拒绝 |
| `a/CON`、`a/NUL.txt`（Windows 保留设备名） | 拒绝 `reserved-name` |
| `dist/index.js` + `dist/INDEX.js`（大小写碰撞） | 拒绝 `case-collision`（目标卷按 NTFS 论证） |
| 完全同名重复条目 | 拒绝 `duplicate-entry` |
| unix symlink 条目 | 拒绝 `symlink`，链接从未被创建 |
| 目录源内真实 junction（win32） | lstat 拒绝，零字节被跟随 |
| 解压后逃出 staging | 名称守卫前置拒绝 + `auditContainment` 事后兜底（独立取证） |
| 声明 300 MB 的 deflate 条目（几何谎言） | 解码后长度不符拒绝（`corrupt`/`zip-bomb`） |
| 加密条目、非 zip 字节、非常见压缩方法 | 拒绝 `encrypted`/`not-zip`/`bad-method` |
| 下载中断（AbortSignal / 截断拷贝） | `aborted`/`truncated`，事务 failed、staging 自清 |
| promotion 前中断 | 上表 rolled-back 行 |
| promotion 完成但 lock 未写 | 上表：目标按"无 lock = 未安装"回滚 |
| lock 已写但 staging 未删 | 上表 completed 行 |
| Git 实际 HEAD ≠ 固定提交 | fetch pin → checkout → `rev-parse` 比对，不符拒绝 `head-mismatch`；pin 不存在拒绝 `git-failed` |
| 同一扩展并发安装 | O_EXCL 声明：第二方拒绝 `InstallClaimBusyError` 并指名 owner；先后两次安装由 already-installed 检查拒绝（无静默覆盖） |

**全部测试结果**：

- 安装器：`node --test packages/iris-extension-installer/tests/*.test.ts` → **29 pass，0 fail，0 skipped**
- 分析器回归：`node --test packages/iris-compat-st-extension/tests/*.test.ts` → **10 pass，0 fail**
- 根 `npx tsc -p . --noEmit` → exit 0
- `git diff --check` → 干净
- 工作树内依赖解析：本机 pnpm 离线校验器无法完成安装（2079dbe 记录在案），沿既有做法把主 worktree 的各 importer `node_modules` junction 进本 worktree 跑门，未提交。
- 全量 `packages/* + apps/iris` 半边：2228 tests，2208 pass，10 fail，10 skipped。**10 个 fail 全部是 `iris-compat-prompt-template/tests/host.test.ts` 的子进程沙箱用例**（"evaluator produced no result for require/process/fetch/import"）：该包用 Node `--permission` + `--allow-fs-read=<目录>/*` 锁子进程，junction 化的 node_modules 让授权目录与 realpath 不一致，读盘被拒。环境性而非回归——同一文件在 `dev/system-plugins` worktree（真实目录）15/15 通过；该包不在本任务允许修改清单内，故不在此修。

## 有意未实现（后续批次）

- 纯 HTTP 发布包下载（runbook §1：第一版只收本地包与 HTTPS Git）；tar.gz 提取（ST 生态发行物为 zip；接口已按 `extractLimits` 预留）。
- 更新/切换/回滚事务与旧版本共存活（`installAs` 对已安装 id 明确拒绝，更新是独立事务）；卸载。
- `enabled:true` 的任何路径——安装与激活是两个系统；启用属 SystemPluginRuntime。
- manifest 全量规范化与模块图分析（analyzer 包职责）；安装器只做最小门（manifest.json 存在、js 为相对树内路径且文件存在），包间衔接在 P3。
- 表达式 dynamic import 数据流等分析器遗留项（P2 报告已记录）。

## git diff --stat / git status --porcelain

见提交信息随附（提交时以 `git show --stat HEAD` 与 `git status --porcelain` 为准；本 worktree 提交后 status 应为空）。

## 追记（dev/plugin-fix-installer-git-contract）：缺陷二 —— git 来源的合同统一与 .git 剥离

**缺陷**：manifest/入口门只对 local-archive/local-directory 执行，git 来源绕过（一个没有 manifest 的仓库可以直接走完哈希与提升）；且 git 物化把克隆元数据 `.git/` 一并留进内容树——污染产物哈希（同一工作树在不同机器上克隆出不同的 .git 内容 → 不同的 artifactSha256，lock 不可复现），克隆目录还被原样提升进安装树。

**修复**（installer.ts）：① `requireManifest` 移出 local-only 分支，validated 阶段对三种来源统一执行——分析器的合同对象是产物，不是传输方式；② git 来源在守卫与 manifest 门之前、哈希与提升之前删除 `content/.git`（`fs.rm` 带重试，吸收 Windows 只读对象文件的 EPERM）。

**新增测试（source.test.ts，2 条）**："无 manifest 的 Git 仓库拒绝"——同一 manifest 门拒绝 git 来源，事务失败、staging 自清、无提升；"不同克隆元数据但相同工作树得到相同产物哈希"——两个独立仓库、字节相同的工作树、相差六年的作者时间戳（commit SHA 必然不同），安装后 artifactSha256 相同，且安装树内无 `.git`。

**红绿验证**：两条新夹具对未修复代码 2/2 失败（4 pass / 2 fail），修复后 6/6 过。门：安装器 31 + 分析器 10 = 41 pass 0 fail；根 tsc exit 0；`git diff --check` 干净。
## 追记（dev/plugin-fix-installer-recovery-containment）：缺陷一 —— 恢复容器逃逸修复

**缺陷**：恢复扫描的 promoting 分支直接信任 txn.json 里的 `targetPath`/`stagingPath`。txn.json 是磁盘上可篡改的文件：伪造一个 promoting 事务把 `targetPath` 指向安装根之外，恢复按"无 lock = 未安装"的规则删除该路径——一个由单个伪造 JSON 驱动的删除任意目录的武器；同理可让根外带 lock 的目录被确认成"已完成安装"。

**修复**（recovery.ts）：事务记录是"意图证据"而非"指令"。staging 路径一律用扫描到的真实目录；目标路径唯一来源是 `deriveTargetPath(layout, txn)` —— extensionId 先过与安装同一的 `isValidExtensionId`，再 `path.resolve` 断言落在 targetsRoot 内。派生失败（非法 id / 越界派生）记新 outcome `untrusted-transaction`：只删 staging，其余一概不碰。promoting 的确认与回滚只看派生目标上的 lock。

**恶意 txn.json 夹具（新增 3 条，均含 sentinel 断言）**：① 合法 id + targetPath 指根外带 sentinel 的目录 → 恢复后 sentinel 存在、伪造 stagingPath 指针不被使用、staging 清理、rolled-back；② 非法 id（`../evil`）→ `untrusted-transaction`，根外不动；③ targetPath 指根外且那里预置有效 lock → 不得确认完成，根外目录与 lock 原样保留。

**红绿验证**：三个夹具对未修复代码 3/3 失败（13 pass / 3 fail），修复后 16/16 过。门：安装器 32 + 分析器 10 = 42 pass 0 fail；根 tsc exit 0；`git diff --check` 干净。
