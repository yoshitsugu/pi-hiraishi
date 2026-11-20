# pi Hiraishi

English | [日本語](README.ja.md)

Filesystem and HTTP isolation for pi, powered by [Anthropic Sandbox Runtime](https://github.com/anthropics/sandbox-runtime) (SRT). Choose permissions per session; ordinary tool calls need no approval.

## Install

Requires Linux (x86-64 or ARM64), Node.js 22.19+, pi 1.4.x, bubblewrap, socat and ripgrep, with working user namespaces. SRT is pinned to 0.0.81.

```sh
pi install git:github.com/yoshitsugu/pi-hiraishi
```

- Keep Hiraishi, its dependencies, Node and the configuration outside writable grants.
- Use a separate installed copy when developing this repository.
- If isolation fails, tools are refused; there is no unconfined fallback.

## Configuration

Save settings to `~/.pi/agent/hiraishi/config.json` (or the same place under a custom pi agent directory).
`HIRAISHI_CONFIG` overrides the path, and JSON comments are supported. A missing file uses these defaults:

```json
{
  "networkMode": "off",
  "maxNetworkMode": "http-all",
  "readOnly": [],
  "readWrite": [],
  "maxReadOnly": [],
  "maxReadWrite": [],
  "denyRead": []
}
```

The session working directory is readable and writable, including deletion. Everything else is granted with these settings:

| Setting | Purpose |
| --- | --- |
| `readOnly` | Reference repositories, documentation, skills and toolchains (read only). |
| `readWrite` | Caches and other directories that tools may modify. |
| `denyRead` | Files or directories to hide, such as `.env`. Missing paths are accepted. |
| `networkMode` | The startup network mode (see below). |
| `maxNetworkMode` | The highest mode that can be reached while running. Defaults to `http-all`, so a person can always raise the mode. |
| `maxReadOnly`<br>`maxReadWrite` | Path ceilings for requests that need no confirmation (next paragraph). |

`maxReadOnly` and `maxReadWrite` grant nothing by themselves. Paths that `--hiraishi-grants`, `hiraishi_subagent` or a host command's `{cwd}` request are accepted without a dialog only if they are inside one of these ceilings. `maxReadWrite` also counts as a read ceiling.

Paths:
- Use absolute paths or `~/...`. Globs are rejected.
- Grants must name existing directories.
- A `readOnly` grant may contain the working directory or a `readWrite` directory: those writable roots stay writable, while their siblings under the grant remain read-only.
- HOME and pi's state directory cannot be granted whole. Grant the specific subdirectories you need.

Safety:
- Tools get a fresh HOME and temporary directory, and no credentials from the host environment.
- Known credential paths are denied automatically. Hide any other secrets inside allowed directories with `denyRead`.
- Writes change host files directly. Keep a separate copy of work you cannot lose.

If socat is not on PATH, set `"socatPath": "/absolute/path/to/socat"`.
Apply changes with a new session or `/reload`.

## Network

A person switches modes with `/hiraishi-network <mode>`. Without an argument it shows the current mode.

| Mode | Allowed traffic |
| --- | --- |
| `off` | No external access (default). |
| `http-get` | HTTP/HTTPS GET and HEAD to public DNS hostnames. |
| `http-all` | All HTTP methods to public DNS hostnames. |

- Connections to the model provider work in every mode, including `off`.
- Blocked: literal IPs, localhost, private addresses, host Unix sockets, SSH, arbitrary TCP/UDP, SOCKS and WebSocket upgrades.
- HTTPS is inspected through SRT's TLS proxy. Clients that pin certificates or use mTLS may fail.
- **GET alone can still disclose data or trigger remote changes.** `http-all` also allows uploads and remote updates. Readable content may be sent to the model provider.
- After a refusal, the model pauses the affected work and asks the user whether to continue offline or change the mode. This is guidance to the model; the sandbox enforces the permissions.
- Changing the mode stops running tools and connections. Interrupted calls must be retried, and completed effects cannot be undone.
- Switching sessions or running `/reload` restores the configured mode.

## Tools

`read`, `write`, `edit`, `bash` and the `!` / `!!` commands run in the same sandbox.
Custom tools that are not adapted are refused.

- Files are limited to 32 MiB.
- Shell commands time out after 120 seconds by default, or up to one hour when set explicitly.
- Commands and their descendants stop on completion or cancellation, so persistent background servers are not supported.

### hiraishi_subagent

Each call runs a child in its own sandbox.

- By default: network off, working directory only. The parent's mode and configured extra grants are not inherited; configured `denyRead` rules are.
- `review` mode (default): reads and fixed Git diff/status commands only.
- `work` mode: also writes, edits and bash.
- A child cannot delegate recursively or change its own permissions.
- Choose a model with `model: { "provider": "...", "id": "..." }`. Omit it to use the parent's model. An unknown model or a provider failure stops the run without switching models. Pi handles authentication on the host; credentials never reach the sandbox.

**Adding permissions (`permissions`)**
- `networkMode`, `readOnly`, `readWrite` and a `reason`. They apply to that call only.
- Network may be requested up to the session ceiling. Directories must stay inside the session's path ceiling (configured grants plus `maxReadOnly` / `maxReadWrite`).
- Requests beyond the ceiling are refused. With `"approval": "user"` the user is asked to cancel, run with default permissions, or run as requested. Without an interactive UI the call stops.
- The parent is instructed to request only what the user's approved task covers. That is guidance to the model; SRT enforces the permissions that are chosen.

**Narrowing permissions (`permissions`)**
- `denyRead`: paths only this child cannot read. They are added to the session and configuration `denyRead`, which can never be removed.
- `workspace`: an existing directory inside the parent's working directory, used as the child's working directory and default read/write root. A path outside the parent, a missing path, or a symlink that resolves outside is refused.
- Both only narrow the child, so no approval is needed.
- Hiding a file the child needs makes its reads fail. The child reports this as a constraint instead of probing other paths.
- If `workspace` names only part of a repository, the child cannot read `.git`, so `git_diff` and `git_status` in `review` mode do not work.

**Limits**
- Controls are path based. Hard links, bind mounts and other aliases can reach the same data through an allowed path, so this is not a complete data boundary.
- A write outside `workspace` can be silently discarded instead of failing. Have the child write deliverables inside `workspace`, and check from the parent when they matter.

Example arguments (replace the provider and ID with a registered model):

```json
{
  "task": "Update the API integration using the current documentation.",
  "mode": "work",
  "model": { "provider": "your-provider", "id": "your-model-id" },
  "permissions": {
    "networkMode": "http-get",
    "approval": "user",
    "reason": "Reading the current API documentation needs network access."
  }
}
```

## Host commands

When you need a host program the sandbox cannot reach, declare it under `hostCommands`. A typical case is the control client of a terminal multiplexer that talks over a Unix socket. Nothing runs without an entry.

```json
{
  "hostCommands": [
    {
      "name": "hc",
      "path": "/usr/bin/hc",
      "starts": "run",
      "operations": [
        { "name": "run", "argv": ["run", "--bg", "--name", "{name}", "--cwd", "{cwd}", "pi", "-e", "{hiraishi}", "--hiraishi-grants", "{grants}", "{task}"] },
        { "name": "send", "argv": ["send", "{name}", "{task}"] },
        { "name": "read", "argv": ["read", "--lines", "{lines}", "{name}"] },
        { "name": "list", "argv": ["ls"] }
      ]
    }
  ]
}
```

The model calls the declared operations through `hiraishi_host`. It cannot choose the binary, add flags or use a shell; it can only supply values for the placeholders.

### Placeholders

Each placeholder fills a whole argv entry.

| Name | Meaning |
| --- | --- |
| `{name}` | The name of a child that was started. |
| `{cwd}` | An existing directory. It becomes the child's working directory and default read/write root. |
| `{task}` | The task text. It may not start with `-` or `@` (the started program could read it as an option or a file). |
| `{grants}` | The permissions JSON passed to the child. |
| `{lines}` | The number of lines to read (an integer from 0 to 2000). |
| `{timeout}` | The time limit of this call, in seconds. |
| `{hiraishi}` | The path of the running Hiraishi extension. |

How `{cwd}` is handled:
- The session workspace, write grants and anything inside `maxReadWrite` are used without asking.
- Any other directory asks the user in interactive sessions. The dialog shows the command, operation, resolved `cwd`, the child `{grants}` and the start of `{task}`. Without an interactive UI the request is refused.
- A child workspace is writable, so a read-only path outside the write ceiling cannot be used.
- Pass a subdirectory to narrow the child to it. `denyRead` in `{grants}` can hide parts inside it.
- A write outside `{cwd}` can be silently discarded. Have the child write deliverables inside `{cwd}`.

### Operations that start a child

`{grants}` is required on the operation named by `starts` and on any operation that uses `{hiraishi}`, so a child cannot fall back to its own configuration and bypass the ceilings.
An operation that starts the host `pi` without `{hiraishi}` runs outside Hiraishi; in that case write both placeholders.

The bridge rebuilds the child's permissions every time:
- Only the intersection of the requested paths and the configuration is passed.
- The network mode and its ceiling are capped at the session ceiling.
- The session `denyRead` is added.
- The expected working directory is pinned (the child verifies it).
- `maxReadOnly` and `maxReadWrite` are not passed.
- Commands with `starts` are not passed, so a child cannot delegate again.
- A requested path the configuration cannot hold is refused, not dropped.

Operations that take `{name}` reach only children started by the same command in the same session. Switching sessions or cancelling clears that list and aborts a running host call. Only the direct host process stops: a child the program started in the background keeps running, and this session can no longer control it.

### Environment variables (`env`)

An allowlist of variable names to pass from the host `pi` process to that command.

- They are added to the fixed environment (`HOME`, `PATH`, `TERM`, locale, XDG and D-Bus entries).
- Names must match `[A-Za-z_][A-Za-z0-9_]*` and are checked when the configuration loads.
- A value is passed only if the host process has it.
- Configuration only; rejected in `--hiraishi-grants`.
- Hiraishi adds no tool-specific variables. If a program needs an inherited variable, such as the caller's identity for a terminal control client, name it here.

```json
"env": ["CONTROL_SOCKET", "SERVICE_TOKEN"]
```

Passed values become ordinary environment for the command. A token or a socket path gives it the authority that goes with it. Declare only trusted programs and pass only the names they need.

### Commands kept for children (`delegable`)

A command with `"delegable": true` stays available to delegated children. The default is `false`.

- It cannot be combined with `starts` (rejected at load time).
- Its operations cannot use `{hiraishi}` or `{grants}`.
- Only commands the parent still has are passed. `{grants}` cannot add names.
- A kept command runs host programs with the child's permissions. Mark only fixed commands you are sure are safe to delegate, such as a dedicated wrapper that runs tests inside a sandbox.

## Command-line grants

An outer agent or a shell script can start pi with session-scoped permissions through `--hiraishi-grants`.

```sh
pi -e /path/to/pi-hiraishi --hiraishi-grants '{"networkMode":"http-get","readOnly":["/docs"],"readWrite":["/cache"],"denyRead":["/project/.env"]}' --print "Update the API integration from the current docs"
```

Fields of the JSON:

| Field | Meaning |
| --- | --- |
| `networkMode` | The startup mode. |
| `maxNetworkMode` | The ceiling for this run. |
| `readOnly`<br>`readWrite`<br>`denyRead` | **Added** to the configuration. Configured grants stay even if you leave them out. `denyRead` only grows. |
| `replace` | `{"readOnly": [...], "readWrite": [...]}`. Only when given, it replaces the configured grants. Giving both `readOnly` and `replace.readOnly` is an error. The result must still stay inside the session ceiling. |
| `cwd` | The expected working directory. A session whose working directory resolves elsewhere refuses to start. |
| `hostCommands` | Names of configured commands to keep; all others are dropped. Unknown names and commands with `starts` are refused. |
| `noHostCommands` | `true` drops every host command. Combined with `hostCommands`, only those names stay. |

- Every field either narrows the session or stays inside the configured ceilings. `socatPath`, `maxReadOnly` and `maxReadWrite` are rejected.
- `{"networkMode":"off","maxNetworkMode":"http-get"}` starts with the network off and allows raising it up to `http-get`. A `networkMode` above `maxNetworkMode` is rejected. A value above the configured `maxNetworkMode` needs the user's approval, and the approved value becomes the ceiling.
- An empty `hostCommands: []` drops everything, like `noHostCommands: true`.

**Requests beyond the ceiling**
- Interactive sessions ask the user: allow as requested, start with the baseline, or refuse.
- "Start with the baseline" drops only what the request adds. Restrictions still apply: added `denyRead`, `noHostCommands`, `hostCommands` and `replace` narrowing, and a lowered ceiling.
- Without an interactive UI, a refused or malformed request ends the process and prints the reason to stderr. Other startup failures leave the session running with tools unavailable.

Grant paths are canonicalized when loaded and merged. Moving a symlink over an approved path makes the next sandbox start fail. The resolved permissions become the ceiling for `/hiraishi-network`, subagents and host commands.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

- `HIRAISHI_REQUIRE_SANDBOX=1`: fail when sandbox prerequisites are missing.
- `HIRAISHI_TEST_SOCAT=/absolute/path/to/socat`: use a test-only socat.

Pi and installed extensions remain trusted host code.
See [SECURITY.md](SECURITY.md) for the full boundary and limitations.
