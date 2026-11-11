# Context-only Implementation Plan

Goal: 迁移包与目标会话只保存语义检查点，不夹带历史记录、命令、tool结果、原生session字段或过程性对话。完整archive模式保持兼容。

Architecture: source有效context → 保守标签提取（无LLM）/显式checkpoint JSON → 严格SemanticCheckpoint → synthetic canonical单条检查点 → 仅checkpoint/profile包 → existing handoff/native。旧archive转换时重编码新包，不复制旧source.acx。profile与mode正交。

Files: src/core/checkpoint.ts、types.ts、validation.ts、bundle.ts、handoff.ts、native/compiler.ts、cli.ts；tests/context-only.test.ts。

Steps:
1. 先写包成员/执行marker剔除、提取标签、pending风险、无标签失败、bundle非法注入、native/CLI不留raw测试，运行失败基线。
2. SemanticCheckpoint用goal/constraints/background/facts/decisions/artifacts/progress/nextSteps/risks数组；来源陈述不等于独立核验，保留reviewRequired。无标记文本一律不复制；含工具marker、code fence或执行过程的字段拒绝。
3. context-only canonical固定单synthetic事件与checkpoint文本，丢弃原source path/session id、原event ids、raw、usage/provider、工具调用及结果；source摘要只作快照关联。
4. context-only ACX只有manifest/session/checkpoint/context/handoff/report，不许events.jsonl。decode重建并比较标准投影、严格拒绝额外字段/不同profile混包。
5. CLI --profile archive|context-only + --checkpoint JSON，用于export/plan/import/migrate。显式checkpoint不是archive，缺goal不能偷塞全history；旧包转换输出不携带旧raw。
6. context-only native只注入一个custom semantic checkpoint，不恢复assistant/source模型历史；handoff预算不足必须失败，不能漏风险。
7. 回归与各成员检查、幂等/旧包兼容；文档说明标签提取限制与上下文核实，输出新版本源码包。

不会删除用户旧source、旧ACX或旧target，因为profile剔除是创建新的迁移产物而非清理已有文件。checkpoint文本内容仍需人工复核，规则不能证明任意自然语言完全无过程。
