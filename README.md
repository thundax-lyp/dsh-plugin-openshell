# dsh-plugin-openshell

调查并验证 DSH 与 OpenShell 的接入方案，优先复用 DSH 官方 SSH Provider，由 OpenShell 提供外层权限隔离。

当前只有 TypeScript 工程骨架和设计文档，尚未修改 DSH 传输、部署远端 helper 或通过真实沙箱验收。

## 首选方案

复用 `@deepseek-ai/dsh-ssh`、`@deepseek-ai/dsh-fs-ssh`、`@deepseek-ai/dsh-subprocess-ssh` 与 `@deepseek-ai/dsh-sandbox-ssh`。在 DSH SSH 连接服务及 helper 中增加远端 loopback TCP 端点支持，保留现有 TLS-PSK 流认证，通过 OpenShell 已实现的 SSH TCP 转发承载程序数据流。

这需要修改 DSH 共享传输与协议，不能仅靠配置完成，也不代表当前发布包已兼容。优先向 DSH 上游提供通用扩展，避免在本项目复制 Provider。身份授权、沙箱分配、创建与回收由调用方负责。

## 备选方案与项目去留

只有首选方案的验证证明存在无法合理解决的接口缺口时，再评估通过 OpenShell SDK 自研 `OpenShellFileSystem`、`OpenShellSubprocessRuntime` 和 `OpenShellSandboxProvider`。

若 SSH 路线成立，本项目收敛为镜像、连接配置与组合示例；若这些内容也能由上游承载，则无需保留独立运行插件。当前不承诺新增 Provider 导出。

## 最小验证

1. 固定版本，准备沙箱镜像与匹配的 DSH helper，验证严格主机密钥校验和 helper 握手。
2. 扩展远端 TCP 端点，验证 OpenShell 转发及 TLS-PSK 认证、错误密钥拒绝、连接和端口清理。
3. 组合现有 Provider，完成文件写入、命令读取、输出收集和版本冲突闭环。
4. 在沙箱内探测 Landlock，验证逐调用只读、工作区可写及外层拒绝仍生效。
5. 验证取消、断线与租约清理；结果未知不重放、不报告成功、不回退本地。

详细通过条件见 [DESIGN.md](docs/DESIGN.md#最小验证步骤)。首轮聚焦文件与非交互命令；PTY、LSP、PTC 后续分别验收。

## 计划目录与文件

以下为计划，除现有工程入口外尚未实现。验证先行，不预建备选模块。

| 文件                  | 对应功能与启用条件                                                |
| --------------------- | ----------------------------------------------------------------- |
| `README.md`           | 方案优先级、项目状态、文件职责与开发入口                          |
| `docs/DESIGN.md`      | 复用包与类、TCP 传输改造、Mermaid 数据流、权限与最小验收          |
| `Dockerfile`          | 首选方案验证镜像，部署匹配的 helper、Node.js 和原生 runner        |
| `examples/SSH_CONFIG` | OpenShell ProxyCommand、可信 known_hosts 和连接别名示例，不含凭据 |
| `examples/cordis.yml` | 组合官方 SSH 服务及三个 Provider 的隔离验证 Profile               |
| `src/index.ts`        | 现有工程入口；仅在验证确认需要运行插件时增加组合逻辑              |
| `src/runtime.ts`      | 仅备选：`OpenShellRuntime`，管理 SDK 客户端与执行环境配置         |
| `src/fs.ts`           | 仅备选：`OpenShellFileSystem`，实现 `ctx.fs`                      |
| `src/subprocess.ts`   | 仅备选：`OpenShellSubprocessRuntime`，实现 `ctx.subprocess`       |
| `src/sandbox.ts`      | 仅备选：`OpenShellSandboxProvider`，实现 `ctx.sandbox`            |
| `src/policy.ts`       | 仅备选：DSH 逐调用限制与 OpenShell 外层权限对齐                   |

DSH TCP 端点修改位于 DSH 上游的 `packages/ssh/`，不是本仓库现成文件。说明文档文件名统一大写，配置文件遵循加载器约定。

## 执行环境

| 组件                         | 版本要求                                                    |
| ---------------------------- | ----------------------------------------------------------- |
| Node.js（DSH 与验证 helper） | `^22.19.0` 或 `>=24.0.0`，与 DSH rc.4 engines 一致          |
| DSH                          | `0.2.1-rc.4`，TCP 端点扩展需另行构建客户端与 helper         |
| OpenShell                    | 调研基准 `v0.1.6`，运行验证固定 CLI、Gateway 与沙箱组件版本 |
| pnpm                         | `12.15.0`                                                   |

DSH 在沙箱外运行，helper 在沙箱内运行；镜像需包含目标 Linux 架构的原生依赖。版本声明不代表已通过兼容性验收。

## 开发

```sh
pnpm install
pnpm check
pnpm format
```

使用 ESLint 与 Prettier，统一 4 空格缩进。
