# DSH Sandbox OpenShell 需求

## 目标与基线

包名为 `dsh-sandbox-openshell`。DSH 在 OpenShell 沙箱外运行，仅通过 OpenShell 官方 SDK 交互式入口使用指定的远端沙箱。参照 `@deepseek-ai/dsh-sandbox-ssh` 的 Sandbox Provider 契约，复用沙箱内的官方 LocalSandboxProvider 实施命令的逐调用文件权限，复用 SandboxedFileSystem 提供同一执行环境的文件接口。

DSH 固定为 `0.2.1-rc.4`，Cordis 为 `4.0.5`，真实验证使用 OpenShell `0.1.6`、Node.js 24 和 Linux x64。开发与本机测试支持 Node.js 22.19+ 的 22.x 或 Node.js 24+。变更基线须同步依赖、锁文件、测试和设计证据。

## 必须提供的能力

| 编号 | 能力                         | 验收条件                                                                                                                                                |
| ---- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | `OpenShellSandboxProvider`   | 实现 `ctx.sandbox.confine(argv, policy, signal)`；远端复用 `@deepseek-ai/dsh-sandbox-local`，保留 enforcement、拒绝签名和 runner 失败规则               |
| R2   | `OpenShellSubprocessRuntime` | 为 R1 提供同一沙箱的普通进程执行；保持实际 argv、远端 cwd、管道或收集输出和退出码；不在本地执行远端 argv                                                |
| R3   | 逐调用权限                   | 验证 read-only、workspace-write 与 OpenShell 外层限制的组合；命令默认拒绝 partial；仅显式接受 best-effort 或诊断时放行，保留 enforcement                |
| R4   | 显式部署目标                 | 绑定 Gateway 的官方 SDK client、沙箱名称、沙箱内 helper 位置由可信配置绑定；无隐式“最近使用的沙箱”，不自动重试不确定的执行                              |
| R5   | 失败与取消                   | 缺失 helper、版本不符、不可用权限后端、取消、超时和断线不得伪装成成功停止；使用官方 SDK 交互式取消与客户端 deadline，不能观察整个远端范围退出时明确报错 |
| R6   | 可复跑交付                   | Node .mjs 测试入口与按能力组织的 fixtures；本机契约与真实 OpenShell 结果分别记录；配置只提交 .env.example                                               |

## 文件系统与远端工作区

- R7：`dsh-sandbox-openshell` / `OpenShellFileSystem` 实现 `@deepseek-ai/dsh-fs` 的 resolve、stat/lstat、readText/streamText、readBytes/readByteRange、listDir、writeText 和 editText；远端复用 `@deepseek-ai/dsh-fs-sandbox` / `SandboxedFileSystem` 的原子写入、版本保护、字面编辑和逐调用策略。保留结构化 FsError，不把宿主路径映射为沙箱文件。
- R8：`OpenShellWorkspace` 绑定可信 `workspaceRoot`，默认为 `/sandbox/project`；fs、subprocess 和 sandbox 共用同一连接、沙箱与远端工作区。正常 Agent 依赖就绪时安装基于 `@deepseek-ai/dsh-working-directory` / `WorkingDirectoryService` 的 `OpenShellWorkingDirectory`，以远端目录作为默认值，并拒绝切换至绑定工作区外。Session header.cwd 必须使用远端路径。它不是持久 workspace registry。目录切换须保留 DSH 空路径拒绝规则；失败不得追加目录变更事件。
- R9：验证真实文件读写、编辑、搜索与进程的双向可见性。搜索复用 RC 的 `@deepseek-ai/dsh-tool-fs-search`，通过显式 host→remote 可执行文件映射使用镜像里的 ripgrep；不复制宿主二进制、不自动映射任意宿主路径。
- R10：默认文件模式为 read-only；每次 write/edit 接收 DSH SandboxExecutionPolicy。workspace-write 按上游规则允许工作区及临时目录，拒绝区外写入；所有模式仍受 OpenShell 外层限制。文件接口的受信路径检查不能冒充任意代码执行的 full 内核隔离。

验收覆盖别名身份、符号链接指向区外、只读拒绝、默认值与逐调用覆盖、过期和并发版本、二进制拒绝、流式 UTF-8、传输上限及取消。文件 watch 不在本期范围。文件变更在取消或断线前可能已提交，不自动重放。

## 沙箱运行时镜像

正式构建、构建过滤、沙箱策略及验收诊断镜像配置均位于 deploy/；测试逻辑留在 tests/。R11：通过 deploy/compose.yaml 的 docker compose up -d 完成镜像构建及一次性部署：官方 CLI 创建／检查指定沙箱，等待 READY，以 policy set --wait 确认策略加载。验收覆盖 HTTP/mTLS 首次创建、重复启动、策略更新后的有效版本及拒绝无证书／错误 CA 客户端；默认沙箱名 dsh-openshell，并在部署前校验 1–19 字符 DNS label。重复启动复用同一沙箱；同名归属或镜像引用冲突失败，不自动重建。既有 Gateway 与客户端身份由部署方准备，部署脚本不是 Provider 的 CLI 兼容路径。

宿主入口 `node deploy/deploy.mjs` 自动准备固定版本 CLI 并校验归档 SHA-256，复用已有兼容 CLI，等待 Compose 初始化成功。默认 HTTP 无需证书；HTTPS/mTLS 预检证书文件。不得自动修改已有 Gateway 的认证配置或在失败后重试不确定的创建。

提供 deploy/runtime/Dockerfile、对应 Dockerfile.dockerignore 与 deploy/openshell/policy.yaml。镜像包含 Node.js 24、权限／文件 helper、Linux x64 ripgrep 和锁定的 RC 依赖，默认使用非 root 用户与 /sandbox/project 工作区，运行时代码对该用户不可写。镜像不依赖测试宿主 Node、私有基础镜像、SDK 或测试诊断文件。

验收必须先通过未叠加诊断工具的正式镜像创建沙箱，验证沙箱外 DSH 经 SDK 调用 helper、包装并执行实际命令；再用独立诊断层检查权限边界。保持 strict/partial 语义及既有取消限制。

## 验收入口对应关系

| 需求           | 实现                                                                                         | 本机契约测试                                                | 真实 OpenShell 测试                                                |
| -------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| R1、R3         | src/sandbox、src/runtime/confine.mjs                                                         | tests/sandbox/provider.test.mjs                             | tests/e2e/provider.test.mjs                                        |
| R2、R5         | src/subprocess、src/connection.ts                                                            | tests/subprocess/interactive.test.mjs                       | tests/e2e/provider.test.mjs、cancellation.test.mjs                 |
| R4             | src/connection.ts、src/index.ts                                                              | tests/sandbox/provider.test.mjs、tests/fs/provider.test.mjs | tests/e2e/provider.test.mjs                                        |
| R6、运行时镜像 | deploy/compose.yaml、deploy/runtime/Dockerfile、scripts/build.mjs、tests/e2e/remote.test.mjs | pnpm build、pnpm check                                      | tests/e2e/image.test.mjs，remote.test.mjs 负责准备与清理           |
| R7、R10        | src/fs、src/runtime/fs.mjs                                                                   | tests/fs/provider.test.mjs                                  | tests/e2e/fs.test.mjs                                              |
| R8、R9         | src/workspace、src/subprocess/provider.ts                                                    | tests/fs/provider.test.mjs 校验入口与默认绑定               | tests/e2e/fs.test.mjs 校验目录切换、拒绝路径、共享工作区和 RC 搜索 |

| R11 | deploy/compose.yaml、deploy/openshell/deploy.mjs | tests/deploy/compose.test.mjs | tests/fixtures/sandbox/host.mjs 运行真实 up -d，两次启动沙箱 ID 不变，并等待初始化容器成功 |

本机 SDK 夹具只验证接口和生命周期；Session/Projection 夹具不等于持久化服务。真实权限及进程行为以远端入口结果为准，已验证项与未覆盖项在 DESIGN.md 分开记录。

## 范围限制

DSH Provider 不提供 CLI 兼容执行路径；一次性部署可使用官方 CLI。不实现自建 SSH 服务、中继、认证协议、Session 持久化、Run capability、租约、generation、SQLite Authority、管理入口或跨控制器接管。沙箱创建与策略加载由一次性部署入口调用官方能力完成；用户授权、环境绑定、卷与 Gateway 生命周期由部署方和 OpenShell 负责。

首期不提供 PTY、控制 fd、环境变量覆盖和远端进程树管理。调用方使用本包的 OpenShellFileSystem；模型工具注册及 Session 持久化仍由上层 DSH 负责。SDK 传输退出不等于整个远端进程范围已停止。主动取消／客户端 deadline 的受测同组进程停止，不等于覆盖 setsid 逃逸后代。

控制面与故障接管实验已迁出，不能作为本包的生产能力或 RC 兼容证据。实现及已验证限制见 [DESIGN.md](../20-design/DESIGN.md)。
