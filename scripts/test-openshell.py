#!/usr/bin/env python3
"""OpenShell 0.1.6 部署冒烟测试（Python 3 标准库，无第三方依赖）。

在可访问 OpenShell 网关、健康检查端点和代理的环境中运行：
    python3 scripts/test-openshell.py --report /tmp/openshell-smoke.json

需要 openshell CLI，以及包含 sh/cat/stat/touch/grep/curl/CA 证书的沙箱镜像。
默认使用现有 openshell-validation:0.1.6，不安装软件、不修改网关配置。
每次创建独立沙箱并在退出时请求删除；删除无法确认时返回失败和 UNKNOWN。
外部 HTTPS 站点故障也可能导致测试失败。此脚本不验证 DSH/helper 集成。
"""

import argparse
import http.client
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone


POLICY = """version: 1
filesystem_policy:
  include_workdir: true
  read_only: [/bin, /usr, /lib, /proc, /dev/urandom, /app, /etc, /var/log]
  read_write: [/sandbox, /tmp, /dev/null]
landlock:
  compatibility: best_effort
network_policies:
  github_api:
    name: smoke-github-readonly
    endpoints:
      - host: api.github.com
        port: 443
        protocol: rest
        enforcement: enforce
        access: read-only
    binaries:
      - path: /usr/bin/curl
"""


def url(value):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise argparse.ArgumentTypeError("URL 必须为无凭据、无查询参数的 HTTP(S) 地址")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cli", default=shutil.which("openshell") or str(Path.home() / "openshell/bin/openshell"))
    parser.add_argument("--endpoint", type=url, default="http://127.0.0.1:18080")
    parser.add_argument("--health-url", type=url, default="http://127.0.0.1:18081/readyz")
    parser.add_argument("--proxy-url", type=url, default="http://127.0.0.1:18082")
    parser.add_argument("--workspace", default="default")
    parser.add_argument("--image", default="openshell-validation:0.1.6")
    parser.add_argument("--timeout", type=int, default=120, help="单次 CLI 调用超时秒数（默认 120）")
    parser.add_argument("--report", type=Path, help="可选 JSON 结果文件")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout 必须大于 0")
    proxy = urllib.parse.urlsplit(args.proxy_url)
    if proxy.scheme != "http" or proxy.path not in ("", "/"):
        parser.error("--proxy-url 需要 HTTP CONNECT 代理地址")

    sandbox = "smoke-" + uuid.uuid4().hex[:12]  # OpenShell 名称最多 19 字符。
    result = {"started_at": datetime.now(timezone.utc).isoformat(), "endpoint": args.endpoint,
              "image": args.image, "workspace": args.workspace, "sandbox": sandbox, "checks": []}
    prefix = [args.cli, "--color", "never", "--gateway-endpoint", args.endpoint,
              "--workspace", args.workspace]
    attempted_create = False
    current = "初始化"
    exit_code = 0

    def record(name, status, detail=""):
        result["checks"].append({"name": name, "status": status, "detail": detail})
        print(f"[{status}] {name}" + (f"：{detail}" if detail else ""), flush=True)

    def run(*parts, check=True, timeout=None):
        try:
            completed = subprocess.run(prefix + list(parts), capture_output=True, text=True,
                                       timeout=timeout or args.timeout, env={**os.environ, "NO_COLOR": "1"})
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("CLI 超时，远端结果未知；不会重放该操作") from error
        if check and completed.returncode:
            raise RuntimeError((completed.stdout + completed.stderr).strip()[-2000:]
                               or f"CLI 返回 {completed.returncode}")
        return completed

    def execute(*command):
        return run("sandbox", "exec", sandbox, "--timeout", "30", "--no-tty",
                   "--no-login-shell", "--", *command).stdout.strip()

    def cleanup():
        # 只处理本次随机名称，不清理其他沙箱；查询失败不等同于资源已删除。
        deletion = run("sandbox", "delete", sandbox, check=False, timeout=30)
        deadline = time.monotonic() + 30
        while True:
            state = run("sandbox", "get", sandbox, check=False, timeout=10)
            message = (state.stdout + state.stderr).lower()
            if state.returncode and "sandbox not found" in message:
                record("删除测试沙箱（网关确认）", "PASS")
                return
            if state.returncode:
                raise RuntimeError("沙箱删除结果 UNKNOWN：无法查询网关；请按报告中的名称人工核查")
            if deletion.returncode:
                raise RuntimeError("沙箱仍存在，删除请求失败：" + (deletion.stdout + deletion.stderr)[-1000:])
            if time.monotonic() >= deadline:
                raise RuntimeError("沙箱删除结果 UNKNOWN：网关尚未确认删除完成")
            time.sleep(1)

    def interrupted(signum, _frame):
        raise KeyboardInterrupt(f"signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    try:
        current = "CLI"
        version = run("--version").stdout.strip()
        record(current, "PASS", version)

        current = "网关及数据库就绪"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(args.health_url, timeout=10) as response:
            health = json.load(response)
        if health.get("status") != "healthy" or health.get("checks", {}).get("database", {}).get("status") != "healthy":
            raise RuntimeError("网关或数据库未就绪：" + json.dumps(health, ensure_ascii=False))
        record(current, "PASS", "gateway " + str(health.get("version", "unknown")))

        current = "本机代理 CONNECT"
        connection = http.client.HTTPConnection(proxy.hostname, proxy.port or 80, timeout=10)
        try:
            connection.set_tunnel("api.github.com", 443)
            connection.connect()  # 非 200 CONNECT 会抛出异常；不受 NO_PROXY 绕过影响。
        finally:
            connection.close()
        record(current, "PASS")

        with tempfile.TemporaryDirectory(prefix="openshell-smoke-") as temp:
            policy = Path(temp) / "policy.yaml"
            policy.write_text(POLICY)
            current = "创建沙箱"
            attempted_create = True  # 即使创建响应丢失，也用本次名称核查和回收。
            run("sandbox", "create", "--name", sandbox, "--from", args.image,
                "--policy", str(policy), "--cpu", "500m", "--memory", "256Mi",
                "--detach", "--", "/bin/sleep", "600")
            record(current, "PASS", sandbox)

            current = "命令执行与跨进程文件读写"
            payload = uuid.uuid4().hex
            execute("/bin/sh", "-c", f"set -eu; printf %s {payload} > /sandbox/smoke-check")
            if execute("/bin/cat", "/sandbox/smoke-check") != payload:
                raise RuntimeError("文件读回内容不匹配")
            record(current, "PASS")

            current = "文件策略拒绝"
            output = execute("/bin/sh", "-c", """set -eu
test "$(stat -c %a /var/tmp)" = 1777
if touch /var/tmp/openshell-smoke-denied 2>/tmp/denied.log; then exit 11; fi
grep -qi 'Permission denied' /tmp/denied.log
echo FILE_POLICY_DENIED
""")
            if output != "FILE_POLICY_DENIED":
                raise RuntimeError("文件策略拒绝未确认")
            record(current, "PASS", "1777 目录仍被策略禁止写入")

            current = "策略允许的 HTTPS"
            code = execute("/usr/bin/curl", "--fail", "--silent", "--show-error", "--max-time", "20",
                           "-o", "/dev/null", "-w", "%{http_code}", "https://api.github.com/zen")
            if code != "200":
                raise RuntimeError("预期 HTTP 200，实际为 " + code)
            record(current, "PASS", "HTTP 200")

            current = "未授权 HTTPS 拒绝"
            denied = run("sandbox", "exec", sandbox, "--timeout", "30", "--no-tty", "--no-login-shell",
                         "--", "/usr/bin/curl", "--fail", "--silent", "--show-error", "--max-time", "15",
                         "-o", "/dev/null", "-w", "%{http_code}", "https://example.com", check=False)
            if denied.returncode != 7 or denied.stdout.strip() != "000":
                raise RuntimeError(f"预期连接被拒绝，实际 exit={denied.returncode} HTTP={denied.stdout.strip()}；"
                                   "超时或其他错误不视为策略通过")
            record(current, "PASS", "curl exit 7 / HTTP 000")
    except KeyboardInterrupt:
        exit_code = 130
        record(current, "FAIL", "测试被中断")
    except Exception as error:
        exit_code = 1
        record(current, "FAIL", str(error))
    finally:
        if attempted_create:
            try:
                cleanup()
            except (Exception, KeyboardInterrupt) as error:
                exit_code = exit_code or 1
                detail = str(error) or "清理被中断，结果未知"
                status = "UNKNOWN" if isinstance(error, KeyboardInterrupt) or "UNKNOWN" in detail or "未知" in detail else "FAIL"
                record("删除测试沙箱", status, detail)
        result["finished_at"] = datetime.now(timezone.utc).isoformat()
        result["status"] = "PASS" if exit_code == 0 else "FAIL"
        if args.report:
            try:
                args.report.parent.mkdir(parents=True, exist_ok=True)
                args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
                print(f"报告：{args.report}")
            except OSError as error:
                exit_code = exit_code or 1
                print(f"[FAIL] 写入报告：{error}", file=sys.stderr)
        print(f"结果：{'PASS' if exit_code == 0 else 'FAIL'}", flush=True)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
