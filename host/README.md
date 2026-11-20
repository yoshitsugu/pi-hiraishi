# hiraishi-publish

サンドボックス内の子 pi が作った commit を、host 側の固定手順だけで新しいブランチとして push するラッパーです。
判断は人間・CI・ブランチ保護に任せ、publisher は「allowlist にあるリポジトリの、既定ブランチの子孫である、上限内の commit」だけを
`hiraishi/<UTC 日時>-<sha 先頭 8 桁>-<乱数 8 桁>` という新しいブランチに送ります。

ツールごとのラッパーは作りません。publisher はこの 1 本だけです。

## 動作要件

- bash
- git (SHA-1 リポジトリのみ。SHA-256 は非対応)
- Node.js (allowlist の JSON 解析)
- GNU coreutils (`timeout`、`realpath`、`head`、`wc`、`mktemp`、`readlink`、`od` など)

起動時に `node`、`git`、`timeout`、`realpath` の存在を確認し、無ければ固定文言で失敗します。
GNU coreutils は Linux を前提にしています。

## 構成

host に次の 2 ファイルを置きます。`publish-allow.json` はスクリプトと同じディレクトリに固定名で置きます
(環境変数では指定できません)。

```
/usr/local/lib/hiraishi-publish/hiraishi-publish
/usr/local/lib/hiraishi-publish/publish-allow.json
```

リポジトリ側では allowlist を `host/publish-allow.json` に置きます(ホスト専用なので `.gitignore` で無視されます)。
それを host の配置先へコピーします。

```sh
install -d -m 700 /usr/local/lib/hiraishi-publish
install -m 755 host/hiraishi-publish /usr/local/lib/hiraishi-publish/hiraishi-publish
install -m 600 host/publish-allow.json /usr/local/lib/hiraishi-publish/publish-allow.json
```

スクリプトと allowlist はサンドボックスの書き込み許可対象の外に置いてください。
スクリプトのディレクトリが子の書き込み許可対象に入っていると、allowlist ごと差し替えられます。

## 呼び出し

```sh
hiraishi-publish <作業ディレクトリの絶対パス> <bundle ファイルの絶対パス>
```

workdir と bundle の絶対パスに制御文字は含められません。

標準出力は次の 3 行だけです。

```
branch: hiraishi/20250102T030405Z-0123abcd-1a2b3c4d
tip: 0123abcdef...
commits: 2
```

認証情報は出力しません。認証は host の ssh-agent と deploy key を前提にします。
hostCommands 経由で使う場合は `SSH_AUTH_SOCK` を `env` で渡してください。
`GIT_CONFIG_GLOBAL=/dev/null` で動くため、HTTPS の credential helper は使えません。HTTPS remote を使う場合は
認証情報を git の設定ファイルに依存しない方法で渡す必要がありますが、このラッパーはそれを用意しません。
スクリプト内に鍵や token は置きません。

スクリプトを hostCommands を経由せず直接実行する場合は、環境変数を自分で整えてください。
hostCommands 経由では `env` の allowlist だけが host から子へ渡ります。

## allowlist

`host/publish-allow.json` の書式:

```json
{
  "repos": [
    {
      "path": "/home/you/src/example",
      "remote": "git@github.com:you/example.git"
    }
  ]
}
```

- `path` は作業ディレクトリの realpath と完全一致する必要があります。`~/...` や相対パスは使えません。
- `remote` はそのまま push/fetch 先になります。子の `.git/config` の `origin` は読みません。
- `remote` は `https://`、ssh (`ssh://` または `user@host:path`)、`file` (ローカルのテスト専用) だけを許可します。
  `http://` や `ext::` などは git の protocol 制限で拒否されます。
- 空の `remote`、改行や制御文字を含む `remote` は拒否します。
- 同じ `path` を複数書いた場合は拒否します。

## hostCommands への登録

`~/.pi/agent/hiraishi/config.json` などに追加します。

```json
{
  "hostCommands": [
    {
      "name": "publish",
      "path": "/usr/local/lib/hiraishi-publish/hiraishi-publish",
      "env": ["SSH_AUTH_SOCK"],
      "operations": [
        { "name": "run", "argv": ["{cwd}", "{task}"], "timeoutSeconds": 360 }
      ]
    }
  ]
}
```

`hiraishi_host` からは次のように呼びます。

```
command=publish operation=run cwd=/home/you/src/example task=/home/you/src/example/.hiraishi-out.bundle
```

現在の hiraishi が使えるプレースホルダは `{name}`、`{cwd}`、`{task}`、`{grants}`、`{lines}`、`{timeout}`、`{hiraishi}` です。
**`{bundle}` はありません。** そのため bundle の絶対パスは `{task}` で渡します。`{task}` は空でなく、`-` や `@` で
始まってはいけませんが、絶対パスは `/` で始まるので通ります。`{task}` の上限は 8000 文字です。

`{bundle}` を追加する場合の最小の対応は、`policy.ts` の `hostPlaceholders` に `'{bundle}'` を足し、
`host-bridge.ts` の `Request` 型・`parameters`・入力検証・`substitute` に `bundle` を追加する方法です
(コマンドの `path` が書き込み許可対象の内側にあってはいけない、という既存の検査はそのまま使えます)。

`hiraishi_host` の `{cwd}` は、セッションの workspace、書き込み grant、または `maxReadWrite` の内側である必要があります。
通常はセッションの作業ディレクトリをそのまま渡します。コマンドの `path` は書き込み許可対象の外に置きます。
子に publish を委譲したい場合だけ `"delegable": true` を付けます。付けると子は自分で push できるようになります。

## 子側の手順

子 pi はサンドボックス内で commit し、自己完結、または prerequisite 付きの bundle を作ります。bundle は作業ディレクトリの内側に置きます。

```sh
git -c user.name='Agent' -c user.email='agent@example.invalid' commit -m 'Change something'

# base は既定ブランチの先端。origin/main が最新であればそのまま使えます。
git bundle create .hiraishi-out.bundle origin/main..HEAD
```

- bundle は prerequisite 付きで構いません。publisher は allowlist の remote から既定ブランチの先端を fetch してから
  `git bundle verify` するので、base がリモートの履歴に含まれていれば解決できます。
- base は「publisher が取得する既定ブランチの先端」の祖先でなければなりません。子が古い既定ブランチから分岐し、
  その後リモートの既定ブランチが進んだ場合、publisher は拒否します。必要なら子が既定ブランチを取り込み直します。
- bundle は 50MB 以下、`base..先端` の commit は 50 個以下です。51 個目を検出した時点で拒否します。
- `base..先端` の各 commit の raw データに `claude.ai/code/session` または `Claude-Session:` が含まれると拒否されます。
- bundle の ref は 1 つの先端に解決できる必要があります (異なる sha の head が複数ある bundle は拒否)。
- SHA-256 リポジトリは非対応です。先端は 40 桁の SHA-1 である必要があります。

## publisher が行う確認

1. 作業ディレクトリを realpath し、allowlist の `path` と完全一致することを確認する。
2. bundle を一度だけ open し、fd が通常ファイルであること、`/proc/self/fd/3` の実体が作業ディレクトリの内側であることを確認する。
   その fd から上限付き (50MB + 1 byte) で一時ディレクトリ内のコピーに読み込み、上限超過なら拒否する。
   以降の verify / list-heads / fetch はそのコピーだけを使い、元のパスは再利用しない。
3. 一時ディレクトリに使い捨ての `git init --bare` を作る。`GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` を無効化し、
   `core.hooksPath=/dev/null`、protocol を https/ssh/file に限定し、全体を 300 秒の `timeout` で制限する。
4. allowlist の remote から既定ブランチの先端だけを fetch する (base)。子の ref から base は決めない。
5. bundle を `git bundle verify` してから一時 ref に fetch し、先端 sha を確定する。fetch には
   `fetch.unpackLimit=1` / `transfer.unpackLimit=1` を付け、pack を展開しない。
6. base が先端の祖先であること、commit 数が 50 以下であることを確認する。
7. `base..先端` の各 commit の raw データに禁止されたセッション表記がないことを確認する。
8. ブランチ名を `hiraishi/<UTC 日時>-<先端 sha の先頭 8 桁>-<乱数 8 桁>` として publisher が決める。子は指定できない。
9. 同じ名前のブランチが remote にないことを確認し、`git push <remote> <先端 sha>:refs/heads/<ブランチ名>` を
   `--force-with-lease=refs/heads/<ブランチ名>:` (期待値は「存在しない」) 付きで実行する。無条件 force は使わない。
   `HEAD` は使わない。

終了時の一時ディレクトリ削除は trap によるベストエフォートです。SIGKILL や host の crash では残るため、
stale な一時ディレクトリの定期削除 (systemd-tmpfiles など) は host 管理者の責務です。

git と Node.js の stderr は捨てます。子に返るのは固定の文言だけです。詳細が要るときは host 管理者が
`HIRAISHI_PUBLISH_DEBUG=1` を設定して手で実行します。この変数は hostCommands の env allowlist には入れないでください。
子が自分で渡した引数の値はそのまま返すことがあります。

## 脅威モデル

- 子はサンドボックス内で commit と bundle を作れます。bundle の内容、commit message、ファイル、作者情報は子が制御できます。
- publisher は子の `.git` (config、hooks、alternates、origin) を読みません。bundle だけを host の使い捨て bare リポジトリで扱います。
  子が `.git/config` の `origin` を別の remote に変えたり、`pre-push` hook を置いたり、alternates を細工しても結果は変わりません。
- push 先と base は allowlist と remote の既定ブランチから決まります。子は push 先の remote もブランチ名も選べません。
- `claude.ai/code/session` / `Claude-Session:` の検査は、履歴に混ざったセッション表記を落とすための限定的な衛生検査です。
  作者の証明や署名の検証ではありません。
- allowlist、スクリプト、host の認証情報 (ssh-agent、deploy key) は host の信頼境界です。これらを子が書き換えられる場所に置かないでください。
- `file` remote はテスト専用です。**子が書き込める場所に file remote を置かないでください。** push 先のローカルリポジトリで
  receive hook が有効なら、その hook は host の権限で実行されます。本番は ssh / https だけを使ってください。
- パス検査は realpath による文字列一致で、inode や bind mount は区別しません。allowlist の `path` 自体を symlink にする場合は、
  実体の realpath を書いてください。
- bundle は open した fd から一度だけコピーし、元のパスはその後使いません。検査後に元のパスを symlink などで差し替えても、
  publisher が使うのは最初に開いた内容です。
- open 前の種別確認と open の間は原子的ではありません。検査後に bundle を FIFO へ差し替えられると、open で最大 300 秒
  ブロックしますが、全体の timeout で停止します。これは publisher を呼んだ側の自己 DoS の範囲です。
- 既存ブランチの有無は `ls-remote` で確認し、失敗した場合は push しません。確認と push の間の競合は
  `--force-with-lease=refs/heads/<ブランチ名>:` (期待値は「存在しない」) で拒否します。無条件 force ではありません。
- `fetch.unpackLimit=1` / `transfer.unpackLimit=1` で pack を展開しないようにし、51 個目の commit で打ち切りますが、
  pack の解析自体のコストは残ります。完全な DoS 対策ではありません。ディスク quota や専用 tmpfs の設定は host 管理者の責務です。
- timeout、bundle サイズ、commit 数の制限は資源の暴走を減らすためのもので、完全な DoS 対策ではありません。

## このラッパーが保証しないこと

- push の外部効果: CI、webhook、デプロイ、通知などは push した時点で発生し得ます。publisher は止めません。
- 公開ブランチに含まれる秘密情報: commit されたファイルや message の内容は検査しません。
- `main` など既定ブランチへの反映: publisher は新しい `hiraishi/...` ブランチを作るだけで、merge はしません。
  レビュー、必須 CI、ブランチ保護、人間の merge が必要です。
- commit の作者、署名、テストの成否、差分の妥当性。
- remote 側のフックやサーバーの信頼性。allowlist の remote が侵害されていれば、その影響は受けます。
- SHA-256 リポジトリ。SHA-1 の 40 桁 oid だけを受け付けます。

## テスト

```sh
node --test host/hiraishi-publish.test.ts
```

ローカルの bare リポジトリを remote にして、サンドボックス内でも動く構成です。
正常系、prerequisite 付き bundle、allowlist 外の作業ディレクトリと symlink、作業ディレクトリ外の bundle、無関係な履歴、
中間 commit の session 表記 (`claude.ai/code/session` と `Claude-Session:`)、51 commit、サイズ超過、複数 head、
`ls-remote` 失敗、count/list の `rev-list` 失敗、`cat-file` 失敗、grep の異常終了、push 直前の同名ブランチ競合、
bundle の symlink 差し替え、作業ディレクトリの `.git` 削除、制御文字入りパス、空・制御文字・末尾 LF 入り remote、
fetch の unpack limit、timeout 不在時の起動チェック、HOME / XDG_STATE_HOME へ書かないこと、子の `.git` 細工を確認します。
