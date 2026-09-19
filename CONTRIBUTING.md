<p align="center">
  <img src="assets/brand/iris-story-seal-variant-c-transparent-v1.png" width="72" alt="Iris">
</p>

<h1 align="center">参与贡献</h1>

<p align="center">把改动做小，把行为说明白，把验证留在代码旁。</p>

<p align="center">
  <a href="README.md">项目首页</a> ·
  <a href="docs/README.md">文档目录</a> ·
  <a href="docs/USER-GUIDE.md">使用手册</a>
</p>

---

## 开始之前

Iris 面向真实角色卡和本地聊天数据。兼容性改动需要说明对应的上游行为，并尽量留下可重跑的测试；只有夹具通过，还不足以证明真实卡片可用。

需要 Node.js 24+、pnpm 10 和 npm。根工作区使用 pnpm，Web 子项目使用 npm；不要互换锁文件。

```sh
pnpm install --frozen-lockfile
npm --prefix apps/iris-web ci
pnpm build:web
pnpm start
```

前端开发见 [Web 指南](apps/iris-web/README.md)，模块边界见[项目架构](docs/ARCHITECTURE.md)。

## 分支与协作

- 通过 PR 合入 `main`，不直接推送 `main`；保持分支聚焦一个主题，合入前对齐最新主线。
- 每条并行分支使用独立 worktree，及早推送，避免改动只留在本机。分支名遵循当前任务约定；人工开发可使用 `dev/<topic>`。
- 提交前重新查看状态，只暂存本次改动的明确文件。共享工作区中不要使用 `git add .`、`git add -A` 或整目录暂存。
- 不覆盖其他人的修改，不擅自安装依赖、重启共享宿主，或覆盖正在被服务的构建产物。
- 确认 PR 已合并后再清理分支；检查通过不等于合并完成。

提交说明写清“为什么改”，必要时注明 AI 协作的 `Co-authored-by`。测试和提交分开执行，不让提交掩盖失败的检查。

## 提交前检查

从仓库根目录运行：

```sh
pnpm run typecheck
npm --prefix apps/iris-web run typecheck
pnpm build:web
pnpm test
pnpm run test:no-corpus
npm --prefix apps/iris-web run check:render
```

前端构建放在相关测试之前。`test:no-corpus` 用于验证不依赖本地私有语料的路径；不要把它当成真实卡片验收的替代品。CI 配置见 [.github/workflows/ci.yml](.github/workflows/ci.yml)。

修改 `plugin-api`、`plugin-web-api` 或 `protocol` 后，还应按[契约打包说明](docs/PLUGIN-CONTRACT-PACKAGING.md)验证独立包消费。

### 测试应说明什么

- 覆盖正常路径，也证明拒绝、撤销、回滚等反向路径确实触发。
- 缺少本地语料时显式跳过并说明原因，不用提前 `return` 冒充通过。
- 时序测试优先比较比例和顺序，避免绑定某台机器的绝对耗时。
- 真实语料测试按内容形状选择样本，不绑定活目录中的文件名或精确数量；断言不变量或有余量的下限。每次遍历还要断言实际比较数量的下限，避免空遍历假通过。精确普查数字放入带日期记录与只输出统计的脚本。
- 不同场景使用不同夹具；验收表中每个勾选项都要有对应证据。
- 记录实际运行的命令与结果，未运行的检查直接注明。

## 不能悄悄改变的边界

| 边界 | 要求 |
| --- | --- |
| 网络入口 | 默认回环监听，保留 Host 检查；远程访问需另行配置认证和 HTTPS |
| 卡片与插件 | 卡片有 iframe 边界，系统插件与宿主同权，不能混称“沙箱插件” |
| 模板执行 | EJS 默认关闭，启用后使用独立执行路径；不得隐式开启 |
| 变量兼容 | 不随意改变 `pruneVariables: false` 等兼容默认值 |
| 密钥与数据 | 不提交密钥、`.env`、`data/`、`测试用卡/` 或个人聊天内容 |
| 宿主进程 | 一个数据目录只运行一个宿主 |
| CI 依赖 | Action 固定到完整 40 位提交，并在旁边保留可读版本说明 |

构建产物、`dist/`、`public/sandbox/` 与 `.reference/` 不作为普通源码改动提交；需要更新受控产物时遵循对应目录的现有约定。

## 文档与溯源

工具不得读取或打印 `key.txt`；不要把本地密钥文件当作调试输入。

<!-- 保留供密钥保护检查读取的原约束：`key.txt` is never read or printed by tooling either -->

用户可见行为改变时，同步更新 README 或对应指南；接口变化更新[接口参考](docs/INFRASTRUCTURE-INTERFACES.md)。文档入口见[文档目录](docs/README.md)。

`docs/` 写现行用法，`notes/` 保留带日期的调查与验收。不要把历史记录改成当前状态；发现旧结论有误，补充更正与证据。

修改上游转录代码时保留版本、来源和差异说明，并搜索所有引用它的文档与注释。新增第三方代码需更新[第三方说明](THIRD-PARTY-NOTICES.md)，不要猜测版权所有者或删去待核实项。
