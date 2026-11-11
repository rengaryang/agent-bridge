# Agent Bridge Implementation Plan

**Goal:** 在指定目录开发本地优先 CLI，把 Pi/OMP/Codex 已持久化会话转换为可校验迁移包和可继续工作的交接材料。

**Architecture:** 只读 native snapshot → agent adapter → canonical IR/effective context → ACX archive → migration plan → prepared handoff。原生恢复采用版本门控；本轮不调用模型，不写入真实 agent 数据目录。

**Tech Stack:** Node.js 22、TypeScript ESM、Ajv、fflate、Commander、Vitest。SQLite 元数据 journal 后续接入原生恢复阶段；首个离线切片以不可覆盖的 receipt 与内容指纹实现幂等。

## Task 1 工程和能力探测

Files: package.json、tsconfig.json、src/core/probe.ts、docs/compatibility.md。
先只读获取二进制版本和 Codex schema；锁定 npm 依赖，初始化本地 Git，不绑定远端、不推送。

## Task 2 Parser 与 IR（测试先行）

Files: tests/adapters.test.ts、src/core/types.ts、src/core/validation.ts、src/core/snapshot.ts、src/adapters/tree.ts、src/adapters/codex.ts、src/adapters/index.ts。
覆盖坏行、重复 id、孤儿/循环、选定 leaf、多分支、OMP title/reset、Pi context_edit/compaction、Codex repeat/dedup/rollback、未闭合工具与未知字段。unknown semantic effects 要阻塞/警告。

## Task 3 ACX 与编译（测试先行）

Files: tests/bundle.test.ts、src/core/bundle.ts、src/core/handoff.ts、src/core/migration.ts。
校验所有成员 path/hash/size，限制压缩包和单记录大小；不解包到任意路径。先脱敏后签名/摘要。交接材料保留 sourceRefs，不把历史指令升级为 system。

## Task 4 CLI E2E

Files: src/cli.ts、tests/cli.test.ts、README.md。
实现 agents/export/inspect/plan/import/migrate/verify/resume。首版 import 生成 PREPARED 交接材料，resume 输出 argv 和材料路径而不自动启动。structured 请求必须显式拒绝，不能偷换为 handoff。

## 执行与验收

每个任务先运行对应测试得到失败，再实现最小通过版本，再补边界测试。最终 npm run check 与打包 CLI smoke test 必须通过。安全校验失败不标完成。

本轮完成标准是离线切片可运行，不是六方向原生冷恢复已完成。后续 Milestone 0 锁定 Pi/OMP SDK 与 Codex 原生导入路径，再实现 worker、SQLite journal、native install、冷恢复；工作区 patch、自动模型 bootstrap、加密与附件实体打包不伪称已实现。
