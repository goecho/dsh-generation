# dsh-generation

[English](README.md) | 中文

DeepSeek Harness 插件：从已有 Agent preset **分叉下一代，并在新世代上跑任务**。

它是 **make，不是编译器**。创造模式已经是编译器：能检查运行时、改文件、创作 preset。本插件只负责记下族谱——拷贝一份已知可用的 preset，让 meta agent 用普通的 `fs` / `bash` 改这份拷贝，再 **新开** 一个 working 会话跑在上面。

## 为什么

DeepSeek Harness 把组装拆成 Host 平面（沙箱、模型路由、持久化）和 Agent 平面（工具、persona、提示词）。会话一旦产生 turn，preset 就会锁死，不能在中途热替换 working agent 的工具集，否则日志里的旧 tool call 无法解释。

有用的自举方式和 C 编译器一样：**每一代都是新的二进制**。第 N 代为第 N+1 代写文件；不要给正在编译的那个进程打补丁。

## 它不是什么

- 不是创造模式（`cordis` preset）或 `cordis_define` / `cordis_run` 的替代品
- 不能给当前会话 recompose，也不能给进程内 subagent 换一套 preset
- 不是 YAML/JS 生成器，也不是评分器，更不会自动晋升默认创造者
- 不是 Host 平面内核：不新增服务、session 事件类型或沙箱后端

## 设计

四条规则：

1. **内核仍是汇编。** 不注册新的 Host 服务，不扩展 `SessionEvent`，不解锁 `agent-preset-locked`。
2. **世代是新的组装进程。** `generation_run` 走 `agents.create` + `agentPresets.mount(id)`，禁止对 meta 会话 `recompose`，禁止 `composeFrom`（进程内子 agent 会继承父 preset）。
3. **本插件是 make。** 不写 `agent.cordis.yml`。改组成用创造模式已有的工具。
4. **人是 stage3。** `fork` 与 `run` 走 `tools/pre-execute` 的 `ask`。不会自动晋升为默认创造者。族谱就是 meta 会话日志（`tool/call` / `tool/result`），不再做第二份数据库。

```
meta 会话  (cordis + 本插件)
  → generation_fork     把 preset 拷到新 id
  → fs / bash           改这份拷贝（不是本插件）
  → generation_run      新 agent，mount 该 id，跑任务，dispose
  → 摘要                 回到 meta 日志
  → 再 fork 或停
```

只把本插件挂在 **创造模式**（或它的副本）上。Working 世代从 `standard`、`minimal` 或 `code` 分叉，且不得包含这两个工具。

## 工具

| 工具 | 做 | 不做 |
| --- | --- | --- |
| `generation_fork` | `agentPresets.copy(from, id)`；把 `purpose` 写入新 `preset.yml` 的 description；返回 id 与路径 | 接收组成 YAML（authoring 保持 copy-only）；覆盖已有 id |
| `generation_run` | 批准后创建 agent、`mount` 该 preset、`followup(task)`，等到 idle 或取消；返回 `sessionId`、`stopReason`、用过的工具名、最后一段助手文本，然后 `dispose` | 把创造模式当 worker；继承 meta 的工具集；失败时留下半残 agent |

`generation_run` 继承 meta 会话的工作区 `cwd`，记录 `origin: subagent` 和 `parentSession` 以便日志串联，并且不会把 worker 的完整逐字稿倒进 meta 上下文。

## 信任

能分叉并跑世代的创造模式会话，按 **shell 权限** 对待。v1 的缓解：

- 每次 fork、每次 run 都要人批准
- Worker 的 preset 不能是 `cordis`
- 编辑只发生在新 preset 目录下
- 不会把模型写的 JavaScript 自动 `cordis_run`

## 状态

设计已定，下一步才是实现。安装方式与工具 schema 随第一包一起提供。

预期安装（尚未可用）：

```sh
dsh plugin --profile web add github:goecho/dsh-generation
```

然后在创造模式会话里使用。发布相关仓库时请加上 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic。

## 许可

[MIT](LICENSE)
