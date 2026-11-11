# Context-only 阶段开发记录

项目：`agent-bridge`；版本0.3.0 preview。

本阶段重点是语义检查点迁移，不再把执行过程包在迁移产物中。现有archive模式和0.2原生存储路径保留。

## 实现

- 新增 --profile archive|context-only，export/plan/import/migrate均可使用，与handoff/structured正交。
- checkpoint字段：goals/constraints/background/facts/decisions/artifacts/progress/nextSteps/risks；reviewRequired必须为true。
- 保守单行标签提取：有效上下文中的目标、约束、结论等；不推断未标注文本、不复制工具结果、system/developer和过程回复。缺目标时失败，可 --checkpoint JSON 人工指定。
- context-only包没有events.jsonl；source原session id/path、原event ids、raw、工具参数/结果、provider usage和执行历史均不保留。保留一个固定synthetic checkpoint事件用于内部兼容，不是源执行事件。
- 旧archive转换会重新编码新的检查点包；output/source.acx不是旧archive。context-only禁止反转成archive，旧source与旧包不删除。
- 同一checkpoint的ZIP时间固定，重复转换字节稳定；用于幂等与内容校验。
- 未知动作只保留通用风险，不保留命令、工具名和call id；事实、决策、进度仍须复核。
- Pi/OMP native仅一个custom semantic checkpoint，metadata只含新迁移控制信息；Pi custom-only延迟落盘用原生SDK生成记录安全发布，再原生open确认，无伪造对话回合。
- handoff预算不足容纳checkpoint会失败，避免漏风险/约束。字段白名单、包成员/metadata白名单、标准projection一致性与篡改校验。

## 验证

新增测试覆盖保守提取、显式checkpoint、风险保留、真实reset/context-edit删除、中文标签、未标注失败、混包/manifest夹带、synthetic payload篡改、不能还原archive、各成员不含执行marker。

CLI验证export/migrate/plan/import旧包转换、六方向context-only交接、source不变和幂等；Pi/OMP原生单检查点写入、cold open以及native JSONL/receipt/compilation/source.acx无过程marker。

最终验收：73个测试通过，其中29个context-only测试；类型检查、build、format检查通过。核心及Pi/OMP隔离运行时三处npm audit均返回0个已知漏洞（当次锁文件和公告快照）。

## 限制与边界

没有调用LLM、没有读取/删除用户真实agent会话、没有改用户源文件/旧归档、没有启动真实模型或TUI。现有Codex目标仍为PREPARED handoff。

规则提取不是通用自然语言摘要，未标注背景/结论可能被遗漏；标签中混入的自然语言过程不保证全部识别。建议显式checkpoint并人工复核；不声称“事实已独立核验”或“所有内容绝对无敏感数据”。

丢弃工作过程意味着不能恢复原分支、追溯具体执行或确认文件状态；产物路径不等于存在，进度不等于测试通过。后续模型仍需核查当前workspace再行动。
