# Native Session Stage Implementation Plan

Goal: Pi 1.5.1 / OMP 18.16.0 的原生 SessionManager 持久化、独立进程加载、模型上下文校验与追加后再加载；Codex 0.155.1 的无模型导入 feasibility 验证。

Architecture: 经过验证的 portable IR → native message compiler → 隔离 SDK worker → 指定输出目录新 session → 冷加载验证与 receipt。保留原始消息角色但将工具历史降级为 inert 历史描述，summary/custom 作为有来源的交接记录；不迁移 runtime/prompt/权限/provider状态。

Tech stack: TypeScript/Node；Pi SDK 单独 Node worker；OMP SDK 单独 Bun worker。运行时依赖锁定在 runtimes，不安装全局 agent，不触碰用户 agent 根目录。测试禁止网络/model calls。

Steps:
1. 核实与锁定 upstream SDK SessionManager 构造、append、open、context、close，以及 Bun运行时。
2. 先写 native compiler、导入幂等、损坏防护测试，运行失败基线。
3. 实现 worker JSONL 单请求，env 最小白名单、独立 HOME/state/config、禁用网络；只加载 SessionManager，不启动 AgentSession、扩展、tools。
4. 增加 import/migrate --mode structured（仅 Pi/OMP）、verify native、resume 安全argv说明。auto 不自动升级现有 handoff行为；Codex structured依旧显式门控。
5. 在全新子进程创建/加载/追加/再加载，验证上下文角色/来源映射/cwd、新身份、源不变；append测试仅合成用户回合，不调用模型。
6. Codex只调用初始化和thread生命周期，隔离数据目录及插件配置，验证可发现/加载；不凭额外JSON字段被容忍判定history导入。
7. 运行回归/审计，更新兼容范围、已完成/未完成界限，交付新源码包。

Hard acceptance: 无模型、无历史工具执行，native session file可经原生SDK加载，关闭后上下文一致。此证据只证明storage/context cold restore，不宣称模型行为或交互CLI完整续聊已验证。
