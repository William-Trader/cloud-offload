# CLOUD_OFFLOAD — 云端算力卸载协议 v1

> 给**任何 agent** 读的执行契约：什么时候把活外包、怎么调用、怎么验证省了多少。
> 读完即可用，无需其它上下文。

## 0. 目的（一句话）

**把『烧本地 token 的生成/加工』外包给云端算力层；本地只花一条指令 + 一条回执。**

## 1. 何时用（决策程序，不是建议）

```
IF 任务 ∈ { 长文创作, 多文档摘要, 批量改写/翻译, 打标分类, 大段润色 }
AND ( 预估本地输出 > 800 字符  OR  输入材料 > 3000 字符 )
THEN 走 cloud_offload（以下任一）
  ├─ 需要落盘 → --out <文件>     ← 首选，正文不进本地上下文
  └─ 需要正文 → 直接调用，读回返回值
ELSE 本地自己做（往返成本 > 收益）
```

**硬判据**：`预估省下 token = est(材料+成品) − est(指令+回执)`。这个差值 **> 300** 才值得外包。

## 2. 工具契约

```
node cloud-offload.mjs --task "<一句指令>" [--material-file <文件>] [--out <输出文件>] [--system "<角色>"] [--quiet]
```

| 参数 | 说明 |
|---|---|
| `--task` | **必填**。一句指令（本地 token ≈ 个位数~几十） |
| `--material-file` | 可选。把大材料**从文件**喂给云端（**不经本地上下文**） |
| `--out` | **省 token 关键**。成品直接写入文件，本地只收到一行回执 |
| `--system` | 可选。覆盖角色（默认：纯创作引擎，禁工具、禁解释） |
| `--quiet` | 只出回执，不出正文 |

**退出码**：0 成功 / 1 云端失败 / 2 参数错。

## 3. 两条调用范式（照抄即可）

**A. 本地建文件 + 云端出正文（最省）**
```
node cloud-offload.mjs --task "写 800 字《X 行业速览》正文" --out "/tmp/X.md" --quiet
# → OK 已写入 /tmp/X.md（832 字符, 2100ms）
# 本地上下文只增加这一行
```

**B. 大材料摘要（材料不进本地）**
```
node cloud-offload.mjs --task "提炼 5 条要点，每条≤40字" --material-file "/tmp/长报告.txt" --out "/tmp/要点.md" --quiet
```

## 4. 铁律

- **只读输入、只写 --out 指定的文件**；不许把密钥/隐私材料传出去。
- **串行**：云端是单浏览器页，一次只发一个请求；并发会互相打断。
- **不接管对话**：这是**算力工具**，不是模型 provider；绝不用它生成你自己的回复。
- **失败即降级**：退出码非 0 时，本地自己做该任务并记录失败，不要重试超过 2 次。

## 5. 自验证（收到即跑）

```bash
node selftest.mjs        # 跑 3 个真实任务，打印『本地自做 vs 云端外包』对照表
node ledger-report.mjs   # 累计省 token 账本
```

`selftest.mjs` 通过 = 这套系统在本机可用。

## 6. 账本（可审计）

每次调用追加一行到 `token-ledger.jsonl`：
```json
{"ts":"...","ok":true,"ms":2100,"task_chars":22,"material_chars":0,"out_chars":832,"written":"/tmp/X.md","est_local_tokens_spent":45,"est_local_tokens_if_done_locally":880,"est_tokens_saved":835}
```
**口径**：`est(chars) = ceil(chars / 1.5)`（中英混排近似，明确为估算）。

## 8. 路由预言机（动手前必问）

**不要自己猜该不该外包——问网关。**

```
GET http://127.0.0.1:8788/api/route?est=<预计本地token>&type=<类型>&interactive=<true|false>&sensitive=<true|false>
# → {"use":"cloud"|"local","reason":"..."}
```

判据（网关集中维护，可在前端调整）：
1. 总开关关闭 → local
2. 敏感信息 → local（保护规则）
3. 交互态（用户在等）→ local（保护规则）
4. 类型被禁用 → local
5. 预计 < 阈值 → local
6. 今日额度/时段/省token目标已满 → local
7. 其余 → cloud

`est` 估算口径：`ceil((指令字符 + 材料字符) / 1.5)`。

**前端可调**：总开关 · 档位(保守2000/均衡800/激进300) · 阈值滑块 · 类型白名单 · 保护规则 · 时段 · 省token目标 · 限流。

决策会被记录，可在前端「决策审计」查看（云端 N / 本地 M + 原因）。


## 7. 依赖（本机三件套，launchd 托管）

| 组件 | 端口 | LaunchAgent |
|---|---|---|
| 云端 API（OpenAI 兼容） | 8788 | `ai.openclaw.cloud-offload-api` |
| 本地工具桥 | 8787 | `ai.openclaw.cloud-offload-bridge` |
| 自动化 Edge（已登录 chatglm.cn） | 9222 | `ai.openclaw.cloud-offload-edge` |

自检：`curl -s http://127.0.0.1:8788/health` → `{"ok":true,...}`

## 完成判定协议（v3，实测）
网页版 ChatGLM（含 GLM-5.3 长思考）必须按下列信号判"生成结束"，只看文本是否静止会**误判**：

| 阶段 | DOM 特征 | 处理 |
|---|---|---|
| 深度思考 | 最后 `.answer-content-wrap` 的 class 含 `text-advance-thinking-*` | 永不判定完成 |
| 出正文 | 出现**新**的 `.answer-content-wrap`（class 为普通 `ACW`），文本流式增长 | 等待 |
| 完成 | 该回答容器（向上 4 层内）出现 `.regenerate-part` / `.regenerate` 工具条 | 判定 done |
| 兜底 | 非思考态且文本静止超过 18s | 判定 done（标记 truncated 以便复核）|

- 硬上限 300s（`ANSWER_TIMEOUT_MS`），不再有 60s 砍断。
- CDP 调用 20s 超时，避免页面卡死把网关锁死。
- 旧逻辑 `Math.min(ANSWER_TIMEOUT_MS, 60000)` 与"静止即完成"是"任务没跑完"的两大根因，已移除。
