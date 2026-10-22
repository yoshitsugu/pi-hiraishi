# pi Hiraishi

A pi extension that checks tool calls against your instructions before they run. It aims to keep routine work moving while asking about unintended, consequential changes.

## Requirements

pi 1.3.x and Node.js 22.19 or later. Tested on Linux; macOS and Windows are unverified. Optional script isolation requires Linux, bubblewrap, prlimit, and system Ruby or Python.

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
  "minAllowConfidence": 0.8,
  "timeoutMs": 5000
}
```

Replace the example URL and model. Make your API key available in the named environment variable before starting pi; keep it out of configuration files and Git. For a server that needs no authentication, add `"auth": "none"`.

The configuration and the allowlist accept `//` and `/* */` comments, so optional keys can stay in the file as a commented line. See `config.sample.json`.

The interface language is English or Japanese. Add `"locale": "ja"` or `"locale": "en"` to the configuration; without it the locale follows `LC_ALL`, `LC_MESSAGES` or `LANG`. The language never changes what is decided, only how the confirmation is written.

Restart pi or run `/reload`, then send your next instruction. Personal settings are separate from the installed package. `HIRAISHI_CONFIG` can point to another config file; a custom pi agent directory also changes the default settings location.

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
| Local inspection | Reads facts from the operation itself: credential material, a target outside the project, a network destination, a deletion, a script. No instruction wording is inspected. |
| Classifier | Reads the instruction text and decides authorization, including negation, quotation, revocation and scope. |
| Policy | Turns the facts and the classifier answer into ALLOW, ASK or DENY. |
| Confirmation | Shows the stored operation and asks the human to approve it. |

Because the local layer never reads your words, a denial or a confirmation never depends on the language of the instruction, and a later instruction that revokes an earlier one is handled by the classifier instead of by a keyword. Operations that touch credential material are confirmed locally and are never sent to the classifier, so no secret and no instruction text leaves the machine for them.

## What to expect

- **ALLOW:** proceed with authorized work, routine reads, and low-risk local changes.
- **ASK:** explain the proposed operation and request your approval before proceeding. Credential material that would leave the machine always lands here.
- **DENY:** block operations the classifier reports as clearly improper, such as privilege abuse.

Missing configuration, API failures, or uncertain decisions require confirmation rather than automatic approval. If confirmation is required but no UI is available, the operation is blocked.

Set `explainBeforeAsk` to `false` for direct confirmation without an explanation from the execution model. Set `sandboxVerification` to `false` to disable optional script isolation.

Your instructions and operation details may be sent to the configured classifier. Hiraishi can make mistakes and does not cover every execution path. See [security limitations](./SECURITY.md).

## Tests and model evaluation

```sh
npm install --include=dev
npm run typecheck
npm test
```

Tests mock the classifier API. The full suite also requires Linux, git, curl, bash, system Ruby, bubblewrap, prlimit, and working user namespaces.

To compare classifiers, copy `evaluation.sample.json` to `evaluation.json` and configure your candidates. Live API calls happen only with `--live`:

```sh
node evaluate.ts --models evaluation.json --out evaluation-offline.json
node evaluate.ts --live --models evaluation.json --out evaluation-live.json
```
