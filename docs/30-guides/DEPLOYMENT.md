# 部署指南

[返回 README](../../README.md) · [部署](DEPLOYMENT.md) · [接入](USAGE.md) · [验证与开发](VALIDATION.md)

部署配置统一在 `deploy/`，Compose 入口为 `deploy/compose.yaml`：`runtime/` 为正式镜像，`openshell/` 为沙箱策略，`diagnostics/` 为远端验收专用镜像层。运行时代码和依赖清单仍维护在 `src/runtime/`。

在已有 OpenShell Gateway 的 Linux x64 主机上，使用 Docker Compose v2 完成整条部署链路。一次性 runtime 部署容器先构建镜像，再调用官方 CLI 创建沙箱、等待 READY，并通过 `policy set --wait` 确认策略加载，成功后退出 0。DSH 仍通过 SDK 连接沙箱。

### 默认 HTTP 部署

在已有 Gateway 的 Linux x64 主机上，使用 Node.js 22.19+ 的 22.x 或 Node.js 24+、Docker Compose v2：

```sh
cp -n .env.example .env
chmod 600 .env
# 根据实际环境修改 .env 后运行
node deploy/deploy.mjs
```

默认 `DSH_OPENSHELL_GATEWAY_ENDPOINT=http://127.0.0.1:18080`，无需证书。脚本自动创建空凭据目录，下载固定 **0.1.6** 的官方 Linux x64 CLI、校验 SHA-256 并设置执行权限，然后调用 `docker compose up -d`，等待初始化容器退出 0 且日志报告 `"status":"READY"`。已有兼容 CLI 会复用；可用 `DSH_OPENSHELL_CLI_PATH` 指定绝对路径，路径缺失或版本不符时直接报错，不覆盖用户指定的安装。首次下载需要访问 GitHub；无法访问 GitHub 的主机可预先传入官方 CLI，并通过 `DSH_OPENSHELL_CLI_PATH` 指定。CLI 缓存不进入正式镜像。

HTTP 适合回环地址或由部署方严格控制访问的内部网络；传输不加密，也不提供客户端身份认证。OpenShell 0.1.6 的无认证 Gateway 需由部署方显式配置 `[openshell.gateway.auth]` 下的 `allow_unauthenticated_users = true`；脚本不修改 Gateway 认证配置。已有 Gateway 的部署、授权与网络访问控制由部署方负责。

配置 `DSH_OPENSHELL_SANDBOX` 与 workspace；沙箱名须为 1–19 字符的小写 DNS label，默认 `dsh-openshell`。已有 `.env` 时补充 `.env.example` 中新增字段。CLI／凭据准备完成后也可直接执行原有入口：

```sh
docker compose up -d
docker compose logs -f runtime
docker compose ps -a
```

根 `.env` 声明 `COMPOSE_FILE=deploy/compose.yaml`。`up -d` 是异步启动；宿主脚本会等待部署结果，直接使用 Compose 时以 READY 日志和 runtime 容器退出码 0 为准。失败不自动重试不确定的创建请求，初始化容器保留供排查。脚本只部署到已有 Gateway，不自动启动 Gateway 或推送镜像。

### 可选 HTTPS/mTLS

需要传输加密与客户端身份认证时，将 endpoint 改为 HTTPS，在 `DSH_OPENSHELL_CREDENTIALS_DIR` 指向的私有目录放入 `ca.crt`、`tls.crt`、`tls.key`，再执行同一脚本。默认凭据目录为仓库内 `runtime/openshell-credentials`；自定义目录使用绝对路径。脚本会先检查三个文件是否齐全。

HTTPS Gateway 需信任客户端签发 CA 并启用 mTLS 用户认证、关闭匿名用户访问；Docker driver 需配置 `guest_tls_ca`，供沙箱验证 Gateway 的服务端证书。普通用户证书需具备目标 workspace 的创建与策略修改权限。脚本不自动签发证书或修改 Gateway。

重复 `up -d` 会检查同名沙箱的部署标签和镜像引用，复用同一沙箱、重新加载策略并等待生效。同名但非本部署所有、镜像引用发生变化或沙箱处于终止状态时明确报错，不自动删除或重建。镜像引用应使用不可变标签／digest；同标签内容更新不作为自动升级能力。`docker compose down` 仅清理初始化容器，不删除 OpenShell 沙箱及工作区；删除沙箱仍由部署方显式执行官方命令。

部署容器使用宿主网络访问 Gateway，不挂载 Docker socket。它以 root 读取只读客户端凭据，临时副本位于 tmpfs，退出后不进入镜像或目标沙箱；正式沙箱仍使用镜像中的 node 用户。HTTP 与 mTLS Gateway 均已完成真实验收：首次创建、重复启动复用同一沙箱、修改策略后等待新版本生效。无客户端证书及错误 CA 签发的客户端证书均被拒绝。交互式 OIDC/edge 登录尚未验证。远端 Gateway 需能取得配置的镜像；本流程不自动推送镜像。

`DSH_OPENSHELL_RUNTIME_IMAGE` 控制镜像引用，`DSH_OPENSHELL_NODE_IMAGE` 可指定受信 Node.js 24 基础镜像源，`DSH_OPENSHELL_BUILD_NETWORK` 只控制构建网络，不改变目标沙箱出口策略。`.env` 中的 SSH 测试凭据不注入部署容器；只显式传入部署所需的非秘密参数，客户端证书通过只读文件挂载。

deploy/runtime/Dockerfile 固定 Node.js 24.19.0 官方基础镜像的 digest，通过 `src/runtime/package-lock.json` 安装 DSH 0.2.1-rc.4／Cordis 4.0.5。构建无需宿主 Node 或 pnpm；需要拉取基础镜像和访问 npm registry。使用受信镜像源时，可通过 `.env` 的 `DSH_OPENSHELL_NODE_IMAGE` 覆盖基础镜像，保留 Node.js 24 和兼容的 glibc 环境，建议引用 digest。

镜像使用 node 用户（UID/GID 1000），工作区为 `/sandbox/project`，默认运行 `sleep infinity`。`/opt/dsh-runtime` 中的权限／文件 helper、依赖、Linux x64 ripgrep 和 launcher 均归 root 所有且不可写；镜像不包含 SDK、DSH Agent、凭据或测试诊断工具。`deploy/runtime/Dockerfile.dockerignore` 只允许传入正式镜像所需文件，排除 .env、缓存和工作区数据。

`deploy/openshell/policy.yaml` 提供最小外层策略：helper 只读、工作区和临时目录可写，默认不开放网络出口。权限包装仍在沙箱内完成；DSH 和官方 SDK 在沙箱外运行。镜像不会升级宿主内核的 Landlock ABI，partial 环境下默认严格模式仍会拒绝执行。
