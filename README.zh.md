# dsh-generation

[English](README.md) | 中文

DeepSeek Harness 插件：从已有 Agent preset **分叉下一代，并在新世代上跑任务**。

它是 **make，不是编译器**。创造模式已经是编译器：能检查运行时、改文件、创作 preset。本插件只负责记下族谱——拷贝一份已知可用的 preset，让 meta agent 用普通的 `fs` / `bash` 改这份拷贝，再 **新开** 一个 working 会话跑在上面。

## 安装

```sh
dsh plugin --profile web add github:goecho/dsh-generation#fb2f69d
```

然后 **重启** `dsh --profile web`，让 Host profile 重新加载。读过源码后请 pin 到这个 commit，或 [提交历史](https://github.com/goecho/dsh-generation/commits/main) 里更新的 SHA。本包是纯 JavaScript，git 安装不需要 `prepare` 构建白名单。

然后打开 **创造模式**（`cordis`）会话——或组成里仍有插件行 `name: '@deepseek-ai/dsh-tool-cordis'` 的副本。

`dsh plugin add` 装的是 **Host** profile，两个工具会在全局注册。本插件随后把它们从每一个非创造模式会话（包括用户拷贝的 `standard` / `minimal` / `code`）以及所有 `origin: subagent` 的 agent（包括 `generation_run` 拉起的 worker）上藏掉。执行时仍会拒绝非创造模式调用方。

本仓库已经带有 `dsh-plugin`、`dsh`、`deepseek-harness` 这三个 GitHub topic。

## 为什么

DeepSeek Harness 把组装拆成 Host 平面（沙箱、模型路由、持久化）和 Agent 平面（工具、persona、提示词）。会话一旦产生 turn，preset 就会锁死，不能在中途热替换 working agent 的工具集，否则日志里的旧 tool call 无法解释。

有用的自举方式和 C 编译器一样：**每一代都是新的二进制**。第 N 代为第 N+1 代写文件；不要给正在编译的那个进程打补丁。

## 它不是什么

- 不是创造模式（`cordis` preset）或 `cordis_define` / `cordis_run` 的替代品
- 不能给当前会话 recompose，也不能给进程内 subagent 换一套 preset
- 不是 YAML/JS 生成器，也不是评分器，更不会自动晋升默认创造者
- 不是 Host 平面内核：不新增服务、session 事件类型或沙箱后端
- **不依赖** `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-llm`。工具用原始定义注册，避免第二份拷贝把 Host 的模块身份拆开。

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

Working 世代应从 `standard`、`minimal` 或 `code` 分叉。

## 工具

| 工具 | 做 | 不做 |
| --- | --- | --- |
| `generation_fork` | `agentPresets.copy(from, id)`；把 `purpose` 写入新 `preset.yml` 的 description；返回 id 与目录 | 接收组成 YAML（authoring 保持 copy-only）；覆盖已有 id |
| `generation_run` | 批准后创建 agent、`mount` 该 preset、`followup(task)`，等到 idle、取消或 15 分钟超时；返回 `sessionId`、`stopReason`、用过的工具名、最后一段助手文本，然后 `dispose` | 把创造模式当 worker；继承 meta 的工具集；失败时留下半残 agent |

### `generation_fork`

| 参数 | 必填 | 含义 |
| --- | --- | --- |
| `from` | 是 | 要拷贝的 preset id。优先 `standard` / `minimal` / `code`。 |
| `id` | 是 | 新 preset id（`/^[a-z0-9][a-z0-9-]*$/`）。不得已存在。 |
| `purpose` | 是 | 写入新 `preset.yml` description 的一句话。 |

返回 `{ ok, id, from, purpose, path, compositionPath }`，其中 `path` 是 preset 目录。

### `generation_run`

| 参数 | 必填 | 含义 |
| --- | --- | --- |
| `preset` | 是 | 新 working 会话要 mount 的 preset id。不能是 `cordis`。 |
| `task` | 是 | 给 worker 的自包含 follow-up。它看不到 meta 历史。 |

若 worker 的组成里仍有插件行 `name: '@deepseek-ai/dsh-tool-cordis'`，会被拒绝。继承 meta 会话的工作区 `cwd`，记录 `origin: subagent` 和 `parentSession` 以便日志串联，并且不会把 worker 的完整逐字稿倒进 meta 上下文。worker 若一直不 idle，15 分钟后取消（`stopReason: "timeout"`）。领域失败仍返回 `{ ok: false }`，但会渲染成 `ERROR:`，方便模型看见。

返回 `{ ok, sessionId, presetId, stopReason, toolsUsed, lastAssistantText }`。

## 信任

能分叉并跑世代的创造模式会话，按 **shell 权限** 对待。v1 的缓解：

- 每次 fork、每次 run 都要人批准
- Worker 的 preset 不能是 `cordis`，也不能仍带着 `@deepseek-ai/dsh-tool-cordis` 插件行
- 编辑只发生在新 preset 目录下
- 不会把模型写的 JavaScript 自动 `cordis_run`

## 开发

```sh
npm test
```

没有 `@deepseek-ai/*` 运行时依赖。测试 mock 了 `ctx.tools` / `ctx.agentPresets` / `ctx.agents`。GitHub Actions 在 Node 22 上跑同一套 `npm test`。

## 许可

[MIT](LICENSE)
