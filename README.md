# pi Hiraishi

Session-scoped filesystem and HTTP permissions for pi, enforced by [Anthropic Sandbox Runtime](https://github.com/anthropics/sandbox-runtime) (SRT). Ordinary reads, edits, builds and tests run without a classifier or per-operation approval. The human chooses the session's permissions.

## Requirements

Linux x86-64 or ARM64, Node.js 22.19 or later, pi 1.4.x, bubblewrap, socat and ripgrep. User namespaces must be available. SRT is pinned to **0.0.81**; its vendored seccomp helpers must be present and executable. Unsupported platforms, invalid settings and isolation failures refuse execution. There is no unconfined fallback.

Install OS prerequisites with your distribution's package manager (for example, `sudo apt install bubblewrap socat ripgrep` on Ubuntu). Ubuntu may also require its unprivileged user-namespace policy to permit bubblewrap; consult the SRT documentation.

## Install

```sh
pi install git:github.com/yoshitsugu/pi-hiraishi
```

Install Hiraishi outside every writable workspace. Its code, dependencies, Node executable and configuration must remain outside the sandbox's writable grants. To develop this repository, use a separate installed copy, not `pi -e ./hiraishi.ts` from this writable checkout.

## Configuration

Save personal settings to `~/.pi/agent/hiraishi/config.json` (or the corresponding custom pi agent directory). `HIRAISHI_CONFIG` can select another absolute file path. A missing file uses the defaults below. JSON comments are supported.

```json
{
  "networkMode": "off",
  "readOnly": [],
  "readWrite": [],
  "denyRead": []
}
```

The session working directory is readable and writable, including deletion. Hiraishi does not infer a Git root or create a backup. Related repositories, documentation, skills and toolchains can be added through `readOnly`; caches can be added through `readWrite`. All grants must name existing directories using literal absolute paths or `~/...`. Globs are rejected. HOME and its ancestors cannot be granted for reading or writing. System runtime directories cannot be writable roots. Grants must not overlap the session’s private SRT directory. The current and conventional pi agent directories cannot be granted as whole read roots or overlapped by write grants; grant a specific skills subdirectory instead.

`denyRead` accepts literal file or directory paths, including missing paths. Use it to exclude project-specific secrets such as `.env` files. Known SSH/AWS/GnuPG and netrc locations, pi auth/models files and session histories in the current and conventional agent directories, and Hiraishi's settings are denied by default. This is path protection, not content-based secret detection: an allowed project can contain other credentials.

Tools receive system runtimes, explicitly allowed paths, a fresh HOME and a session-private temporary directory. Host environment credentials and shell startup variables are not forwarded. Shared host `/tmp` contents are hidden. Node and SRT's runtime files remain read-only. Tools cannot use host Unix sockets such as Docker or SSH-agent sockets.

If socat is installed outside PATH, set `"socatPath": "/absolute/path/to/socat"`. The binary must remain outside writable grants. There is no setting to weaken SRT isolation or disable the boundary.

Settings are captured at session start. Changes to filesystem grants require a new session or `/reload`.

## Session network modes

Use the human command:

```text
/hiraishi-network
/hiraishi-network http-get
/hiraishi-network http-all
/hiraishi-network off
```

| Mode | Tools may use |
| --- | --- |
| `off` | No external network access. This is the default. |
| `http-get` | HTTP/HTTPS GET and HEAD to public DNS hostnames. |
| `http-all` | All HTTP methods to public DNS hostnames, including POST, PUT and DELETE. |

No per-domain approvals are required. Literal IP destinations, localhost, private/link-local and metadata addresses are refused. SSH, arbitrary TCP/UDP, external DNS connections, SOCKS, opaque CONNECT tunnels and WebSocket upgrades are not supported. Documents and dependencies that require these paths return an error; they do not acquire an exception automatically.

HTTPS is terminated by SRT and inspected with its request filter. Its ephemeral CA is trusted inside tools; the private key remains outside their readable paths. Certificate-pinning and mTLS clients may fail. TLS exclusions and upstream proxies are not supported in this version.

**GET-only does not prevent data disclosure or remote changes.** Data can be carried in a URL, and some services mutate state on GET. `http-all` also permits uploads and unauthenticated remote mutations. Choose a mode with those effects in mind. Network permission does not forward host credentials. The host-side model/provider connection is separate and remains available in `off` mode; readable material may be sent to that provider.

On a network refusal, the model is instructed to pause affected work when fresh information is needed or network access would improve efficiency. It should explain the missing information and offer a choice between continuing offline with explicit limitations and enabling the minimum required session network mode, then wait for the user. This guidance is included in refusal messages and the bash/subagent instructions. The runner also reports detected domain/method refusals separately so bash output can include the guidance even when clients hide the proxy’s response body. With concurrent commands, this indicates a refusal while the command was running; it does not identify which command caused it. It is model guidance; the sandbox itself enforces permissions. A mode change cannot allow destinations or protocols blocked in every mode.

Changing the mode stops running tools and downloads, closes the old runner and connections, and initializes a new runner. Calls during the transition are rejected for explicit retry, never queued or automatically replayed. Changes are serialized; stale requests/results cannot cross the runner generation. Already-completed external effects cannot be undone.

A session switch, resume, fork, tree navigation or reload resets the mode to the configured default. One pi process has at most one active Hiraishi session. Shutdown takes priority over startup and mode changes. A new session waits for old cleanup to finish; failed cleanup blocks startup. If another extension cancels navigation after the before-event, tools remain unavailable until a new session or reload. An interrupted transition fails closed; reload after resolving the reported error.

## Tools and delegation

`read`, `write`, `edit`, `bash` and the user's `!` / `!!` commands all use the same session runner. Unadapted custom model tools are refused. A tool replacement is not trusted merely because it uses the same name.

`hiraishi_subagent` uses the parent's selected model and guarded tools. Its default `review` mode exposes file reads and fixed Git diff/status operations; `work` exposes the basic tools. It shares the parent's runner and network permissions, cannot delegate recursively, and cannot approve a network change. It creates no child credential or session files. Its bounded independent conversation receives only the supplied task and its own results.

File operations are limited to 32 MiB per file. Shell commands default to 120 seconds; an explicit timeout is limited to one hour. Commands, their child processes and their connections are stopped at completion or cancellation; persistent background servers are not supported.

## Protect existing work

Writes and deletion inside the chosen workspace affect its host files. For valuable uncommitted work, prepare an independent working copy and review the diff before manually applying it back. A Git worktree shares Git metadata and is not an isolation mechanism. Automatic copying and synchronization are outside this version.

Pi itself and installed extensions run as trusted host code. This extension confines its adapted tools, not arbitrary extension internals or `pi.exec`. Only enable extensions you trust. See [SECURITY.md](SECURITY.md) for exact boundaries and limitations.

## Migration from 0.1

This is a breaking replacement of the Jev intent classifier. Replace the old configuration with the new schema. Legacy classifier, confidence, allowlist and reviewed-script settings are rejected instead of silently ignored. `hiraishi_review`, the classifier evaluation command and semantic approval reuse have been removed. No Jev endpoint or classifier credential is needed.

## Development checks

```sh
npm install --ignore-scripts
npm run typecheck
npm test
```

Sandbox integration tests require working bubblewrap and socat. Set `HIRAISHI_REQUIRE_SANDBOX=1` to make missing prerequisites an error (CI does this). `HIRAISHI_TEST_SOCAT=/absolute/path/to/socat` selects a test-only binary without modifying the installed configuration. Tests use synthetic fixtures, not host credentials.
