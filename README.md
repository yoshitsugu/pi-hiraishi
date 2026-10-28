# pi Hiraishi

A pi extension that checks tool calls against your instructions before they run. It aims to keep routine work moving while asking about unintended, consequential changes.

## Requirements

pi 1.3.x, Node.js 22.19 or later, and Linux with bubblewrap. The default filesystem sandbox requires `--bind-fd`, `--ro-bind-fd` and `--disable-userns` support; tested with bubblewrap 0.13.1. Missing or unsupported isolation blocks execution. macOS and Windows have no filesystem backend. Optional script isolation additionally uses an executor you configure for the target project.

## Install

```sh
pi install git:github.com/yoshitsugu/pi-hiraishi
```

From a local checkout, use `pi install .` instead. To try it without registering a package, run `pi -e ./hiraishi.ts`.

## Configure

Use a trusted **Jev-compatible System One classification API**. A chat-completions endpoint alone is not sufficient.

Create your settings directory:

```sh
mkdir -p ~/.pi/agent/hiraishi
```

Save the following as `~/.pi/agent/hiraishi/config.json` with your endpoint and model:

```json
{
  "endpoint": "https://classifier.example.invalid/v1/systemone",
  "model": "your-classifier-model",
  "apiKeyEnv": "HIRAISHI_API_KEY",
  "minAllowConfidence": 0.7,
  "timeoutMs": 5000
}
```

Replace the example URL and model. Make your API key available in the named environment variable before starting pi; keep it out of configuration files and Git. For a server that needs no authentication, add `"auth": "none"`.

The configuration and the allowlist accept `//` and `/* */` comments, so optional keys can stay in the file as a commented line. See `config.sample.json`.

The interface language is English or Japanese. Add `"locale": "ja"` or `"locale": "en"` to the configuration; without it the locale follows `LC_ALL`, `LC_MESSAGES` or `LANG`. The language never changes what is decided, only how the confirmation is written.

The default `minAllowConfidence` is `0.7`. An explicit value in your personal config takes precedence; change an existing `0.8` to `0.7` to use the new threshold.

Restart pi or run `/reload`, then send your next instruction. Personal settings are separate from the installed package. `HIRAISHI_CONFIG` can point to another config file; a custom pi agent directory also changes the default settings location.

## Default filesystem sandbox

Hiraishi enables a Linux bubblewrap boundary by default. No new personal setting is needed. Restart pi or use `/reload` after updating the extension. This is separate from the optional reviewed-script executor named `sandbox`.

| Location | Default access inside tools |
|---|---|
| Session working directory | Read, write and delete |
| Host `/tmp` | Read, write and delete |
| Current Pi agent directory, `~/.pi/agent`, `~/.pi/agents`, `~/.pi/shared` | Read only, when present |
| `~/.agents/skills` | Read only, when present |
| System executables/libraries, required resolver/CA files, current Node binary directory | Read only |
| Other host paths | Hidden unless explicitly added |

The working directory is the project boundary; Hiraishi does not infer the Git root. HOME itself, its parents and system runtime trees cannot be writable project roots. Existing Pi authentication files are masked. Pi configuration, Hiraishi runtime files, bubblewrap/Node executables and existing project Git hooks/config are protected from tool writes, including through writable ancestor directories. Other project files, including `.env`, remain accessible: this initial boundary does not identify secrets inside allowed directories. `/tmp` is the real shared host directory, so other temporary files and sockets are accessible too.

Merge optional directory grants into your existing Hiraishi configuration:

```json
{
  "filesystemSandbox": {
    "enabled": true,
    "readOnly": ["~/src/shared-library", "~/toolchains/ruby"],
    "readWrite": ["~/.cache/my-project"]
  }
}
```

Entries must name existing directories using absolute paths or `~/...`; globs and relative paths are rejected. More specific mounts govern their subtrees; read-only wins for identical configured paths, and protected settings/runtime paths stay read-only. The normal `~/.pi/agent/hiraishi/config.json` is outside the writable project. A custom configuration must also stay outside all writable roots, including `/tmp`, even when reached through a symlink.

Sandbox settings are captured when the extension loads. Adding permissions or disabling the boundary requires a trusted configuration edit followed by restart or `/reload`. Hiraishi approval never widens these permissions. Changed directory identities or symlink targets require reload; mount sources are pinned and passed to bubblewrap as file descriptors to avoid path substitution at launch.

`read`, `write`, `edit` and `bash` all use the same OS boundary, including operations executed by `hiraishi_review` after approval. Hiraishi still treats these verified adapters as its own built-in operations for body omission, allowlisting and script inspection. `!` / `!!` also use confined shell operations, although they do not receive Hiraishi intent classification. An unadapted custom tool or another extension's replacement is refused while the boundary is enabled; use the guarded tools instead. Other extensions' internal code and `pi.exec` remain trusted host code and are outside this boundary.

Commands use a fresh environment with a filtered PATH, HOME, TMPDIR and fixed locale/terminal values; provider credentials, shell startup files, `BASH_ENV`, `NODE_OPTIONS` and other parent variables are not inherited. The shell is `/bin/bash --noprofile --norc`. Child processes share the filesystem, PID, IPC and UTS isolation. Mount-source descriptors are closed by bubblewrap before the command runs. Network access remains enabled for development; this feature does not restrict remote service writes or impose CPU/memory/disk quotas.

If a build needs another runtime, cache, Git worktree metadata directory or skill dependency, add the required directories explicitly. Loading a skill does not permit its scripts to exceed the boundary. Secrets needed by development commands require a separate explicit design; this version has no environment-variable forwarding option. File-tool operations have a 32 MiB per-file limit. Missing bubblewrap, invalid policy, initialization failure, timeout and cancellation never retry outside the boundary.

The trusted code files are read-only even when developing Hiraishi's own checkout; use a separate installed copy when editing those files with Pi. To deliberately run without this boundary, set `filesystemSandbox.enabled` to `false` in trusted configuration and reload; Hiraishi's soft policy still applies. This setting is not an approval fallback.

## Reusing human approvals

Hiraishi remembers human-approved operation summaries in memory for the current session. On subsequent classified operations, the model compares the proposed action with unexpired approvals and can ALLOW an operation with equivalent or lower risk. Arguments need not match exactly, but targets, destinations, scope, data exposure and side effects must remain within the approved risk. Later user prohibitions and revocations still apply. This is a model judgment, not a deterministic equivalence check; classifier failure or an uncertain answer requires confirmation.

Set `"approvalTtlMs": 3600000` in your personal config to control the lifetime in milliseconds; one hour is the default and `0` disables reuse. A confident ALLOW that names an equivalent approval updates only that entry's timestamp. The original operation summary stays unchanged and no new entry is added, so a chain of progressively broader operations is always compared with the original human approval. A normal classifier ALLOW without a matching approval does not create or refresh history.

Expired entries are removed before classification. History is limited to 16 entries and 12,000 serialized UTF-8 bytes per request; oversized summaries are not retained. Entries contain local operation summaries without file bodies or script source; email metadata is redacted when summaries are sent for classification. Session changes, forks, tree navigation, reloads and configuration changes clear the history. Ordinary new user messages keep history and are included in the next classification so that restrictions can override prior approval. No history is saved to disk.

Sensitive operations and unreadable or hidden scripts continue to require local confirmation and are not retained. A script with recognized side effects can use equivalence classification only when a human-approved script's hash and resolved path still match; changed source requires confirmation. Choosing configured isolation does not grant reusable permission to run the original script normally.

## Personal decision preferences

Add `additionalInstructions` to your personal `config.json` to refine the classifier's scope and confirmation preferences:

```json
{
  "additionalInstructions": "Ask before changing deployment settings or adding dependencies. Treat the sibling shared-library directory as relevant when investigating build failures."
}
```

Merge this field into your endpoint and model settings. It accepts up to 8000 characters and can be written in the language understood by your classifier. Empty or omitted text uses the default policy. The text is appended to both classification questions as trusted configuration, separately from the current and prior user instructions. It is sent to the configured classifier, so do not include credentials or private data. If sensitive text is detected, classification is skipped and local confirmation is required.

Preferences do not authorize a particular operation or remove the requirement for explicit authorization of external writes. They do not override local sensitive-data checks, script review, the allowlist, or the confidence threshold. An explicitly allowlisted command runs through the local approval path without the classifier or these extra instructions.

To express preferences for ignored temporary files, the classifier receives `operation.gitIgnore` entries with an absolute `path` and an `ignored` value: `true`, `false`, or `null` when unknown. Hiraishi runs local `git check-ignore` with a one-second timeout and sends only the results, without ignore patterns or file contents. Git applies repository and nested `.gitignore` files, `.git/info/exclude`, `core.excludesFile`, negations and the index; tracked files are not reported as ignored.

These facts cover built-in tool path arguments and up to 64 literal path candidates from simple shell commands, including `rm -rf tmp/file`. Compound commands and unquoted globs do not get ignore facts. Missing Git, Git errors, paths outside the working repository and symlink traversal leave status unknown. A missing entry is also unknown. Results are a snapshot, not automatic approval: an ignored directory does not establish the status of every descendant or the full effects of a command. Preferences such as allowing ordinary edits and deletion in ignored `tmp` paths can use these results; sensitive-data checks still apply.

## Allowlist

Optionally save commands you trust in `~/.pi/agent/hiraishi/allowlist.json`:

```json
{
  "commands": [["git", "diff"]]
}
```

Entries normally match the complete command and arguments. `git diff` also accepts supported display options and paths. Compound commands, pipes, and redirects still go through review.

Keep these personal files private. The repository contains only sample settings.

## How a decision is made

| Layer | Role |
|---|---|
| Local inspection | Detects credential material, network destinations, deletion, scripts and explicitly allowlisted commands. It does not infer user intent from keywords. |
| Classifier | Receives the current and prior trusted user instructions, working directory and operation details. Checks relevance, authorization, negation, quotation and revocation under the default policy and personal preferences. |
| Policy | Turns the facts and the classifier answer into ALLOW, ASK or DENY. |
| Confirmation | Shows the stored operation and asks the human to approve it. |

The classifier focuses confirmation on consequential risk rather than requiring proof that every step is necessary:

- Ordinary investigation, reads, searches, listings, local source edits, builds and tests default to ALLOW. Weak or uncertain relevance to the task alone does not require confirmation. Supporting work and related dependencies outside the working directory do not need instructions naming every file.
- Related, necessary local writes are ALLOW even with moderate impact when their scope is proportionate. This includes source edits, regenerating disposable reports, moving task-related files and bounded cleanup of obsolete build outputs. Deletion or overwrite alone is not high risk; high-impact, hard-to-reverse loss of valuable data requires confirmation.
- Explicit prohibitions, exclusions and revocations still apply to ordinary operations. Clearly unrelated reads require confirmation; broad investigation, uncertain relevance and related dependencies outside the working directory do not. Unrelated private personal documents also raise privacy concerns.
- Confirmation concentrates on sensitive access, unapproved external writes or publication, broad deletion, loss of existing work, history rewriting, production changes, permissions, system-wide changes and genuinely unknown consequential effects. Explicit authorization can cover consequential work within its stated scope; local sensitive-data checks remain in effect.
- Saving code does not execute it. Source edits are evaluated as file modifications, so execution, deletion or network logic in the saved body does not by itself trigger confirmation. Sensitive targets and possible secret values still require local confirmation.
- External writes require explicit user authorization for the destination and action. A request to fix code does not by itself authorize pushing or posting it.

Ordinary reads and edits still go through classification to respect user restrictions and personal preferences. Without usable trusted instructions or an available classifier they require confirmation. Explicitly allowlisted commands remain preapproved locally. Operations involving credential material are confirmed locally without sending their instructions or operation to the classifier.

Built-in `read` calls for existing `AGENTS.md` and `SKILL.md` files are preapproved locally after sensitive-data checks, including files outside the project. They do not require trusted user instructions or a classifier connection. Both the requested and resolved filenames must identify instruction files; unresolved paths and links to other filenames use normal classification. Length alone does not make a verified instruction path sensitive; credential patterns, configured credential values and other input fields are still checked. Like allowlisted commands, these reads bypass classifier-based restrictions and personal preferences. Reading instructions does not approve the actions described in them. Shell reads and supporting skill documentation use classification, whose default policy treats them as ordinary task preparation.

Recognized script invocations are inspected locally. Possible writes, deletion, network access or nested execution require confirmation unless an unexpired human approval for the unchanged script supports an equivalent-risk ALLOW. Sensitive source and unreadable files always require local confirmation. Other inspected scripts use the classifier with findings counts, never source text or excerpts. Imports and the fact that a command runs code do not alone force confirmation. The script's resolved path and content hash are checked again after classification. Inspection uses heuristics and cannot establish the safety of arbitrary code or imported modules.

The classifier evaluates compound commands as a whole. Listings separated by semicolons, `printf` headings and stderr redirected to `/dev/null` do not by themselves require confirmation; actions such as `find -exec` and `find -delete` can have side effects. Low-confidence ALLOW answers still require confirmation under `minAllowConfidence` (default `0.7` for all operations); policy guidance does not guarantee a particular model decision.

## What to expect

- **ALLOW:** proceed with ordinary investigation and local development without concrete consequential risk or explicit restrictions, and explicitly authorized consequential work within scope.
- **ASK:** explain the proposed operation and request your approval before proceeding. Credential material that would leave the machine always lands here.
- **DENY:** block operations the classifier reports as clearly improper, such as privilege abuse.

Missing configuration, API failures, or uncertain decisions require confirmation rather than automatic approval. If confirmation is required but no UI is available, the operation is blocked.

Set `explainBeforeAsk` to `false` for direct confirmation without an explanation from the execution model.

Email addresses in instructions, operation fields, approval history and personal preferences are replaced with stable opaque aliases before either classifier transport receives them. Matching addresses retain matching aliases, and different addresses remain distinct, so destination restrictions and approval scope can still be compared. The aliases use a process-local secret key; the classifier receives no address-to-alias lookup. Original arguments remain unchanged for execution and local confirmation. Ordinary contact/author metadata alone does not require confirmation; sending messages or publishing still requires authorization. Keys, tokens, passwords and sensitive paths retain local confirmation, including when a credential happens to look like an email address. This is email redaction, not a general detector for all personal information.

Your instructions and operation details may be sent to the configured classifier. Hiraishi can make mistakes and does not cover every execution path. See [security limitations](./SECURITY.md).

## Optional script isolation

Isolation is disabled until you configure a trusted executor in your personal `config.json`:

```json
{
  "sandbox": {
    "command": ["/absolute/path/to/project-sandbox", "--profile", "development"],
    "timeoutMs": 15000
  }
}
```

Merge this field into your classifier settings. `command` is an argument array; its first entry must be an absolute executable path. No shell expansion is performed. The executor is responsible for providing the target project's runtime, dependencies, filesystem restrictions, network restrictions and process isolation. It can wrap a container or another sandbox system. Hiraishi does not install runtimes or verify the executor's isolation guarantees.

For a supported simple script invocation, the confirmation UI offers **Run with configured sandbox**. For operations requiring confirmation, configuring an executor does not grant automatic approval. Routine scripts that pass classification can run normally without opening the isolation UI. Unconfigured, disabled, compound or unreadable invocations do not offer that choice. `sandboxVerification: false` disables the choice even when an executor is configured. When confirmation is required, normal execution is a separate choice from isolation.

After approval, Hiraishi checks the script's SHA-256 and resolved path again, then starts the executor in the project directory. The executor receives one JSON document on standard input:

```json
{
  "version": 1,
  "cwd": "/project",
  "script": "/tmp/verify.rb",
  "hash": "<sha256>",
  "source": "puts 1\n",
  "runtime": "ruby",
  "args": ["--example"]
}
```

The executor must execute the supplied `source` in its isolated environment with the requested runtime and literal arguments. `script` identifies the reviewed file; reopening it on the host could execute content changed after review. Host paths may need mapping into the environment. The runtime field preserves the original executable name or path; Hiraishi does not substitute a system interpreter. The executor inherits the host environment and must filter environment variables and mount access before running code.

Standard output and error are forwarded to pi. The executor's exit status is preserved; startup errors and timeouts fail the operation without retrying it as a normal run. `timeoutMs` defaults to 15000 and accepts 1 through 600000 milliseconds. The timeout kills the executor process; the executor must arrange cleanup of child processes, containers and remote jobs.

## Tests and model evaluation

```sh
npm install --include=dev
npm run typecheck
npm test
```

Tests mock the classifier API and exercise the executor protocol with Node.js fixtures. The full suite also requires Linux, git, curl and bash. Filesystem integration tests use real bubblewrap when available; set `HIRAISHI_REQUIRE_BWRAP=1 npm test` to require them rather than skip when the backend cannot run. They use synthetic files and a test-owned process, and include the actual Pi SDK approval path with deterministic classification and UI responses. Ruby and Python are not test dependencies. Optional executor isolation guarantees still depend on the environment that provides that executor.

To compare classifiers, copy `evaluation.sample.json` to `evaluation.json` and configure your candidates. Live API calls happen only with `--live`:

```sh
node evaluate.ts --models evaluation.json --out evaluation-offline.json
node evaluate.ts --live --models evaluation.json --out evaluation-live.json
```
