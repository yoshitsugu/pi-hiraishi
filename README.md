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
  "maxNetworkMode": "http-all",
  "readOnly": [],
  "readWrite": [],
  "maxReadOnly": [],
  "maxReadWrite": [],
  "denyRead": []
}
```

The session working directory is readable and writable, including deletion. Additional permissions:

- `readOnly`: reference repositories, documentation, skills and toolchains.
- `readWrite`: caches or other directories that tools may modify.
- `denyRead`: files or directories to hide, such as project `.env` files. Missing paths are accepted.

`networkMode` is the startup mode. `maxNetworkMode` is the ceiling that `/hiraishi-network` and `--hiraishi-grants` may reach (`off` ⊆ `http-get` ⊆ `http-all`); it defaults to `http-all`, so a person can still raise the mode unless the setting is lowered explicitly.

`maxReadOnly` and `maxReadWrite` are path ceilings, not grants. They add nothing to the session itself. They extend the ceiling used by `--hiraishi-grants`, `hiraishi_subagent` and the `{cwd}` of host commands, so a caller can request those paths without an approval dialog. `maxReadWrite` counts as readable as well as writable. A host-launched delegated child does not inherit either ceiling: its limit is exactly the grants the parent passed.

Use literal absolute paths or `~/...`; globs are rejected. Read/write grants must name existing directories. HOME and pi state cannot be granted as whole directories; grant specific skills directories instead. Runtime and internal session state are protected.

Tools use a fresh HOME and temporary directory without host environment credentials. Known credential paths are denied, but other secrets in allowed directories need explicit `denyRead` entries. Writes affect host files directly; keep a separate copy of valuable work.

For socat outside PATH, set `"socatPath": "/absolute/path/to/socat"`. Apply filesystem changes with a new session or `/reload`.

## Command-line grants for other agents

An outer agent can run pi as a tool and attach session-scoped permissions with `--hiraishi-grants`. This works from any runner (Herdr, a shell script, another agent), not just from inside pi:

```sh
pi -e /path/to/pi-hiraishi --hiraishi-grants '{"networkMode":"http-get","readOnly":["/docs"],"readWrite":["/cache"],"denyRead":["/project/.env"]}' --print "Update the API integration from the current docs"
```

The JSON accepts `networkMode`, `readOnly`, `readWrite`, `denyRead`, `hostCommands` (configured command names to keep) and an optional `replace` object with the same path rules as the config file; `socatPath` is rejected.

- `readOnly`, `readWrite` and `denyRead` are additive: they are unioned with the config file, so a caller that omits or shortens a list never removes the always-allowed entries. `denyRead` can only grow.
- `hostCommands` is a keep-list of configured command names. With `noHostCommands: true`, only those commands remain; without it, the configured set is narrowed the same way. An empty `hostCommands: []` removes all host commands, the same as `noHostCommands: true` without a keep-list. Unknown names and commands that define `starts` are refused rather than dropped.
- `replace: { "readOnly": [...], "readWrite": [...] }` is the explicit way to drop baseline directories for one session. Naming both `readOnly` and `replace.readOnly` is an error. The replacement must still stay inside the ceiling.
- `cwd` pins the expected workspace: a session whose working directory resolves elsewhere refuses to start. `noHostCommands: true` drops `hostCommands` for this session, which is how delegated children are stopped from delegating again; combine it with `hostCommands` to keep only the named commands. Both only tighten a session.
- `networkMode` selects the startup mode and `maxNetworkMode` sets the ceiling for the run. `{"networkMode":"off","maxNetworkMode":"http-get"}` therefore starts with network off while allowing tools to reach `http-get`. A ceiling that contradicts the startup mode is either rejected (`networkMode` above `maxNetworkMode` in the same request) or clamps the start (`maxNetworkMode` alone below the configured default). Either value may not exceed the configured `maxNetworkMode` unless the user approves the request, and an approved request becomes the session ceiling.
- `maxReadOnly` and `maxReadWrite` from the configuration extend the path ceiling only. A request naming one of those paths is inside the ceiling and starts without a dialog. The fields themselves are configuration-only and are rejected in `--hiraishi-grants`.

Requests beyond the ceiling ask the user in interactive sessions (allow requested / start with baseline / refuse). Starting with the baseline drops the request's additions but keeps every restriction it asked for: added `denyRead`, `noHostCommands`, `hostCommands` narrowing, `replace` narrowing and a lower ceiling still apply. Without an interactive UI a refused or malformed request ends the process: the reason goes to stderr and no session starts. Other startup failures leave the session running with tools unavailable, as before.

Grant paths are canonicalized when loaded and merged, and every policy rebuild re-checks that each granted path still resolves to itself. Moving a symlink over an approved path therefore fails the next sandbox start instead of widening it. The resolved permissions become the session ceiling for `/hiraishi-network` and for subagent and host-command grants.

## Host commands

Some work needs a host program the sandbox cannot reach, such as a terminal multiplexer's control client that talks over a Unix socket. `hostCommands` declares those programs explicitly; nothing runs without an entry:

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

`hiraishi_host` exposes these operations to the model. It cannot choose the binary, add flags or use a shell; it supplies typed values for placeholders only, and each placeholder must fill a whole argv entry. `{hiraishi}` expands to the running extension path. `{cwd}` must be an existing directory. The session workspace and write grants are allowed directly, and a directory inside the configured `maxReadWrite` ceiling is allowed without asking; any other directory asks the user in interactive sessions, showing the command, operation, resolved `cwd`, the child `{grants}` JSON and the start of `{task}` with control characters neutralized. Without an interactive UI the request is refused. A child workspace is writable, so a read-only path that is not also in the write ceiling cannot be one. `{task}` may not begin with `-` or `@`, which the started program could read as an option or a file argument.

A command entry may also list `env`, an allowlist of variable names to pass from the host `pi` process to that command in addition to the fixed environment (`HOME`, `PATH`, `TERM`, locale, XDG and D-Bus entries). Names must match `[A-Za-z_][A-Za-z0-9_]*` and are checked when the configuration loads. A variable is copied only when the host process has it. `env` is configuration-only and is rejected in `--hiraishi-grants`, unlike `hostCommands`, which can only narrow the configured set. Hiraishi adds no tool-specific variables, so a program that needs an inherited variable, such as a terminal control client's caller identity, must have it named here. For example, a command entry can add `"env": ["CONTROL_SOCKET", "SERVICE_TOKEN"]`. Passed values become ordinary process environment for the declared command: a token or a socket path gives that command the authority that goes with it. Declare only trusted programs and pass only the names they need.

A command entry may set `"delegable": true` when a delegated child should keep it. The default is false, `delegable` cannot be combined with `starts`, and a delegable command's operations cannot use `{hiraishi}` or `{grants}`. `hiraishi_host` passes only the delegable commands that the parent session still has to a child, together with `noHostCommands: true`; the caller cannot add names through `{grants}`. A retained command runs with the child's permissions, so mark only fixed commands you are confident are safe to delegate, such as a dedicated sandbox test wrapper.

`{grants}` is mandatory on the operation named by `starts` and on any operation that mentions `{hiraishi}`, so a launched child can never fall back to its own configuration. An operation that starts the host `pi` without `{hiraishi}` runs it outside Hiraishi; add both placeholders in that case. The bridge always rewrites the child grants: it intersects the requested paths with the configuration baseline, restores the baseline entries that this session still allows as an exact `replace` set, caps `networkMode` and `maxNetworkMode` at the session ceiling, unions the session `denyRead`, pins the expected workspace as `cwd` so the child can verify it did not move, and sets `noHostCommands` plus only the delegable commands, never a command with `starts`, so a delegated child cannot delegate again. A delegated child never receives `maxReadOnly` or `maxReadWrite`: its path ceiling is exactly the grants this session passes. A requested path that the configuration cannot hold is refused rather than silently dropped. Operations that take `{name}` reach only children started by the same command in the same session; sessions and cancellations reset that list and abort a running host call. Cancellation stops the direct host process only: a child that the host program started in the background keeps running, and after the reset this session can no longer control it.

`{grants}` in `hiraishi_host` cannot select `hostCommands`; only commands marked `delegable` are passed to a child automatically. `{cwd}` is also the child workspace and its default read/write root, so a subdirectory narrows the child without a separate `workspace` field. `denyRead` entries in `{grants}` are unioned with the session and configuration denies and can hide paths inside that workspace; missing paths are accepted. Configured baseline read/write grants that this session still allows are passed as the exact `replace` set, so `{cwd}` narrows the default root but does not remove those baseline grants. Use `denyRead` when a specific path inside the workspace must stay hidden. The same path-based limitations apply: hard links, bind mounts and other aliases are not separated by this boundary, and hiding a dependency makes the child's reads fail. A write outside `{cwd}` can be absorbed by the same read-deny temporary directory: it may appear successful but is discarded, so have the child place deliverables under `{cwd}`.

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

`read`, `write`, `edit`, `bash` and `!` / `!!` commands share the sandbox. Unadapted custom tools are refused. `hiraishi_host` runs only the operations declared under `hostCommands` (see above).

`hiraishi_subagent` starts a separate sandbox with network off and workspace access only, regardless of the parent's network mode or configured grants. System runtimes and dedicated HOME/temp directories remain available, and configured `denyRead` rules remain enforced. Its default `review` mode allows reads and fixed Git diff/status commands; `work` also allows writes, edits and bash. It cannot delegate recursively or change its own permissions.

Each invocation can be narrowed further. `permissions.denyRead` adds files or directories that this child cannot read; entries are unioned with the session and configuration `denyRead` and can never remove them. Missing paths are accepted, like configured denies. `permissions.workspace` sets the child's working directory and default read/write root to an existing directory inside the parent working directory; relative paths, shell commands and Git commands start there. A workspace outside the parent, a missing path, or a symlink that resolves outside is refused. Both options only narrow this child, so they need no approval and do not change the parent or later children. Hiding a file that the child needs makes its reads fail; the child is instructed to report the limitation instead of probing other paths. If the workspace names only part of a repository, the child cannot read the repository root's `.git`, so `review` mode cannot use `git_diff` or `git_status`; use `read` to inspect individual files instead.

These controls are path-based. A hard link, bind mount or other alias can make the same data reachable through an allowed path, so `workspace` and `denyRead` are not a complete data boundary. The workspace itself is canonicalized and SRT resolves symlinks, but a shared inode or writable alias can still cross the apparent directory boundary. On Linux, a write outside the workspace can land in the temporary writable directory that hides read-denied paths instead of failing. The command may exit successfully, but the bytes never reach the host and are discarded. Put deliverables inside the workspace and verify them from the parent when persistence matters.

The parent can explicitly grant `permissions.networkMode`, `permissions.readOnly` and `permissions.readWrite` for one invocation, with a `reason`. The parent is instructed to approve only grants covered by existing user authorization. Network grants may reach the session ceiling; directory grants must stay inside the session path ceiling, which includes the configured grants and `maxReadOnly` / `maxReadWrite`, so a child cannot receive a path the session itself could not request. Grants beyond the ceiling fail closed unless `permissions.approval` is `"user"`: a dialog then offers cancellation, default permissions or the requested permissions, listing the ceiling violations. Parent judgment is model guidance; the selected sandbox permissions are enforced by SRT. Grants are discarded when the child finishes, and do not change the parent or later children. A blocked child returns the operation and reason so the parent can assess permissions and retry.

Use `model: { "provider": "...", "id": "..." }` to choose any chat model registered with pi, including another provider. Omit `model` to use the parent's model. Hiraishi adds no model allowlist. Pi resolves provider authentication on the host; credentials are not forwarded to the sandbox. Unknown models and provider failures stop execution without switching to another model.

Example tool arguments (replace the provider and ID with a registered model):

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

Files are limited to 32 MiB. Shell commands default to 120 seconds, with explicit timeouts up to one hour. Commands and descendants stop at completion or cancellation; persistent background servers are unsupported.

Pi and installed extensions remain trusted host code. See [SECURITY.md](SECURITY.md) for the full boundary and limitations.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

Set `HIRAISHI_REQUIRE_SANDBOX=1` to fail when sandbox prerequisites are missing. `HIRAISHI_TEST_SOCAT=/absolute/path/to/socat` selects a test-only binary.
