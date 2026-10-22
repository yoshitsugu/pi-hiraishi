# pi Hiraishi

A pi extension that checks tool calls against your instructions before they run. It aims to keep routine work moving while asking about unintended, consequential changes.

## Requirements

pi 1.3.x and Node.js 22.19 or later. Tested on Linux; macOS and Windows are unverified. Optional script isolation uses an executor you configure for the target project; install its runtimes and dependencies in that environment.

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
- Explicit prohibitions, exclusions and revocations still apply to ordinary operations. Access to unrelated private personal documents can require confirmation for privacy reasons.
- Confirmation concentrates on sensitive access, unapproved external writes or publication, broad deletion, loss of existing work, history rewriting, production changes, permissions, system-wide changes and genuinely unknown consequential effects. Explicit authorization can cover consequential work within its stated scope; local sensitive-data checks remain in effect.
- Saving code does not execute it. Source edits are evaluated as file modifications, so execution, deletion or network logic in the saved body does not by itself trigger confirmation. Sensitive targets and possible secret values still require local confirmation.
- External writes require explicit user authorization for the destination and action. A request to fix code does not by itself authorize pushing or posting it.

Ordinary reads and edits still go through classification to respect user restrictions and personal preferences. Without usable trusted instructions or an available classifier they require confirmation. Explicitly allowlisted commands remain preapproved locally. Operations involving credential material are confirmed locally without sending their instructions or operation to the classifier.

Recognized script invocations are inspected locally. Possible writes, deletion, network access or nested execution, sensitive source, and unreadable files require confirmation. Other inspected scripts use the classifier with findings counts, never source text or excerpts. Imports and the fact that a command runs code do not alone force confirmation. The script's resolved path and content hash are checked again after classification. Inspection uses heuristics and cannot establish the safety of arbitrary code or imported modules.

The classifier evaluates compound commands as a whole. Listings separated by semicolons, `printf` headings and stderr redirected to `/dev/null` do not by themselves require confirmation; actions such as `find -exec` and `find -delete` can have side effects. Low-confidence ALLOW answers still require confirmation under `minAllowConfidence` (default `0.7` for all operations); policy guidance does not guarantee a particular model decision.

## What to expect

- **ALLOW:** proceed with ordinary investigation and local development without concrete consequential risk or explicit restrictions, and explicitly authorized consequential work within scope.
- **ASK:** explain the proposed operation and request your approval before proceeding. Credential material that would leave the machine always lands here.
- **DENY:** block operations the classifier reports as clearly improper, such as privilege abuse.

Missing configuration, API failures, or uncertain decisions require confirmation rather than automatic approval. If confirmation is required but no UI is available, the operation is blocked.

Set `explainBeforeAsk` to `false` for direct confirmation without an explanation from the execution model.

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

Tests mock the classifier API and exercise the executor protocol with Node.js fixtures. The full suite also requires Linux, git, curl and bash; Ruby, Python and bubblewrap are not test dependencies. Isolation guarantees must be tested in the environment that provides your executor.

To compare classifiers, copy `evaluation.sample.json` to `evaluation.json` and configure your candidates. Live API calls happen only with `--live`:

```sh
node evaluate.ts --models evaluation.json --out evaluation-offline.json
node evaluate.ts --live --models evaluation.json --out evaluation-live.json
```
