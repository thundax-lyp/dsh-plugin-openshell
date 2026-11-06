# AI 协作入口

## 规则与读取路由

本文件面向 AI，以准确、无冗余的开发约束和读取路由为主。README.md 面向人类，以清晰、简单为主，允许与本文件重复必要信息，但不作为开发约束和规则来源。对外行为、安装或配置变化时同步 README 及相关指南。

- 文档组织和同步遵循 [DOCUMENT-RULES.md](docs/00-governance/DOCUMENT-RULES.md)。
- 提交前阅读 [COMMIT-RULES.md](docs/00-governance/COMMIT-RULES.md)。
- 分支、PR 与评审遵循 [PR-RULES.md](docs/00-governance/PR-RULES.md)。
- 产品范围和验收条件由 [REQUIREMENTS.md](docs/10-requirements/REQUIREMENTS.md) 维护。
- 实现边界、权限状态和验收证据由 [DESIGN.md](docs/20-design/DESIGN.md) 维护。

按任务读取涉及的规则和直接依赖。冲突按适用范围与确认依据处理，已有授权覆盖的正常开发直接推进。

## 项目结构

部署配置统一维护在 deploy/，包括 compose.yaml、正式与测试诊断 Dockerfile、各自的 Dockerfile.dockerignore 和 OpenShell policy；测试逻辑仍在 tests/。构建 context 保持仓库根目录，宿主部署入口 deploy/deploy.mjs 准备并校验官方 CLI、预检配置并等待部署结果；底层保持 docker compose up -d（根 .env 指定 COMPOSE_FILE），Compose 构建镜像并运行 deploy/openshell/deploy.mjs，通过官方 CLI 创建沙箱与加载策略，不在根目录复制部署配置。

deploy/runtime/Dockerfile 与 deploy/openshell/policy.yaml 是沙箱运行时交付文件，构建上下文按 deploy/runtime/Dockerfile.dockerignore 允许列表维护；不得再把测试宿主 Node 或私有镜像作为正式构建的前置条件。src/index.ts 是 dsh-sandbox-openshell 的插件入口。src/connection.ts 仅适配官方 SDK；src/sandbox、src/subprocess、src/fs 提供同一沙箱的权限包装、普通执行与文件接口；src/workspace 绑定远端目录并复用 DSH WorkingDirectoryService；src/runtime 保存沙箱内 LocalSandboxProvider／SandboxedFileSystem helper 及锁文件。不得再引入自建 SSH、Run/generation、租约、SQLite Authority、持久化或控制器接管。

测试入口在 tests/deploy、tests/sandbox、tests/subprocess、tests/fs 和 tests/e2e；tests/fixtures 按 host、deploy、sandbox、fs、runtime、support 组织。编排与 fixture 使用 Node.js .mjs，测试入口放在 fixtures 外。远端入口用同一场景清单维护复制与执行，宿主夹具只复制直接依赖，避免把本机模拟器及重复安装目录打包到远端。

## 开发与验证

本机使用 Node.js 22.19+ 的 22.x 或 Node.js 24+、pnpm 12.15.0。真实远端测试目标为 Linux x64 和 Node.js 24，远端需 Docker Compose v2，诊断夹具需 cc、bwrap 与 unshare；本机在 runtime/ 内构建固定 revision 的官方 SDK。DSH 固定 0.2.1-rc.4，禁止未经验收改用 alpha 或其他基线。命令由 package.json 维护。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm check
pnpm test:remote
pnpm test:mtls
```

本机回归无需服务器。远端入口自行读取根 .env，配置字段由 .env.example 声明。沙箱侧依赖与锁文件在 src/runtime，外部测试客户端锁文件在 tests/fixtures/runtime/client；runtime/ 仅用于忽略的本地临时产物。真实服务器、用户、密码和机器路径只保存在 .env，禁止将真实值写入公开文档、测试数据和模板。

验证改变过的正常入口及失败路径。分别记录本机契约、真实远端、未覆盖项和清理结果。删除文件前核对引用和测试覆盖，保留仍被入口使用的夹具。

## 代码与授权

TypeScript 使用 ESM、四空格、LF、单引号和可读的 kebab-case 文件名。执行与文件传输只使用官方 SDK execInteractive；权限和文件机制复用 DSH LocalSandboxProvider、SandboxedFileSystem 与 WorkingDirectoryService，SDK deadline 使用客户端 signal，不使用已知会遗留命令的服务端 timeoutSecs；保持实际 argv、远端 cwd、enforcement、取消及不确定状态语义一致。不得将文件路径策略检查等同于命令的 full 内核隔离；不得加载宿主 LocalFileSystem 替代远端接口。禁止恢复 CLI 兼容执行路径；官方 CLI 仅用于一次性部署、测试资源准备与清理，不进入 DSH Provider 执行路径。禁止以 SDK 流退出冒充远端进程树停止。变更后运行受影响测试和 pnpm check。

保留用户既有工作。只有用户明确要求时才提交、推送、创建 PR 或合并，各项操作分别遵循已有授权。正常实现、文档同步、本机验证和已授权远端验收无需重复确认。
