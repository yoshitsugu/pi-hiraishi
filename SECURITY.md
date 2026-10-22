# Security limitations

Hiraishi checks operations before they run to reduce unintended side effects.
It does not fully analyze arbitrary code and does not isolate pi itself.

## Trusted inputs

User input paths, pi itself, configuration files, allowed endpoints and local programs are trusted.
Anyone who can change the configuration or the allowlist can change the endpoint and the approval policy.
If another extension in the same process forges event arguments or user records, that cannot be defended against.
Clients that use RPC must also be authenticated.

## Data sent to the external model

The request sends the required user instructions, the working directory, the operation, its targets, hints about side effects and the fact that recoverability is unverified. Configured `additionalInstructions` are sent as trusted policy preferences in both classification questions.
File bodies and existing file contents are never part of the decision input.
Operations that touch credential material are confirmed locally instead, so neither the instruction nor the operation reaches the classifier for them.
Possible sensitive data is handled by a local confirmation instead.
Format detection has blind spots and cannot find every unknown secret value or personal data.
For sensitive work, review the outgoing request before it is sent.
No telemetry is added.
Instructions inside the model input are separated and the response is validated, but prompt injection and model errors remain possible.
An explanation written by the execution model can also be wrong.
Additional instructions are model guidance, not a deterministic policy engine. They do not authorize individual operations or override local sensitive-data checks, script review or the confidence threshold. Explicitly allowlisted commands bypass classification and personal prompt preferences.
Ordinary reads, local edits, builds and tests default to ALLOW unless there is concrete consequential risk, a privacy concern or an explicit restriction. Uncertain relevance alone does not require confirmation. They still use classification; an unavailable classifier or missing trusted instructions requires confirmation. Saving code with execution, deletion or network logic is treated as a file modification, not execution of that logic.

Recognized scripts are inspected locally. Possible writes, deletion, network or nested execution, sensitive source, and inspection failures require confirmation. Other inspected scripts are classified using counts of findings, without source or excerpts. Their hash and resolved path are checked after classification. These heuristics are not a parser or a safety proof: obfuscated code, dynamic behavior and imported modules can have undetected effects. Imports and source omission alone do not trigger confirmation, so a classifier ALLOW may let such scripts run without human review.

The local layer does not infer authorization from instruction keywords. Revocation and the relationship between the requested goal and an operation are evaluated by the classifier. The classifier compares the same meaning across languages only as well as the model itself allows, so its DENY answer can still be wrong in one language and right in another.

## Approval and state checks

Approval is bound to the original operation and its arguments and can be used once.
An assistant explanation never substitutes for human approval.
Write, edit, identifiable simple bash local targets and recognized scripts are compared before and after the confirmation.
Compound shells, redirects, variable expansion, targets decided inside configuration or program logic, and the targets of descendant symlinks are not fully pinned.
Remote state is not pinned at all.
State comparison and execution are not atomic, so a race between the final comparison and the execution remains.

## Not observed

Operations that do not pass through `tool_call` cannot be observed.
That includes the user's `!` / `!!`, processes started inside extensions, communication, file operations and existing background jobs.
Steps inside a tool stay invisible unless they are exposed as a new tool call.
Nested `tool_call` events raised by `ctx.executeTool()` are observed.

## Configured isolation executor

Script isolation is opt-in and requires human approval. Hiraishi delegates it to the command in the trusted `sandbox` configuration; it does not provide an isolation mechanism itself.
The executor must enforce filesystem access, network restrictions, environment filtering, resource limits and runtime dependencies for the target project.
The executor inherits the host environment. Only a trusted executor should receive the reviewed source and launch code.
Hiraishi checks the reviewed script hash and resolved path before handing its source to the executor. The executor must run that source rather than reopen a mutable host file.
Loaded modules, project files and remote state are not snapshotted by Hiraishi.
An executor timeout kills the executor process, not necessarily its descendants, containers or remote jobs. Their limits and cleanup belong to the execution environment.
Executor startup failure, timeout or a nonzero exit never falls back to a normal run.
Tests cover the executor protocol and failure handling; they do not establish that a configured environment provides isolation.
