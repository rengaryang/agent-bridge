# agent-bridge

跨 Pi / OMP / OpenAI Codex CLI 的本地会话迁移 CLI，名称 `abridge`。当前版本 **0.3.0 preview**。

## 推荐：只迁移上下文和结论

新增 `--profile context-only`，与完整归档 `--profile archive` 并存。profile 控制**保留什么**，mode 控制**怎样恢复**，二者正交。

context-only 会创建全新的语义检查点包：只含目标、约束、必要背景、来源陈述的事实、结论/决策、产物引用、进度、下一步和待核实风险。不保留源 session id/path、event ids、命令、tool参数/结果、流式过程、历史message图、provider usage或扩展payload；包内没有 `events.jsonl`。用于来源关联的digest只由检查点内容计算。

已有 archive 用 `--profile context-only` 导入时，先转换并重新编码，输出中的 `source.acx` 也只是检查点包，**不暗藏旧archive副本**。旧源会话/旧archive不会被删除或改写；失去的分支与过程追溯不能通过context-only恢复。

### 生成方式与核实边界

默认是无模型、保守的标签提取，只识别明确单行标签：`Goal:`/`目标：`、`Constraint:`/`约束：`、`Background:`/`背景：`、`Fact:`/`事实：`、`Conclusion:`/`结论：`、`Decision:`/`决策：`、`Artifact:`/`产物：`、`Progress:`/`进度：`、`Next step:`/`下一步：`、`Risk:`/`风险：`。仅从有效上下文抽取，工具结果不参与，源system/developer不参与，代码围栏和无标签过程文本不复制。用户目标和约束只从user标签提取。

这不是语义模型摘要：未标注的背景或最终结论可能不被提取，矛盾/重复目标不会自动裁决；无法抽出明确目标时失败，提示提供结构化checkpoint，不会偷塞完整对话兜底。所有事实、结论、进度均为**待复核的来源陈述**，`reviewRequired: true`，不是独立验证。

建议先人工整理 `docs/checkpoint.example.json`，再用 `--checkpoint <json>` 明确控制迁移内容。字段严格白名单，命令标记/代码围栏/工具历史格式拒绝，长度和数量有限；**规则不能识别任意自然语言中伪装的执行过程**，仍需人工复核你的checkpoint。没有调用LLM或将源内容上传。

未闭合动作仅保留“结果未知、先核实当前工作区与外部状态”的通用风险，不复制命令/工具名/call id；explicit checkpoint也不能默默抹掉这条风险。未知语义或缺资源必须提供人工替代checkpoint并保留复核风险。

### 直接使用

```bash
node dist/cli.js export --from pi --session SOURCE.jsonl --out context.acx --profile context-only
node dist/cli.js inspect context.acx
# 提供自己整理的checkpoint，适合未标注自然语言历史
node dist/cli.js export --from pi --session SOURCE.jsonl --out context.acx --profile context-only --checkpoint CHECKPOINT.json
# 任意目标的交接准备；Codex仍非自动原生恢复
node dist/cli.js import context.acx --to codex --cwd REPO --out OUTPUT --mode handoff
# Pi/OMP原生会话只注入一个语义检查点，不恢复原聊天历史
node dist/cli.js import context.acx --to omp --cwd REPO --out OUTPUT --mode structured
# 一步从源会话迁移
node dist/cli.js migrate --from omp --session SOURCE.jsonl --to pi --cwd REPO --out OUTPUT --profile context-only --checkpoint CHECKPOINT.json --mode structured
```

输入已经是context-only，plan/import未填profile会维持该profile。显式要求archive时拒绝，不能凭空还原剔除记录。handoff预算容纳不下整个checkpoint时失败，要求显式缩减，不能静默省略约束和风险。原生checkpoint只含custom_message，不生成伪造user/assistant历史；Pi custom-only延迟落盘用SDK生成的header/entries安全发布后原生open验证。


## 当前能做什么

- 只读解析 Pi/OMP JSONL 树与 Codex 基础 rollout，生成有效上下文与来源映射；支持分支、Pi context_edit、可读 compaction、OMP reset 和基础 Codex rollback。
- `.acx` 导出、校验、尽力脱敏与 handoff 准备；六方向离线交接准备。
- **Pi 1.5.1 / OMP 18.16.0 原生 SessionManager 导入**：创建新身份，持久化原生 JSONL，另一个进程冷加载，并核验上下文。
- 原生恢复后可追加合成用户消息并再加载；重复导入幂等，新增会话消息不被覆盖。原始导入前缀损坏时拒绝。
- 全量73个测试通过，其中29个context-only测试、13个native测试；类型检查、编译、格式检查和三处依赖审计通过，审计返回0个已知漏洞（当次公告快照）。
- `verify` 区分 PREPARED 交接材料与 NATIVE_CONTEXT_VERIFIED 原生存储结果；`resume` 只输出恢复 argv，不自动启动模型。

本版本 **archive + Structured 是有损原生会话迁移**：user/assistant 角色保留；工具调用/结果转为 inert 历史文本，summary/custom 转为带来源的 custom_message，选定分支线性化。原生 runtime、system/developer、provider replay、权限与子 agent 作业不恢复。不是无损原生历史复制。

## 已验证与未验证

已验证：Pi/OMP 原生 SDK 的 create → 持久化 → 独立进程 open → context 检查 → 追加合成 user → 再 open，以及四个跨 agent 方向 Pi→OMP、OMP→Pi、Codex→Pi、Codex→OMP。使用合成 fixture，不调用模型。

**未验证**：真实模型下一轮、交互 TUI 续聊、所有来源版本/扩展、provider wire replay、超大上下文、生产工作区一致性。NATIVE_CONTEXT_VERIFIED 不能理解成六方向完整 READY。

**Codex 目标仍只提供 handoff**。本机 Codex 0.155.1 标准 schema 不公开 history/path；实验 schema 含这两个字段，但 history 明确标为 cloud-only / do not use，因此不作为稳定产品入口。

## 安装和测试

离线核心需要 Node.js 22.13+。原生阶段需要 **macOS arm64 + Node.js 22.19+ + sandbox-exec**；OMP 使用项目内锁定 Bun 1.4.4，不安装全局运行时。

```bash
npm ci --ignore-scripts
npm run setup:native
npm run check
node dist/cli.js agents
```

`setup:native` 只给项目中的 `runtimes/pi` 与 `runtimes/omp` 安装已锁定依赖，禁用 lifecycle scripts、非必需 optional 包。OMP 必需 Darwin arm64 native addon 已显式列为依赖；Bun与SDK版本锁定。OMP的 zod 间接依赖在项目运行时中覆盖到已修复版本，并通过存储测试。

没有原生运行时或不在支持平台时，可构建后运行 `npm run test:offline`。全量 `npm run check` 包含 native 测试，缺运行时会失败，而不是偷偷跳过。

测试全部为合成数据、OS 临时目录；不读取或修改用户真实 agent 会话，不调用模型，不重放历史工具。临时路径只能删除当前测试自己创建的内容。

## 使用

以下 SOURCE.jsonl / REPO / OUTPUT 是你选择的实际文件和目录。

```bash
node dist/cli.js export --from pi --session SOURCE.jsonl --out work.acx
node dist/cli.js inspect work.acx
# OUTPUT 必须已存在。原生结果安装在 OUTPUT/native-... 内
node dist/cli.js plan work.acx --to omp --cwd REPO --mode structured
node dist/cli.js import work.acx --to omp --cwd REPO --mode structured --out OUTPUT
node dist/cli.js verify OUTPUT/native-...
node dist/cli.js resume OUTPUT/native-...
```

`resume` 输出 `omp --resume <session.jsonl>` 或 `pi --session <session.jsonl>` 的 argv，默认禁用工具、扩展、skills与context files，并限定 session-dir。你手动启动兼容目标 agent 时，需 **显式选择当前可用模型**（历史模型元数据可能不可用）。是否打开当前工具，由你明确决定；历史工具不是待重放任务。恢复 argv 未被本版本做 TUI/真实模型验证。

原生结果中包含 `source.acx`、`compilation.json`、`sessions/<new-session>.jsonl`、`receipt.json` 和独立 `isolation` 状态目录。源码身份与目标会话身份分离，所有 writes 在显式输出目录。

向 Codex 或仅准备交接：

```bash
node dist/cli.js import work.acx --to codex --cwd REPO --mode handoff --out OUTPUT
node dist/cli.js resume OUTPUT/PREPARED_DIRECTORY
```

handoff 只生成材料，状态 PREPARED，需要手动提交历史交接内容与下一步请求。默认 `--mode auto` 继续维持 handoff 行为，不自动升级为 native；`--mode structured --to codex` 显式失败，不静默降级。

直接迁移：

```bash
node dist/cli.js migrate --from omp --session SOURCE.jsonl --to pi --cwd REPO --mode structured --out OUTPUT
```

同键重复导入返回已有且校验通过的结果；导入中断留下不完整 staging 时失败关闭，不盲重试、不自动覆盖。SQLite事务恢复未实现。

## 保真与安全边界

- worker 只加载锁定 SessionManager 存储模块，不初始化 AgentSession、不注册工具或加载用户扩展。worker env 白名单、独立 HOME/XDG/agentDir；macOS OS策略禁止网络与输出根以外写入。
- OS策略目前**允许读取文件**，不是完整读取隔离；存储worker不主动读取用户认证/配置。工作区绑定只验证目录可访问，不证明文件/commit与源相同。
- 不执行历史 system、developer、approval、session_init、MCP、任务或 cache。工具历史文本明确标注来源；pending 状态是 outcomeUnknown，后续重试前须核查外部状态。
- 不复制 auth.json、OAuth、cookie或系统凭据。安装第三方依赖需要网络，但解析/导入/验证禁止worker网络，且不调用模型。
- 脱敏是 best effort，**不保证无秘密**；包可能含路径、代码、个人信息、自定义内容。分享前人工审阅。provider/私有推理块剔除，所以 ACX 不是无损字节备份。
- 目前不打包附件或多子agent实体；活跃资源引用/未知语义会阻塞迁移。离线快照只取已持久化记录，不能证明实时 active leaf/队列完整。
- archive + Structured 保留全部有效文本，没有完成目标模型 token窗口检查；context-only只保存checkpoint。若窗口过小应使用 handoff预算编译或缩小源快照。handoff预算是UTF-8字节估计，非精确tokenizer。
- archive 中 native assistant若没有测量usage，必需字段使用零形状占位，同时在迁移记录/losses标注 unknown；不能将这些字段解释为真实零成本。历史模型/stopReason重建是有损投影，需显式选择目标模型。
- verify保留导入字节前缀与上下文前缀，可接受真实append；目标native CLI如果重写title/原始条目、compact/rewind，会使验证失败，不代表会话无法使用；本版本不自动重签。
- 单源32 MiB、单JSONL 4 MiB、10万条目；ACX总展开64 MiB、单成员32 MiB，内存ZIP，不支持ZIP64、多卷、加密成员、data descriptors、symlink或未声明成员。
- Checksum不是身份认证；receipt/staging需用户控制。尚未完成全部TOCTOU、多对象事务和掉电恢复。

## 后续阶段

1. 真正目标 CLI 启动和无副作用真实模型续聊验证，目标模型配置与token预算。
2. source effective projection与上游原生reducer的更多parity fixtures，包括新OMP activeLeaf字段。
3. SQLite journal + interrupted staging reconciliation、会话发现与更丰富资源迁移。
4. Codex稳定目标导入路线、工作区Git绑定/patch、多agent图、加密与严格脱敏。

详见 `docs/compatibility.md` 与 `docs/development-status.md`。

## 上游协议快照

完整 Codex schema 是可再生的本地参考资料，不纳入 Git 提交。需要核实时使用对应 Codex 版本生成：

```bash
codex app-server generate-json-schema --out ./docs/codex-schema
codex app-server generate-json-schema --experimental --out ./docs/codex-schema-experimental
```

这些命令只生成协议文件，不代表实验接口适用于生产迁移。上游 SDK、Bun 和 native addon 通过锁文件安装，不随源码仓库分发二进制。
