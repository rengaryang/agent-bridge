# Compatibility evidence — native and context-only stage

0.3新增context-only，与archive模式共存。包只保留一个语义检查点，无源events.jsonl/工具payload/执行历史；native Pi/OMP只注入custom checkpoint，不恢复原user/assistant图。Pi1.5.1 custom-only会话延迟落盘时，用SDK生成的header/entries独占发布后原生open确认，没有伪造聊天回合。tests/context-only.test.ts覆盖六方向handoff准备、旧包转换、包成员夹带拒绝及Pi/OMP单检查点冷加载。

仅保守标签提取或显式checkpoint，不调用模型；事实/结论必须复核，非通用自动总结。archive原生历史与context-only语义检查点的保真边界不同。旧用户源/归档不被删除。


本机基线：macOS arm64，Node v22.23.2，OMP CLI18.16.0，Codex CLI0.155.1。Pi不在全局PATH；项目锁定Pi SDK1.5.1，OMP SDK18.16.0与Bun1.4.4。

## 原生存储适配

Pi：`@earendil-works/pi-coding-agent/dist/core/session-manager.js`，基于包1.5.1的真实SessionManager.create/appendMessage/appendCustomMessageEntry/open/buildSessionContext；创建新JSONL后独立Node进程cold open。Pi存储manager无close接口，writer同步关闭每次写入，退出进程形成冷恢复边界。

OMP：`@oh-my-pi/pi-coding-agent/src/session/session-manager.ts`，包18.16.0；create/appendMessage/appendCustomMessageEntry/ensureOnDisk/flush/close和async open，使用Bun1.4.4。必需`@oh-my-pi/pi-natives-darwin-arm64`显式安装。native孤立stage只读原生projection不触发AgentSession。

两者均保留user/assistant角色，但tool protocol转为历史文本，custom/summary映射为custom_message，不声称原生全部图/私有扩展保真。storageContext cold restore与append已验证；真实TUI/model continuation尚未验证，compatible runtime仅当前锁定版本和平台。

## Codex实验字段

`docs/codex-schema` 来自0.155.1标准生成，ThreadResumeParams只公开threadId及配置等。

`docs/codex-schema-experimental` 来自同一binary加`--experimental`生成，公开history/path：history描述为`[UNSTABLE] FOR CODEX CLOUD - DO NOT USE`，path为unstable rollout路径。只读取schema，没有调用实验history RPC或伪造rollout，因此目标Codex Structured保持unsupported，Handoff保持PREPARED。

这个发现解释此前标准schema说明/属性差异，不应再简单说“Codex完全没有history字段”。公开稳定保证与隐藏实验能力要分开。

## 证据与限制

- runtimes/pi/package.json / package-lock.json锁定Pi依赖。
- runtimes/omp/package.json / package-lock.json锁定OMP/Bun/native addon，zod间接依赖覆盖到4.6.6并运行存储回归。
- tests/native.test.ts覆盖独立进程cold storage、append、幂等、四方向、CLI以及错误边界。
- SDK底层依赖是第三方可信计算基，OS阻止网络/外写，但非完整读取隔离。
- source decoder仍preview，未完成与所有真实版本native reducer的parity；不支持无限制未知字段，出现未知语义则阻塞。

公开项目依据：
- https://github.com/earendil-works/pi
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/session-format.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- https://raw.githubusercontent.com/can1357/oh-my-pi/HEAD/docs/session.md
- https://developers.openai.com/codex/app-server/
