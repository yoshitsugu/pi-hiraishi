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

The JSON accepts `networkMode`, `readOnly`, `readWrite`, `denyRead` and an optional `replace` object with the same path rules as the config file; `socatPath` and `hostCommands` are rejected.

- `readOnly`, `readWrite` and `denyRead` are additive: they are unioned with the config file, so a caller that omits or shortens a list never removes the always-allowed entries. `denyRead` can only grow.
- `replace: { "readOnly": [...], "readWrite": [...] }` is the explicit way to drop baseline directories for one session. Naming both `readOnly` and `replace.readOnly` is an error. The replacement must still stay inside the ceiling.
- `cwd` pins the expected workspace: a session whose working directory resolves elsewhere refuses to start. `noHostCommands: true` drops `hostCommands` for this session, which is how delegated children are stopped from delegating again. Both only tighten a session.
- `networkMode` selects the startup mode and `maxNetworkMode` sets the ceiling for the run. `{"networkMode":"off","maxNetworkMode":"http-get"}` therefore starts with network off while allowing tools to reach `http-get`. A ceiling that contradicts the startup mode is either rejected (`networkMode` above `maxNetworkMode` in the same request) or clamps the start (`maxNetworkMode` alone below the configured default). Either value may not exceed the configured `maxNetworkMode` unless the user approves the request, and an approved request becomes the session ceiling.
- `maxReadOnly` and `maxReadWrite` from the configuration extend the path ceiling only. A request naming one of those paths is inside the ceiling and starts without a dialog. The fields themselves are configuration-only and are rejected in `--hiraishi-grants`.

Requests beyond the ceiling ask the user in interactive sessions (allow requested / start with baseline / refuse). Starting with the baseline drops the request's additions but keeps every restriction it asked for: added `denyRead`, `noHostCommands`, `replace` narrowing and a lower ceiling still apply. Without an interactive UI a refused or malformed request ends the process: the reason goes to stderr and no session starts. Other startup failures leave the session running with tools unavailable, as before.

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

`{grants}` is mandatory on the operation named by `starts` and on any operation that mentions `{hiraishi}`, so a launched child can never fall back to its own configuration. An operation that starts the host `pi` without `{hiraishi}` runs it outside Hiraishi; add both placeholders in that case. The bridge always rewrites the child grants: it intersects the requested paths with the configuration baseline, restores the baseline entries that this session still allows as an exact `replace` set, caps `networkMode` and `maxNetworkMode` at the session ceiling, unions the session `denyRead`, pins the expected workspace as `cwd` so the child can verify it did not move, and sets `noHostCommands` so a delegated child cannot delegate again. A delegated child never receives `maxReadOnly` or `maxReadWrite`: its path ceiling is exactly the grants this session passes. A requested path that the configuration cannot hold is refused rather than silently dropped. Operations that take `{name}` reach only children started by the same command in the same session; sessions and cancellations reset that list and abort a running host call. Cancellation stops the direct host process only: a child that the host program started in the background keeps running, and after the reset this session can no longer control it.

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
