# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0]

### Added

- **「MCP 服务器」设置页**（`settings.section`），DSH 内增删改任意 MCP 服务。
- **目录式添加**：内置 GitHub / Notion / Linear / Sentry 官方端点预设，
  点卡片即添加，凭证面板带「在浏览器打开凭证页」跳转。
- **两种传输**：`streamable-http`（URL + 请求头）与 `stdio`（命令 + 参数 + 环境变量 + 工作目录）。
- **与官方客户端一致的校验**：`serverName` pattern 与全局唯一性、URL scheme、
  stdio 必填 command；校验通过才允许写入，避免生成官方客户端拒绝的配置。
- **一键写入 profile**：把启用的服务渲染成 `@deepseek-ai/dsh-mcp-client` 的
  `insert` 行，写进 profile 的 `cordis.patch.yml` 托管块（带标记，可整体重写、可移除）。
- **连通性探测**：stdio 真启动子进程跑 `initialize` + `tools/list`；
  streamable-http 发真实 JSON-RPC 握手，401/403 明确提示凭证问题。
- **工程保障**：宿主半只用 Node 内置模块；YAML 标量全部加引号（`env`/`headers`
  必须是字符串映射）；生成的条目 id 带命名空间，与插件自身 bundle id 结构性隔离；
  profile 目录从命令行参数解析（桌面宿主不导出 `DSH_PROFILE_DIR`）。
- **离线验证**：`scripts/verify.mjs` 63 项检查，假 ctx + 真 HTTP + 真 YAML 解析 +
  真 spawn，全部不需要 DSH 在运行。
