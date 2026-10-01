# dsh-mcp-hub — 通用 MCP 服务器管理页

[![CI](https://github.com/tang-coder-hub/dsh-mcp-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/tang-coder-hub/dsh-mcp-hub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

在 DSH 的「设置 → MCP 服务器」里**增删改任意 MCP 服务**（stdio 或 streamable-http），
校验通过后一键写入 profile 的注册块，重启后即可在会话里使用。

只用官方组件：承载连接的是 DSH 自带的 `@deepseek-ai/dsh-mcp-client`，
本插件**不做任何协议实现**，只负责配置的表单化、校验与落盘。

页面是**目录优先**的：上面一排服务卡片（GitHub、Notion、Linear、Sentry），
点一下就添加；然后出现凭证面板，带一个「在浏览器打开凭证页」的按钮跳到厂商自己的
token 创建页；粘贴回来保存，再「应用到 DSH」。

内置四个预设，全部指向**厂商自己发布**的端点：

| 服务 | 端点 | 凭证 |
| --- | --- | --- |
| GitHub | `https://api.githubcopilot.com/mcp/` | fine-grained PAT |
| Notion | `https://mcp.notion.com/mcp` | Internal Integration Token |
| Linear | `https://mcp.linear.app/sse` | Personal API Key |
| Sentry | `https://mcp.sentry.dev/mcp` | Auth Token |

目录刻意保持很小 —— 只收录厂商文档里明确给出的端点，不猜、不代填。
要接别的服务，用底部的「自定义 / 高级」表单，stdio 与任意 URL 都能填。

## 用法

1. 设置 → **MCP 服务器** → 目录里点一个服务
2. 凭证面板里「↗ 在浏览器打开凭证页」→ 创建 → 粘贴回来 → 保存
3. （可选）「探测」—— 真的发一次握手，成功列出工具数量，401 明确说凭证无效
4. 点 **应用到 DSH** → 重启 DSH
5. 会话里工具以 `mcp__<服务名>__<工具名>` 出现

凭证以**明文**写在 profile 的补丁文件里（这是官方客户端的工作方式），页面会提醒你。
想要更安全，可以用只读 scope 的 token，或只授权你真正需要的仓库。

## 探测

- **stdio**：作为子进程启动，跑 `initialize` + `tools/list`，读它的 stdout
- **streamable-http**：发一次真正的 JSON-RPC 握手；非 200 会带上状态码，
  401/403 明确提示凭证无效，超时单独报 `timeout`

## 工程约束（前一个插件踩过的坑，这里都有回归测试）

| 坑 | 约束 |
| --- | --- |
| loader 条目按 id 寻址，profile 补丁层在 bundle 层**之后**应用，重名会静默替换 | 插件自己的 bundle id 是 `mcp-hub`，生成的行全部落在 `mcp-hub__<服务名>` 命名空间下，结构上不可能相撞 |
| 官方客户端要求 `env`/`headers` 是 `{[key]: string}` | 所有值在宿主侧强制转字符串，YAML 标量一律加引号 |
| 桌面宿主不导出 `DSH_PROFILE_DIR` | profile 目录从 `process.argv` 找，判定来源显示在页面上 |
| `serverName` 必须全局唯一，否则官方客户端启动即抛错 | 列表内查重 + 与官方 pattern 一致 |
| 应用被无效配置阻止时不能留下半个块 | apply 前整体校验，任一失败就整体拒绝且不写盘 |

## 验证

```powershell
node scripts\verify.mjs
```

60 项检查，全部离线（不需要 DSH 在运行），包括：

- 生成的 YAML 用真实解析器回读，**逐字段断言类型**（上次 `false`/`1` 被解析成布尔和数字导致校验失败，就是这里抓出来的）
- 两个 id 不相同的回归断言
- stdio 探测真的启动了一个假 MCP 服务并列出工具
- HTTP 探测打到一个本地假服务，200 与 401 两条路都走
- 应用被无效配置阻止时，profile 不被触碰
- profile 目录在缺少 `DSH_PROFILE_DIR` 时仍能找对

