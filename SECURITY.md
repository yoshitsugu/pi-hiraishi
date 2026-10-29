# Security limitations

Hiraishi checks operations before they run to reduce unintended side effects.
It does not fully analyze arbitrary code. A default Linux bubblewrap boundary confines registered file/shell tools and user shell commands; it does not isolate the Pi host process or trusted extension code.

## Trusted inputs

User input paths, pi itself, configuration files, allowed endpoints and local programs are trusted.
Anyone who can change the configuration or the allowlist can change the endpoint and the approval policy.
If another extension in the same process forges event arguments or user records, that cannot be defended against.
Clients that use RPC must also be authenticated.

## Data sent to the external model

The request sends the required user instructions, the working directory, the operation, its targets, hints about side effects and the fact that recoverability is unverified. Configured `additionalInstructions` are sent as trusted policy preferences in both classification questions.
File bodies, script excerpts, and literal arguments extracted from script source are never part of the decision input. Script inspection supplies only finding counts and fixed risk categories.
Operations that touch credential material are confirmed locally instead, so neither the instruction nor the operation reaches the classifier for them.
Possible sensitive data is handled by a local confirmation instead.
Email addresses are ordinary metadata rather than credentials by themselves. Before native or HTTP classification, email addresses in the complete context (instructions, operation, preferences and approval history) are replaced with process-keyed opaque aliases. Equal addresses have equal aliases and distinct addresses stay distinct; no address lookup is transmitted. Original operation arguments, local approval history and human-facing explanations retain their local values. This does not authorize communication, impersonation or other external writes, and it does not recognize every form of personal information. Resolved classifier credentials are checked against the original, unredacted context, so an email-shaped credential cannot be hidden from that check by redaction.
Format detection has blind spots and cannot find every unknown secret value or personal data.
Length alone is not treated as evidence of a secret: long paths, identifiers and ordinary text remain usable. Known credential formats, labeled secret values, sensitive paths and configured credential values still trigger local checks.
For sensitive work, review the outgoing request before it is sent.
Local session diagnostics record decisions, fixed reason labels, their source and latency; they contain no tool arguments or instruction text. They are not sent as telemetry.
Instructions inside the model input are separated and the response is validated, but prompt injection and model errors remain possible.
An explanation written by the execution model can also be wrong.
Additional instructions are model guidance, not a deterministic policy engine. They do not authorize individual operations or override local sensitive-data checks, script review or the confidence threshold. Explicitly allowlisted commands bypass classification and personal prompt preferences.
Verified built-in reads of existing AGENTS.md and SKILL.md files are also preapproved locally after sensitive-data checks, without sending instructions or operations to the classifier. Both the requested and resolved filenames must name these instruction files. This default bypasses classifier-based restrictions, including natural-language prohibitions and personal preferences, as command allowlisting does. It permits reading the file, not executing or trusting its embedded instructions as user authorization.
Ordinary reads, local edits, builds and tests default to ALLOW unless there is concrete consequential risk, a privacy concern or an explicit restriction. Uncertain relevance alone does not require confirmation. They still use classification; an unavailable classifier or missing trusted instructions requires confirmation. Saving code with execution, deletion or network logic is treated as a file modification, not execution of that logic.

The classifier receives local `git check-ignore` results for recognized literal path candidates, without exclude patterns or file contents. Git is invoked without a shell, with filesystem monitoring disabled and a one-second timeout. Failures and symlink traversal leave status unknown. Ignore results are a snapshot of individual paths, not proof that all descendants are ignored, that command scope is limited to those paths, or that data is recoverable. Ignored status does not bypass sensitive-data checks or automatically approve an operation.

Recognized scripts are inspected locally. Writes, deletion, network and nested execution are classification evidence rather than automatic confirmation triggers. Sensitive source and inspection failures always require local confirmation. Scripts are classified using counts of findings, fixed categories for recognized consequential operations, hashes and resolved paths, without source text, literal arguments or write/upload payloads. Their hash and resolved path are checked after classification; changed scripts cannot reuse an old script approval but may receive a fresh contextual ALLOW. These heuristics are not a parser or a safety proof: obfuscated code, dynamic targets, working-directory changes, symlinks and imported modules can have undetected effects. A classifier ALLOW may let scripts with side effects run without human review. The filesystem sandbox does not prevent remote service mutations, so model errors about network authorization remain consequential.

Verified user instructions retain surrounding text when known credential values, labeled secrets, private-key blocks or URL userinfo are redacted locally. Redaction does not grant authority to use hidden values. Ambiguous short/common credential values are not replaced. If redaction cannot safely retain the instruction, its provenance is unverified, or the complete instruction history exceeds the size/count limits, confirmation remains necessary. Earlier restrictions are never silently dropped to fit. Already-withheld legacy entries remain unavailable. Unknown secret formats can escape redaction, as with the existing sensitive-data checks.

The local layer does not infer authorization from instruction keywords. Revocation and the relationship between the requested goal and an operation are evaluated by the classifier. The classifier compares the same meaning across languages only as well as the model itself allows, so its DENY answer can still be wrong in one language and right in another.

## Approval and state checks

Each confirmation and its immediate execution grant are bound to the original operation and arguments and can be used once. Non-sensitive human approval summaries may also authorize later operations when the classifier judges them to have equivalent or lower risk. This session-only history expires after `approvalTtlMs` (default one hour); equivalence refreshes the matched entry's timestamp without changing its original scope. Expired entries are omitted, and history is bounded to 16 entries and 12,000 serialized UTF-8 bytes. Model judgments can be wrong: different arguments may be accepted, remote state and imported modules are not pinned, and repeated equivalent use can keep an approval active beyond one hour from the original confirmation. Set `approvalTtlMs` to `0` to disable reuse. Sensitive operations and unavailable script source remain local-confirmation paths, and isolated approval is not reused for normal execution.
An assistant explanation never substitutes for human approval.
Write, edit, identifiable simple bash local targets and recognized scripts are compared before and after the confirmation.
Compound shells, redirects, variable expansion, targets decided inside configuration or program logic, and the targets of descendant symlinks are not fully pinned.
Remote state is not pinned at all.
State comparison and execution are not atomic, so a race between the final comparison and the execution remains.

## Not observed

Operations that do not pass through `tool_call` cannot be observed.
That includes the user's `!` / `!!`, processes started inside extensions, communication, file operations and existing background jobs. User shell commands are confined by the filesystem sandbox but do not pass Hiraishi intent classification.
Steps inside a tool stay invisible unless they are exposed as a new tool call.
Nested `tool_call` events raised by `ctx.executeTool()` are observed.

## Subagent delegation

`hiraishi_subagent` is a verified host-side adapter, not an exemption for arbitrary custom tools. Its fresh model conversation uses the parent's model registry, so provider credentials remain in trusted host code. It creates no child auth/config/session files and does not expose parent credentials or extra host paths to filesystem tools. The parent model provider receives the delegated task and the child's text tool results, as it would receive ordinary tool results; this is not a new content-based secret filter.

Review mode exposes only file reads and fixed Git inspection, with external diff/textconv helpers and filesystem monitoring disabled. Work mode exposes only the parent's guarded read/write/edit/bash tools. Every actual operation uses `ctx.executeTool()`, retaining the original trusted user instructions, permission hooks and filesystem boundary. Delegated task text and child output never become trusted user instructions or human approvals. Child review/recursive delegation/custom tools are unavailable, and a blocked operation returns to the parent instead of opening a child approval UI. The adapter's identity is checked both before classification and at execution; replacement tools are refused.

Runs have time, turn, tool-call and context/output limits. Cancellation is forwarded to model requests and nested tools, but an already-completed write or remote operation cannot be undone. Parent instruction/session/configuration changes are checked before subsequent operations and after asynchronous calls; ordinary same-process race limitations still apply. Delegation does not make the classifier a deterministic authorization engine or restrict network side effects beyond the existing policy. Parent credentials, the provider runtime and trusted extensions remain outside the filesystem boundary.

## Default filesystem boundary

The filesystem sandbox is enabled unless trusted configuration explicitly sets `filesystemSandbox.enabled:false`. It replaces read/write/edit/bash with verified SDK adapters backed by bubblewrap, and blocks unadapted model-callable tools. Deferred approvals re-enter the same guarded tools. Tool names alone never establish adapter identity. Invalid settings do not restore native implementations.

The Linux backend uses mount, user, PID, IPC and UTS namespaces, drops capabilities, disables further user namespaces, avoids shell startup files and filters the execution environment. Mount sources are identity-checked, opened without following a final symlink, and passed as file descriptors. A changed source causes refusal, not automatic permission expansion. The extension captures sandbox configuration at load, so approval reuse and later soft-policy config edits cannot expand the active OS boundary. Bubblewrap failure has no unconfined fallback.

The project and **the real shared host `/tmp` are writable**, including deletion. This permits damage to allowed project files and other same-user temporary data. Network remains enabled, including localhost services. There are no CPU, memory, PID-count or disk quotas. Environment credentials are omitted, and known Pi auth files are masked, but other secrets inside readable projects, Pi settings, skills or temporary files may still be read. It is not a content-based secret filter or an external-service authorization boundary. Existing hard links or shared writable aliases can also connect assets that appear at different paths; only grant directories whose contents you intend tools to access.

Pi itself, extension initialization/hooks, `pi.exec`, classifier/inspection host reads, and the Node SDK run outside the boundary. Extensions are trusted and can perform host operations without going through these tools. Another extension can also change event handling; this is not a defense against malicious code inside the same process. Provider access and initial resource/skill discovery happen in the host process. A separate user/container around Pi is needed to confine those paths too.

Read-only runtime/configuration mounts also anchor writable ancestors to prevent replacing protected host paths by renaming a parent. Sandbox configuration must reside outside writable roots. Policy paths and grants must be managed by the human. Kernel vulnerabilities, all namespace edge cases, and arbitrary existing hard-link layouts are not covered by the integration tests. See README for exact allowed locations and operational restrictions.

## Configured isolation executor

Script isolation is opt-in and requires human approval. Hiraishi delegates it to the command in the trusted `sandbox` configuration; it does not provide an isolation mechanism itself.
The executor must enforce filesystem access, network restrictions, environment filtering, resource limits and runtime dependencies for the target project.
The executor inherits the host environment. Only a trusted executor should receive the reviewed source and launch code.
Hiraishi checks the reviewed script hash and resolved path before handing its source to the executor. The executor must run that source rather than reopen a mutable host file.
Loaded modules, project files and remote state are not snapshotted by Hiraishi.
An executor timeout kills the executor process, not necessarily its descendants, containers or remote jobs. Their limits and cleanup belong to the execution environment.
Executor startup failure, timeout or a nonzero exit never falls back to a normal run.
Tests cover the executor protocol and failure handling; they do not establish that a configured environment provides isolation.
