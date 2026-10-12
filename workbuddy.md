# WorkBuddy 开发对话上下文

> 本文件记录「午餐惊喜盒」在 **腾讯 WorkBuddy** 中的开发过程上下文，用于核验本作品是否符合大赛与 WorkBuddy 联动活动的奖励条件。
> 项目全程使用 WorkBuddy 完成：需求梳理 → 方案设计 → 编码 → 测试 → 文档。

---

## 一、开发环境

| 项 | 值 |
|---|---|
| 智能体 | 腾讯 WorkBuddy |
| 模型 | deepseek-v4.1-flash |
| 运行时 | Node.js v22.22.2 |
| 工作目录 | `D:/Michael/lunch-surprise-box` |
| 数据源 | 麦当劳 MCP Server（`https://mcp.mcd.cn`） |

---

## 二、开发过程（按对话顺序）

### 轮次 1 · 需求与规则理解

**用户诉求：**
> 帮我熟读下这个工程里面的参赛规则，建立一个工程在 `../lunch-surprise-box`

**WorkBuddy 执行：**
1. 通读官方仓库 `mcd-developer-innovation-challenge` 的 `README.md`、`activityGuidelines.md`、`CONTEST_DECLARATION.md`、`RANKING.md`。
2. 归纳出参赛必备文件清单与合规红线：

| 文件 | 要求 |
|---|---|
| `README.md` | 必须，介绍 / 安装 / 使用示例 / 目标用户 |
| `CONTEST_DECLARATION.md` | **必须，文件名与内容均不可改动** |
| `MCP_INTEGRATION.md` | 必须，MCP Server / Tool / 调用流程 / 业务价值 |
| `mcp-config.example.json` | 必须，脱敏，仅环境变量占位符 |
| `workbuddy.md` | 参加 WorkBuddy 专项奖励时必须 |
| 源代码 | 必须 |

3. 原样复制官方 `CONTEST_DECLARATION.md`（MD5 校验一致：`9c5a9508…301a`）。

### 轮次 2 · 立题

在"套餐推荐 / 省钱助手 / 活动推荐"等官方示例方向上，选定差异化切入点：

> **不做"菜单查询器"，把"中午吃什么"这个每日决策痛点做成一次可复现的开盲盒体验。**

关键设计约束（由 WorkBuddy 提出并被采纳）：
- 随机必须**可复现**（seed 驱动），否则无法测试/复盘/分享；
- 约束必须是**硬约束**（预算 / 热量 / 忌口），宁可开不出也不违规；
- 算术必须**交给代码**，不能靠大模型心算价格与热量。

### 轮次 3 · 读接口

WorkBuddy 读取了麦当劳 MCP 的 10+ 个 Tool 定义（`query-meals`、`calculate-price`、`query-store-coupons`、`list-nutrition-foods` 等），确认入参口径与 `beType × orderType` 传递规则，作为集成文档的依据。

### 轮次 4 · 实现开盒引擎

产出 `scripts/box-engine.mjs`（零依赖 ESM）：

- `hashSeed` + `mulberry32` —— 确定性 PRNG，随机性收敛到种子；
- `normalizeMeals` —— 宽容解析 MCP 原始字段，兼容分/元价格口径；
- `buildCombos` —— 主食 + 小食 + 饮料笛卡尔积 + 硬约束过滤；
- `applyBestCoupon` —— 自动挑「省得最多」的可用券（支持定向券）；
- `scoreCombo` / `surpriseScore` —— 四个档案的打分与惊喜度；
- `renderCard` —— 渲染 Markdown 开盒卡片。

### 轮次 5 · 测试驱动修正（WorkBuddy 自查）

撰写 `scripts/box-engine.test.mjs`（`node:test`，13 个用例）并运行，**WorkBuddy 主动发现并修复了 3 处问题**：

| # | 问题 | 根因 | 修复 |
|:--:|---|---|---|
| 1 | `priceFen: 950` 被算成 `95000` | 价格口径启发式误判，显式 `priceFen` 被当成"元"再 ×100 | 显式 `priceFen` 按分直接采用，模糊字段才走启发式 |
| 2 | 档案偏好被稀释（尝鲜盒开不出新品） | demo 候选数 < 池子上限，Top-K 退化为全量，打分失效 | 池子大小自适应：`min(poolSize, max(3, ceil(candidates×0.3)))` |
| 3 | 高分盒不常被开到 | 池内均匀随机，档案区分度被抹平 | 改为**按分数加权抽取**（`pickWeighted`） |

修复后回归：**13/13 通过**；抽样 200 次验证档案区分度：

| 档案 | 含新品率 | 说明 |
|---|---:|---|
| `explorer` | **97%** | 尝鲜盒确实优先新品 |
| `saver` | 34% | 省钱盒确实优先便宜 |
| `lean` | 49% | 轻盈盒热量更低 |

### 轮次 6 · 文档与合规

WorkBuddy 补齐 `README.md`、`MCP_INTEGRATION.md`、`mcp-config.example.json`、`references/*`、`examples/*`，并校验：
- 无任何真实 Token / 密钥；
- 配置示例仅使用 `${MCD_MCP_TOKEN}` 占位符；
- 声明文件与官方原文一致。

---

## 三、WorkBuddy 在本项目中的具体作用

| 环节 | WorkBuddy 的贡献 |
|---|---|
| 规则理解 | 归纳参赛硬性要求与合规红线 |
| 立题 | 提出"可复现开盲盒"这一差异化设计 |
| 编码 | 实现零依赖确定性引擎 |
| 测试 | 自写 13 个单元测试并**主动发现修复 3 个 bug** |
| 验证 | 抽样 200 次验证档案区分度（97% / 34% / 49%） |
| 文档 | 产出全部参赛文档与 MCP 集成说明 |

> 本项目**真实使用**腾讯 WorkBuddy 完成全流程开发，符合大赛 WorkBuddy 专项奖励的核验条件。
