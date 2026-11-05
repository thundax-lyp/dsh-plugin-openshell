# dsh-sandbox-openshell

让沙箱外的 DSH 通过 OpenShell 官方 SDK 执行入口，在指定沙箱内使用同一工作区的文件和普通进程能力，并施加逐调用文件权限。参考官方 `dsh-sandbox-ssh` 的契约，复用沙箱内 `LocalSandboxProvider`，不提供 SSH 中继或平台控制面。

基线：DSH **0.2.1-rc.4**、Cordis **4.0.5**、OpenShell **0.1.6**。本机使用 Node.js `^22.19.0` 或 `>=24.0.0`、pnpm `12.15.0`；真实验证使用 Node.js 24、Linux x64。

**当前是有限能力的接入实现。**真实环境的权限后端报告 partial，默认严格模式会拒绝受限命令执行；诊断模式下 read-only 和 workspace-write 的文件及 shell 边界已验证。官方 SDK 交互式路径已验证主动取消与客户端 deadline 会停止受测父进程和同组子进程；setsid 脱离进程组的后代仍有缺口，不能提供任意进程树退出证明。完整 Agent 工具环境不在当前范围内。

## 安装沙箱外接入包

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

在 DSH 所在环境准备 OpenShell 0.1.6 官方 TypeScript SDK，按[官方 SDK 安装说明](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/sdk/typescript/README.md)配置 GitHub Packages，或使用该 release 源码构建。调用方负责创建并认证 SandboxClient。本包不内置 SDK 的认证或传输实现，也不分发凭据。

`interactiveClient` 为必填项，Gateway 和认证由该官方 SDK client 管理。本包配置沙箱名、远端工作区、helper 位置和客户端 deadline，不再接收 `cli` 或重复的 `gatewayEndpoint` 配置。

## 使用 Compose 部署

部署配置统一在 `deploy/`，Compose 入口为 `deploy/compose.yaml`：`runtime/` 为正式镜像，`openshell/` 为沙箱策略，`diagnostics/` 为远端验收专用镜像层。运行时代码和依赖清单仍维护在 `src/runtime/`。

在已有 OpenShell Gateway 的 Linux x64 主机上，使用 Docker Compose v2 完成整条部署链路。一次性 runtime 部署容器先构建镜像，再调用官方 CLI 创建沙箱、等待 READY，并通过 `policy set --wait` 确认策略加载，成功后退出 0。DSH 仍通过 SDK 连接沙箱。

首次准备配置和客户端依赖（已有 `.env` 时补充 `.env.example` 中新增的部署字段，尤其是 `COMPOSE_FILE`）：

```sh
cp -n .env.example .env
chmod 600 .env
mkdir -p runtime/bin runtime/openshell-credentials
```

将官方 **Linux x64 OpenShell CLI 0.1.6** 放到 `runtime/bin/openshell` 并赋予执行权限，或在 `.env` 的 `DSH_OPENSHELL_CLI_PATH` 指定已安装的官方 CLI 绝对路径。该目录和 CLI 不进入正式镜像。配置 `DSH_OPENSHELL_GATEWAY_ENDPOINT`、`DSH_OPENSHELL_SANDBOX` 及 workspace；沙箱名须为 1–19 字符的小写 DNS label，默认 `dsh-openshell`，HTTPS/mTLS 时，在 `DSH_OPENSHELL_CREDENTIALS_DIR` 指向的私有目录放入 `ca.crt`、`tls.crt`、`tls.key`，HTTP 测试入口保留空目录。默认凭据目录为仓库内 `runtime/openshell-credentials`。已有 Gateway 的部署与授权由部署方负责。

HTTPS Gateway 还需信任客户端签发 CA 并启用 mTLS 用户认证，关闭匿名用户访问；Docker driver 需配置 `guest_tls_ca`，供沙箱验证 Gateway 的服务端证书。普通用户证书需具备目标 workspace 的创建与策略修改权限。

从仓库根目录执行（`.env.example` 已声明 `COMPOSE_FILE=deploy/compose.yaml`）：

```sh
docker compose up -d
docker compose logs -f runtime
docker compose ps -a
```

也可显式指定配置：`docker compose --env-file .env -f deploy/compose.yaml up -d`。无需再手工执行 sandbox create 或 policy set。`up -d` 是异步启动；以日志中的 `"status":"READY"` 和 runtime 容器退出码 0 为部署成功依据。失败容器保留非零退出码，不自动重试不确定的创建请求。

重复 `up -d` 会检查同名沙箱的部署标签和镜像引用，复用同一沙箱、重新加载策略并等待生效。同名但非本部署所有、镜像引用发生变化或沙箱处于终止状态时明确报错，不自动删除或重建。镜像引用应使用不可变标签／digest；同标签内容更新不作为自动升级能力。`docker compose down` 仅清理初始化容器，不删除 OpenShell 沙箱及工作区；删除沙箱仍由部署方显式执行官方命令。

部署容器使用宿主网络访问 Gateway，不挂载 Docker socket。它以 root 读取只读客户端凭据，临时副本位于 tmpfs，退出后不进入镜像或目标沙箱；正式沙箱仍使用镜像中的 node 用户。HTTP 与 mTLS Gateway 均已完成真实验收：首次创建、重复启动复用同一沙箱、修改策略后等待新版本生效。无客户端证书及错误 CA 签发的客户端证书均被拒绝。交互式 OIDC/edge 登录尚未验证。远端 Gateway 需能取得配置的镜像；本流程不自动推送镜像。

`DSH_OPENSHELL_RUNTIME_IMAGE` 控制镜像引用，`DSH_OPENSHELL_NODE_IMAGE` 可指定受信 Node.js 24 基础镜像源，`DSH_OPENSHELL_BUILD_NETWORK` 只控制构建网络，不改变目标沙箱出口策略。`.env` 中的 SSH 测试凭据不注入部署容器；只显式传入部署所需的非秘密参数，客户端证书通过只读文件挂载。

deploy/runtime/Dockerfile 固定 Node.js 24.19.0 官方基础镜像的 digest，通过 `src/runtime/package-lock.json` 安装 DSH 0.2.1-rc.4／Cordis 4.0.5。构建无需宿主 Node 或 pnpm；需要拉取基础镜像和访问 npm registry。使用受信镜像源时，可通过 `.env` 的 `DSH_OPENSHELL_NODE_IMAGE` 覆盖基础镜像，保留 Node.js 24 和兼容的 glibc 环境，建议引用 digest。

镜像使用 node 用户（UID/GID 1000），工作区为 `/sandbox/project`，默认运行 `sleep infinity`。`/opt/dsh-runtime` 中的权限／文件 helper、依赖、Linux x64 ripgrep 和 launcher 均归 root 所有且不可写；镜像不包含 SDK、DSH Agent、凭据或测试诊断工具。`deploy/runtime/Dockerfile.dockerignore` 只允许传入正式镜像所需文件，排除 .env、缓存和工作区数据。

`deploy/openshell/policy.yaml` 提供最小外层策略：helper 只读、工作区和临时目录可写，默认不开放网络出口。权限包装仍在沙箱内完成；DSH 和官方 SDK 在沙箱外运行。镜像不会升级宿主内核的 Landlock ABI，partial 环境下默认严格模式仍会拒绝执行。

## 使用

```js
import { Context } from '@deepseek-ai/cordis';
import { apply } from './dist/index.js';
import { SandboxClient } from '@nvidia/openshell-sdk';

const gatewayEndpoint = 'https://gateway.example.com';
const interactiveClient = await SandboxClient.connect({
    gateway: gatewayEndpoint,
});
await interactiveClient.waitReady('dsh-openshell', 120);
const ctx = new Context();
await apply(ctx, {
    interactiveClient,
    sandbox: 'dsh-openshell',
    helper: '/opt/dsh-runtime/confine.mjs',
    workspaceRoot: '/sandbox/project',
    defaultMode: 'read-only',
    executionTimeoutSeconds: 60,
});

try {
    const cwd = ctx.openShellWorkspace.root;
    const file = await ctx.fs.resolve('message.txt');
    await ctx.fs.writeText(file, 'hello\n', undefined, undefined, {
        mode: 'workspace-write',
        workspaceRoot: cwd,
    });
    console.log(await ctx.fs.readText(file));
    const wrapped = await ctx.sandbox.confine(
        ['/bin/sh', '-c', 'printf hello > message.txt'],
        { mode: 'workspace-write', workspaceRoot: cwd },
    );
    const handle = ctx.subprocess.spawn({
        argv: wrapped.argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 1000,
    });
    handle.stdout.pipe(process.stdout);
    handle.stderr.pipe(process.stderr);
    const result = await handle.done;
    console.log(result);
} finally {
    await ctx.fiber.dispose();
}
```

`apply` 安装 `OpenShellFileSystem`、`OpenShellWorkspace`、`OpenShellSandboxProvider` 和使用同一连接配置的 `OpenShellSubprocessRuntime`。前者只包装 argv；后者负责在远端执行，保留 cwd 和输出语义。不能用本地进程 Provider 执行远端 launcher 路径。helper 调用和命令执行必须使用同一个 SDK client，缺少 client 时立即拒绝配置。

默认要求 `enforcement=full`。仅在明确接受 best-effort 语义或做诊断时设置 `requireFullEnforcement: false`。这不会使 partial 变成 full。OpenShell 外层权限仍限制所有调用。

本包不提供文件 watch、PTY、PTC 控制 fd、环境覆盖、Session 持久化或执行接管。不要将本地 FileSystem 当作沙箱内文件能力。SDK 路径将 `executionTimeoutSeconds` 用作客户端 deadline，明确关闭服务端 `timeoutSecs`；取消使用官方 SDK 的 RPC cancel，stdin EOF 使用 closeInput。`done` 等待最终 gRPC 状态；客户端 deadline／取消会拒绝该 Promise。`waitForExit` 在传输关闭后报告远端范围退出未确认，正常命令退出也不证明后代已停止。它不能用于要求范围退出证明的消费者；Context dispose 关闭或取消本次传输，不提供整个远端范围退出证明。

## 文件与工作区

`ctx.fs` 的 resolve、stat/lstat、读文本／流、字节窗口、目录列表、原子写入与字面编辑都在沙箱内完成。`fileSystemHelper` 默认为 confine.mjs 同目录下的 fs.mjs。默认文件模式 `defaultMode: 'read-only'`，writeText/editText 的最后一个参数可传本次调用的 DSH 策略；workspace-write 按 DSH 规则允许绑定工作区及 `/tmp`，拒绝区外写入。文件默认模式不会为普通 `subprocess.spawn` 自动添加内核权限包装；任意代码仍须先调用 `sandbox.confine`，或交由 DSH 的沙箱 shell 工具处理。

`workspaceRoot` 是沙箱内的绝对路径，默认 `/sandbox/project`，需由部署方准备为实际目录。策略可使用其子目录，但不能把工作区扩大到绑定根之外。普通 spawn 的 cwd 也必须由调用方传入远端目录；示例使用 `ctx.openShellWorkspace.root`。文件 target 不能跨 Provider 使用，`processPathFromHostPath` 不提供宿主映射。

目录切换沿用 DSH 的 Session 变更与通知；空路径、区外目录及不存在的目录会拒绝，失败时不改变已提交工作目录。

普通 Agent 的 sessionProjections/systemPrompt 服务就绪时，本插件自动安装 `OpenShellWorkingDirectory`，复用 DSH 的目录验证、变更日志与上下文提示，并拒绝工作区外的目录。应让本插件负责 workingDirectory 服务，避免再装另一个本地目录 Provider；创建 Session 时将 header.cwd 设置为远端工作区或其子目录。这里不创建 workspace registry、Session 存储或卷生命周期服务。

RC 的 glob/grep 插件使用宿主打包的 ripgrep 路径。接入搜索时，通过受信配置显式将这个路径替换为镜像内二进制，仍使用上游搜索工具：

```js
import { resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search';

// 加入前述 apply 的配置；工具插件本身由 DSH 上层按常规注册。
const searchExecutable = {
    host: await resolveRgPath(),
    remote: '/opt/dsh-runtime/node_modules/@vscode/ripgrep-linux-x64/bin/rg',
};
```

只有与 host 完全相同的 argv[0] 会被替换。搜索需带 Agent，以便上游使用远端 workingDirectory；无 Agent 时上游回退至宿主 process.cwd，本包不会将该目录自动映射到远端。

单次 readText/readBytes、写入文本、编辑结果及 readByteRange 窗口限 1 MiB；序列化请求另限 1 MiB + 64 KiB，超限返回 FS_TOO_LARGE，不截断内容。更大的文本用 streamText，原始文件用分段 readByteRange。write/edit 的版本和内容计算复用 DSH；helper 间通过上游原生 flock 串行化同一目标的变更。watch 未实现。取消或断线不能证明一次原子写入尚未提交，调用方应先读回对账。

文件路径检查在受信 SandboxedFileSystem 内完成，不依赖当前环境的 Landlock full；它保留上游祖先符号链接检查与 syscall 间的竞态限制。命令的 ABI 4/partial、严格拒绝及 setsid 取消缺口仍独立存在。

## 验证

```sh
cp -n .env.example .env
chmod 600 .env
# 填写私有配置后运行；入口自行加载 .env
pnpm test:remote
# 仅验证 mTLS Compose 部署、认证拒绝和策略更新
pnpm test:mtls
```

本机 Provider 契约测试只使用根目录锁定的依赖，无需调试 runtime 或远端服务器。远端入口按沙箱 helper 与外部测试客户端的锁文件安装依赖，测试宿主需要访问 npm registry。入口还会在仓库内 `runtime/` 下载并构建固定 v0.1.6 revision 的官方 SDK，本机首次准备需要访问 GitHub、npm registry 和 Buf Schema Registry，后续复用缓存；它不依赖全局调试目录。

远端测试需要 Linux x64、Node.js 24、npm、Docker Compose v2、cc、bwrap、unshare、已安装的 OpenShell 0.1.6 CLI 和 Gateway 基础配置。cc／bwrap／unshare 仅用于原生 ABI 与 namespace 诊断，不是生产 Provider 依赖。测试使用临时 Gateway 的 18180–18182 端口，按 deploy/runtime/Dockerfile 构建正式镜像，并额外构建诊断层；准备一个纯正式镜像沙箱和两个诊断沙箱，结束后核对清理及原 Gateway 配置、沙箱清单。不再需要预装测试基础镜像或复制宿主 Node。测试不部署 SSH 服务；SSH 只用于将测试文件发送到测试宿主并启动外部 DSH 验证进程。

`.env.example` 声明配置字段。`DSH_OPENSHELL_NODE_IMAGE` 仅用于测试时选择受信的基础镜像源或本地缓存，留空使用deploy/runtime/Dockerfile 的 digest。`DSH_OPENSHELL_REMOTE_HOME` 为远端安装目录，相对路径以远端用户主目录为准，需包含 `bin/openshell` 与 `gateway.toml`。夹具据标准回环端口 18080–18082、`openshell-docker` Gateway ID、`openshell` 标签及 Docker driver 生成隔离配置。所有真实服务器、账号、路径和凭据只保存在忽略的 `.env` 或其引用的私有连接 JSON 中。

测试宿主的 CLI 仅用于临时 Gateway／沙箱的准备、清理和清单核对，不属于 Provider 的执行路径。权限矩阵与命令测试均通过正式 SDK-only Provider。

## 文件与职责

| 文件／目录                                               | 功能                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| deploy/openshell/deploy.mjs                              | 官方 CLI 的一次性沙箱创建、READY 与策略加载                |
| tests/deploy/compose.test.mjs                            | 部署幂等、归属冲突、失败与策略等待契约                     |
| deploy/compose.yaml                                      | Compose 镜像构建入口                                       |
| deploy/runtime/Dockerfile / Dockerfile.dockerignore      | 正式沙箱镜像及最小构建上下文                               |
| deploy/diagnostics/                                      | 远端验收专用镜像及构建过滤，不用于正式部署                 |
| deploy/openshell/policy.yaml                             | 创建沙箱所用的最小外层策略                                 |
| src/index.ts                                             | 插件入口与公共导出                                         |
| src/connection.ts                                        | 官方 SDK 调用及固定沙箱目标                                |
| src/sandbox/                                             | Sandbox Provider 与 full 检查                              |
| src/fs/                                                  | OpenShellFileSystem，文件目标及 SDK 文件协议               |
| src/workspace/                                           | 固定远端工作区与 DSH 工作目录接入                          |
| src/subprocess/                                          | 同沙箱普通进程 Provider                                    |
| src/runtime/                                             | 沙箱内权限／文件 helper、ripgrep 与锁定依赖                |
| scripts/prepare-official-sdk.mjs                         | 为验收构建固定 revision 的官方 SDK（缓存于 ./runtime）     |
| scripts/build.mjs                                        | 构建可被 Node 导入的包和 runtime 文件                      |
| tests/subprocess/interactive.test.mjs                    | 本机 SDK 进程、取消与输出契约测试                          |
| tests/e2e/provider.test.mjs                              | 真实命令权限、输出与目标隔离验收                           |
| tests/fs/provider.test.mjs                               | 本机文件协议与目标隔离测试                                 |
| tests/e2e/fs.test.mjs                                    | 真实文件权限、并发版本与 DSH 搜索验收                      |
| tests/sandbox/provider.test.mjs                          | 本机 Provider 契约入口                                     |
| tests/e2e/cancellation.test.mjs                          | 正式 Provider 的取消、deadline、dispose 与 setsid 边界测试 |
| tests/e2e/image.test.mjs                                 | 纯正式镜像的非 root、helper 保护和外部 SDK 接入验收        |
| tests/e2e/mtls.test.mjs                                  | 官方 SDK 的 mTLS 有证书／无证书／错误签发 CA 认证检查      |
| tests/fixtures/deploy/mtls.mjs                           | 临时 mTLS Gateway、三次 Compose 启动与有效策略版本检查     |
| tests/e2e/remote.test.mjs                                | 真实 OpenShell 的 RC 验收入口                              |
| tests/fixtures/{host,deploy,sandbox,fs,runtime,support}/ | 宿主连接、沙箱与 Provider 探针、镜像准备和进程辅助         |

[REQUIREMENTS.md](docs/10-requirements/REQUIREMENTS.md) 记录范围和验收条件；[DESIGN.md](docs/20-design/DESIGN.md) 记录实现、真实验证结果与缺口。
