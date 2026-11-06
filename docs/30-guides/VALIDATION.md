# 验证与开发

[返回 README](../../README.md) · [部署](DEPLOYMENT.md) · [接入](USAGE.md) · [验证与开发](VALIDATION.md)

以下命令从仓库根目录运行。

## 验证

2026-11-06 的完整远端验收通过；本机契约、远端实测与保留缺口分别记录在 [DESIGN.md](../20-design/DESIGN.md)。权限为 partial、setsid 后代可能存活，不构成 full 隔离或完整 Agent 验收。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm check
```

```sh
cp -n .env.example .env
chmod 600 .env
# 填写私有配置后运行；入口自行加载 .env
pnpm test:remote
# 仅验证 mTLS Compose 部署、认证拒绝和策略更新
pnpm test:mtls
```

本机 Provider 契约测试只使用根目录锁定的依赖，无需调试 runtime 或远端服务器。远端入口按沙箱 helper 与外部测试客户端的锁文件安装依赖，测试宿主需要访问 npm registry。入口还会在仓库内 `runtime/` 下载固定 v0.1.6 revision 的源码归档，校验 SHA-256 后仅提取 SDK、proto 和构建配置并构建官方 SDK（不克隆 Git 仓库），本机首次准备需要访问 GitHub、npm registry 和 Buf Schema Registry，后续复用缓存；它不依赖全局调试目录。

远端测试需要 Linux x64、Node.js 24、npm、Docker Compose v2、cc、bwrap、unshare、已安装的 OpenShell 0.1.6 CLI 和 Gateway 基础配置。cc／bwrap／unshare 仅用于原生 ABI 与 namespace 诊断，不是生产 Provider 依赖。测试使用临时 Gateway 的 18180–18182 端口，按 deploy/runtime/Dockerfile 构建正式镜像，并额外构建诊断层；准备一个纯正式镜像沙箱和两个诊断沙箱，结束后核对清理及原 Gateway 配置、沙箱清单。不再需要预装测试基础镜像或复制宿主 Node。测试不部署 SSH 服务；SSH 只用于将测试文件发送到测试宿主并启动外部 DSH 验证进程。

`.env.example` 声明配置字段。`DSH_OPENSHELL_NODE_IMAGE` 仅用于测试时选择受信的基础镜像源或本地缓存，留空使用deploy/runtime/Dockerfile 的 digest。`DSH_OPENSHELL_REMOTE_HOME` 为远端安装目录，相对路径以远端用户主目录为准，需包含 `bin/openshell` 与 `gateway.toml`。夹具据标准回环端口 18080–18082、`openshell-docker` Gateway ID、`openshell` 标签及 Docker driver 生成隔离配置。所有真实服务器、账号、路径和凭据只保存在忽略的 `.env` 或其引用的私有连接 JSON 中。

测试宿主的 CLI 仅用于临时 Gateway／沙箱的准备、清理和清单核对，不属于 Provider 的执行路径。权限矩阵与命令测试均通过正式 SDK-only Provider。

## 文件与职责

```text
.
├── deploy/
│   ├── deploy.mjs
│   ├── compose.yaml
│   ├── runtime/
│   ├── openshell/
│   └── diagnostics/
├── src/
│   ├── index.ts
│   ├── connection.ts
│   ├── sandbox/
│   ├── subprocess/
│   ├── fs/
│   ├── workspace/
│   └── runtime/
├── scripts/
│   ├── build.mjs
│   └── prepare-official-sdk.mjs
├── tests/
│   ├── deploy/
│   ├── sandbox/
│   ├── subprocess/
│   ├── fs/
│   ├── e2e/
│   └── fixtures/
└── docs/
    ├── 00-governance/
    ├── 10-requirements/
    ├── 20-design/
    └── 30-guides/
```

[REQUIREMENTS.md](../10-requirements/REQUIREMENTS.md) 记录范围和验收条件；[DESIGN.md](../20-design/DESIGN.md) 记录实现、真实验证结果与缺口。
