# pi Hiraishi

English | [日本語](README.ja.md)

Filesystem and HTTP isolation for pi, powered by [Anthropic Sandbox Runtime](https://github.com/anthropics/sandbox-runtime) (SRT). Choose permissions per session; ordinary tool calls need no approval.

## Install

Requires Linux x86-64 or ARM64, Node.js 22.19+, pi 1.4.x, bubblewrap, socat, ripgrep and working user namespaces. SRT is pinned to 0.0.81.

```sh
pi install git:github.com/yoshitsugu/pi-hiraishi
```

Keep Hiraishi, its dependencies, Node and configuration outside writable grants. Use a separate installed copy when developing this repository. Isolation failures leave tools unavailable; there is no unconfined fallback.

## Configuration

Save settings to `~/.pi/agent/hiraishi/config.json`, or the equivalent custom pi agent directory. `HIRAISHI_CONFIG` overrides the path. JSON comments are supported; a missing file uses these defaults:

```json
{
  "networkMode": "off",
  "readOnly": [],
  "readWrite": [],
  "denyRead": []
}
```

The session working directory is readable and writable, including deletion. Additional permissions:

- `readOnly`: reference repositories, documentation, skills and toolchains.
- `readWrite`: caches or other directories that tools may modify.
- `denyRead`: files or directories to hide, such as project `.env` files. Missing paths are accepted.

Use literal absolute paths or `~/...`; globs are rejected. Read/write grants must name existing directories. HOME and pi state cannot be granted as whole directories; grant specific skills directories instead. Runtime and internal session state are protected.

Tools use a fresh HOME and temporary directory without host environment credentials. Known credential paths are denied, but other secrets in allowed directories need explicit `denyRead` entries. Writes affect host files directly; keep a separate copy of valuable work.

For socat outside PATH, set `"socatPath": "/absolute/path/to/socat"`. Apply filesystem changes with a new session or `/reload`.

## Network

The human controls network access with `/hiraishi-network <mode>`. Without an argument, it shows the current mode.

| Mode | Allowed tool traffic |
| --- | --- |
| `off` | No external access (default). |
| `http-get` | HTTP/HTTPS GET and HEAD to public DNS hostnames. |
| `http-all` | All HTTP methods to public DNS hostnames. |

For example, `/hiraishi-network http-get` enables documentation lookups without per-domain prompts. Model/provider connections remain available in `off` mode.

Literal IPs, localhost, private addresses, host Unix sockets, SSH, arbitrary TCP/UDP, SOCKS and WebSocket upgrades are blocked. HTTPS is inspected through SRT's TLS proxy; certificate-pinning and mTLS clients may fail.

**GET-only can still disclose data or trigger remote changes.** `http-all` also permits uploads and remote mutations. Readable content may be sent to the model provider.

After a refusal, the model is instructed to pause affected work when current information or network access would help, then offer offline continuation or a user-selected network mode. This is model guidance; permissions remain enforced by the sandbox.

Mode changes stop running tools and connections. Interrupted calls require retry; completed effects cannot be undone. Session changes and `/reload` reset the mode to the configured default.

## Tools

`read`, `write`, `edit`, `bash` and `!` / `!!` commands share the sandbox. Unadapted custom tools are refused.

`hiraishi_subagent` shares the parent's model and permissions. Its default `review` mode allows reads and fixed Git diff/status commands; `work` also allows writes, edits and bash. It cannot delegate recursively or change permissions.

Files are limited to 32 MiB. Shell commands default to 120 seconds, with explicit timeouts up to one hour. Commands and descendants stop at completion or cancellation; persistent background servers are unsupported.

Pi and installed extensions remain trusted host code. See [SECURITY.md](SECURITY.md) for the full boundary and limitations.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Set `HIRAISHI_REQUIRE_SANDBOX=1` to fail when sandbox prerequisites are missing. `HIRAISHI_TEST_SOCAT=/absolute/path/to/socat` selects a test-only binary.
