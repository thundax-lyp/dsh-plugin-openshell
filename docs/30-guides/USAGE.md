# DSH 接入指南

[返回 README](../../README.md) · [部署](DEPLOYMENT.md) · [接入](USAGE.md) · [验证与开发](VALIDATION.md)

npm 安装后在调用方项目使用下面的包入口；部署与源码验证命令从本仓库根目录运行。部署沙箱后，再在沙箱外的 DSH 环境中接入。

## 安装沙箱外接入包

接入环境使用 Node.js 22.19+ 的 22.x 或 Node.js 24+。固定安装预发布版本：

```sh
npm install --save-exact dsh-sandbox-openshell@0.1.0-rc.1
```

包使用 rc dist-tag；生产接入方应固定完整版本。依赖基线为 DSH 0.2.1-rc.4 / Cordis 4.0.5。npm 产物包含 dist（JS、类型、沙箱 helper 及其独立依赖清单）和公开文档，部署工具从源码仓库使用。沙箱 helper 的 DSH 协议版本仍为 0.2.1-rc.4，与接入包自身版本分别管理。

在 DSH 所在环境准备 OpenShell 0.1.6 官方 TypeScript SDK，按[官方 SDK 安装说明](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/sdk/typescript/README.md)配置 GitHub Packages，或使用该 release 源码构建。调用方负责创建并认证 SandboxClient。本包不内置 SDK 的认证或传输实现，也不分发凭据。

`interactiveClient` 为必填项，Gateway 和认证由该官方 SDK client 管理。本包配置沙箱名、远端工作区、helper 位置和客户端 deadline，不再接收 `cli` 或重复的 `gatewayEndpoint` 配置。

## 使用

```js
import { Context } from '@deepseek-ai/cordis';
import { apply } from 'dsh-sandbox-openshell';
import { SandboxClient } from '@nvidia/openshell-sdk';

const gatewayEndpoint = 'http://127.0.0.1:18080';
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

固定输入与管道输入都会自动分帧，单次写入超过 1 MiB 的 stdin 也可传输；分帧不改变输入内容。

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
