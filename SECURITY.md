# Security boundary

Hiraishi trusts pi, selected extensions, its own host-side controller and Anthropic Sandbox Runtime 0.0.81. It confines read/write/edit/bash, their descendants and user shell commands on Linux. Other extension internals, resource discovery, model/provider access and `pi.exec` remain trusted host operations. A malicious same-process extension is outside the boundary. Do not install the runtime or configuration under a writable grant.

SRT is the only OS/network isolation backend. There is no classifier, confidence threshold, command allowlist or automatically approved escalation. Invalid settings, missing dependencies, startup errors and unsupported platforms leave the guarded tools unavailable. They never restore pi's local operations.

## Files and environment

A root read deny re-exposes system runtimes, SRT's native helpers, explicit read grants, the workspace and dedicated temporary/HOME directories. Only SRT's own proxy endpoints and public CA/trust files are re-exposed as required by its implementation. Its private CA key remains hidden. Write access is limited to the workspace and configured grants. User grants cannot overlap private SRT session state. HOME and its ancestors cannot be read roots; pi state directories cannot be whole read roots or overlap write roots, including a custom active agent directory. The host's shared `/tmp/claude` convenience directory is explicitly denied as well as the general shared `/tmp` contents.

Host credentials and shell startup variables are not inherited by the runner. It starts with a small environment; sandbox commands receive a fresh HOME and TMPDIR. Runtime lookup excludes writable PATH directories. Known credential locations and pi auth/models files and session histories are denied, but allowed projects, references and caches can contain other secrets. There is no content-based secret filter. Reads may be forwarded to the selected model provider; tools may transmit allowed files over permitted HTTP requests.

Mounted write grants modify host data. They do not create snapshots, protect uncommitted work within those grants, or make Git tracking equivalent to recovery. Use a separate copy if losing workspace files is unacceptable. Existing hard links and other shared writable aliases can also connect files across apparent paths; grant only directories whose contents may be modified. Kernel vulnerabilities and malicious host processes with the same uid are outside this boundary.

## Network

The tool network namespace has no direct external connection. SRT's authenticated relay proxies mediate HTTP and HTTPS. SRT's own local relay sockets are usable by its pre-seccomp infrastructure, while workloads cannot create arbitrary Unix/vsock sockets. `refuseOpaqueTunnels`, TLS termination, host consistency checks and a per-request method filter are enabled together. TLS exclusions, upstream proxies and weakened SRT isolation are not exposed as user options.

Domain permission uses SRT's callback, deterministically derived from the session mode; it never opens a per-domain approval prompt. Literal IPs and localhost names are refused by this callback because SRT's DNS guard intentionally exempts those cases. Remaining hostnames use SRT's single-resolution address guard with explicit private/non-public ranges. This is not an assertion that every network deployment (for example a public address routing into private infrastructure) is distinguishable as private.

`off`, `http-get` and `http-all` describe HTTP capabilities, not user intent. GET and HEAD can disclose data in URLs or trigger mutations. All-method mode permits uploads and anonymous remote updates. A model error within those permissions can have external effects. No host service credential is automatically made available. Authenticated publication/deployment requires a separate explicit design or human execution.

## Sessions and teardown

Each active session owns one separate runner process and SRT instance. Permission transitions stop new admissions synchronously, invalidate the generation, reject pending calls and terminate tracked tool process groups. The old runner shuts down SRT before a replacement starts. Runner exit also triggers host-side termination of known tool groups and relay processes. Shutdown interrupts startup and permission changes, and concurrent stops share completion. Extension lifecycle changes clear the active reference before awaiting teardown; new starts wait for cleanup. Cleanup failure blocks replacement; fatal errors trigger teardown. There is no replay queue.

Each tool's operations capture their starting generation. An edit that read under an old generation cannot write after a permission transition. Shutdown or mode changes cannot retract bytes already sent or roll back completed mutations. Commands and their descendants are terminated when a tool finishes; persistent background tasks are unsupported. There are time and per-file limits but no CPU, memory or disk quotas.

Filesystem permission semantics and TLS termination are SRT functionality and must be rechecked on upgrades. The exact dependency is pinned. Integration tests verify boundaries and failure behavior with synthetic local files and services; they are not a proof against all OS/runtime vulnerabilities.

## Dependency advisories

The 2026-11-02 `npm audit` check reports five affected packages (three high, two moderate), including SRT through zod and the pi peer through undici/minimatch. npm supplies no compatible automatic fix. Hiraishi bounds its own configuration collections and accepts them only from trusted personal settings, but this does not establish that every upstream advisory is unreachable. The pi provider/network stack remains trusted host code. Track upstream fixes and repeat this check when updating the pinned runtime or supported pi version.
