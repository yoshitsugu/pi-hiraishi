export type Locale = 'en' | 'ja';

export interface Messages {
  verdicts: {
    askDefaultRisk: string;
    riskLocalRead: string;
    allowAllowlist: string;
    allowInstructionRead: string;
    riskAllowlist: string;
    askSensitive: string;
    riskSensitive: string;
    askCredentialEgress: string;
    riskCredentialEgress: string;
    askNoIntents: string;
    askTooLarge: string;
    askScriptSideEffects: string;
    askApprovalExpired: string;
    judgeInvalidConfig: string;
    judgeUnavailable: string;
    insufficient: string;
    contradiction: string;
    riskExternal: string;
    riskChange: string;
  };
  reasons: Record<string, string>;
  riskLabels: Record<'read' | 'write' | 'delete' | 'network' | 'execute' | 'load', string>;
  script: {
    hiddenPath: string;
    hiddenSecrets: string;
    unreadable: string;
    bodyUnavailable: string;
    purposeFallback: string;
    latestRequest: string;
    scriptLabel: string;
    bodyId: string;
    unverified: string;
    evidenceSuffix: string;
    noEvidence: string;
    noteSimple: string;
    noteCompound: string;
  };
  concrete: Record<string, string>;
  ui: {
    back: string;
    nextLines: string;
    previousLines: string;
    viewBody: string;
    viewBodyPrefix: string;
    sandboxOption: string;
    argsHiddenStrict: string;
    targetAndArgs: string;
    allowNormalRun: string;
    allowChange: string;
    reject: string;
    viewDiff: string;
    viewContent: string;
    changeDetails: string;
    contentToSave: string;
    titleScriptReview: string;
    titleFileReview: string;
    titleConfirm: string;
    operationLabel: string;
    targetLabel: string;
    contentLabel: string;
    checkLabel: string;
    reasonLabel: string;
    riskLabel: string;
    decisionReasonLabel: string;
    operationEdit: string;
    operationOverwrite: string;
    operationCreate: string;
    contentUnits: string;
    localSaveNote: string;
    workflowKind: string;
    mainSteps: string;
    andMore: string;
    permissions: string;
    existingContentUnavailable: string;
    bodyHidden: string;
    diffBefore: string;
    diffAfter: string;
    currentFile: string;
    contentToSaveDiff: string;
    diffOmitted: string;
    isolatedUses: string;
    isolatedUnsupported: string;
    argsHidden: string;
    argsTruncated: string;
    argsTooLarge: string;
    bodyPage: string;
    scriptConfirmRequired: string;
    aborted: string;
    userRejected: string;
    scriptChanged: string;
    uiDisconnected: string;
    targetChanged: string;
    askRejected: string;
    explanationTitle: string;
    explanationSummary: string;
    explanationReason: string;
  };
  replies: {
    tooLarge: string;
    safeTarget: string;
    invalidExplanation: string;
    missingRequest: string;
    changedDuringReview: string;
    notExecuted: string;
    changedDuringApproval: string;
    approvalFailed: string;
    toolLabel: string;
  };
  handler: {
    instructionChanged: string;
    changedDuringConfirm: string;
    grantMismatch: string;
    changedWhileJudging: string;
    settingsUnreadable: string;
  };
  sandbox: { failed: string };
}

const en: Messages = {
  verdicts: {
    askDefaultRisk: 'It is not yet confirmed what changes and whether it can be undone',
    riskLocalRead: 'reads local information',
    allowAllowlist: 'matches the allowlist of approved commands',
    allowInstructionRead: 'reads an agent instruction or skill definition file',
    riskAllowlist: 'runs a command approved in the settings',
    askSensitive: 'sensitive data stays local instead of being sent to the classifier',
    riskSensitive: 'possible read, change or transfer of sensitive data',
    askCredentialEgress: 'the operation sends credential material to a remote host',
    riskCredentialEgress: 'check the destination and the credential file against your request',
    askNoIntents: 'the trusted user instructions could not be read safely',
    askTooLarge: 'the operation is too large to evaluate without dropping information',
    askScriptSideEffects: 'the script has possible writes, deletion, network or nested execution, or could not be inspected safely',
    askApprovalExpired: 'the prior approval expired during classification; confirmation is required',
    judgeInvalidConfig: 'the allowlist or classifier settings are invalid',
    judgeUnavailable: 'the classifier service is unavailable, so confirmation is required',
    insufficient: 'ALLOW confidence is below the configured threshold',
    contradiction: 'the decision and the reason contradict each other',
    riskExternal: 'check the destination, the exposed scope and the change target',
    riskChange: 'check which data changes and whether it can be reverted',
  },
  reasons: {
    authorized: 'the operation matches an explicit user instruction',
    necessary: 'ordinary local editing, building or testing',
    read: 'ordinary read, search or listing',
    external: 'external service change without explicit instruction',
    destructive: 'consequential change without sufficient authorization',
    sensitive: 'check of sensitive data or authority scope',
    scope: 'an explicit restriction excludes the operation, or the read is clearly unrelated to the work',
    uncertain: 'consequential effects cannot be determined safely',
    improper: 'credential export outside its purpose or clear privilege abuse',
  },
  riskLabels: { read: 'read', write: 'write', delete: 'delete', network: 'network', execute: 'program execution', load: 'loaded code' },
  script: {
    hiddenPath: 'the body is not read because the path is sensitive',
    hiddenSecrets: 'the body and excerpts are hidden because they may contain sensitive data',
    unreadable: 'the body cannot be read; check a size over 64 KiB, non-regular files, encoding and permissions',
    bodyUnavailable: 'the body cannot be shown',
    purposeFallback: 'the latest request cannot be shown safely',
    latestRequest: 'Latest request: ',
    scriptLabel: 'Script: ',
    bodyId: 'Body id: ',
    unverified: 'unverified',
    evidenceSuffix: ' evidence: ',
    noEvidence: 'none detected in the body (not a guarantee of behavior)',
    noteSimple: 'Note: loaded code and runtime values are not analyzed.',
    noteCompound: 'Note: the command is compound or has run options, so it is not analyzed as a whole.',
  },
  concrete: {
    credentialEgress: 'the credential material in {target} would be sent to {destination}; check the destination and the file against your request',
    unknownTarget: 'the target file',
    unknownDestination: 'an external destination',
    gitResetHard: 'uncommitted changes to tracked files are lost and may not be restorable with Git',
    gitClean: 'files not stored in Git may be deleted and cannot be restored by Git afterwards',
    rm: 'the target file or directory is deleted; unsaved content and backups are unverified',
    gitPush: 'changes are sent to a remote branch and may affect collaborators or automated deployments',
    writeEdit: 'the target file is rewritten; check that existing content or uncommitted work is not overwritten',
    network: 'may send, publish or change remote data or permissions; check the destination and the content',
    runProgram: 'runs project code; file changes or network use from loaded code are unverified',
    unknown: 'the changed files or targets are unknown; check that the shown arguments stay within the request',
  },
  ui: {
    back: 'Back',
    nextLines: 'Next 40 lines',
    previousLines: 'Previous 40 lines',
    viewBody: 'View body ({n})',
    viewBodyPrefix: 'View body',
    sandboxOption: 'Run with configured sandbox',
    argsHiddenStrict: 'arguments hidden because they contain sensitive data (check the original tool call)',
    targetAndArgs: 'Target and arguments: ',
    allowNormalRun: 'Allow normal run (no isolation)',
    allowChange: 'Allow this change',
    reject: 'Reject',
    viewDiff: 'View diff',
    viewContent: 'View content to save',
    changeDetails: 'Change details',
    contentToSave: 'Content to save',
    titleScriptReview: 'Hiraishi: generated script review',
    titleFileReview: 'Hiraishi: file change review',
    titleConfirm: 'Hiraishi: confirm execution',
    operationLabel: 'Operation: ',
    targetLabel: 'Target: ',
    contentLabel: 'Content: ',
    checkLabel: 'Check: ',
    reasonLabel: 'Reason: ',
    riskLabel: 'Risk: ',
    decisionReasonLabel: 'Decision reason: ',
    operationEdit: 'replace the given text',
    operationOverwrite: 'overwrite the file',
    operationCreate: 'create the file',
    contentUnits: ' lines / ',
    localSaveNote: 'This only saves a local file.',
    workflowKind: 'Kind: GitHub Actions workflow (steps and permissions apply at CI run time)',
    mainSteps: 'Main steps: ',
    andMore: ' and {n} more',
    permissions: 'Permissions: ',
    existingContentUnavailable: 'Existing content: the diff is unavailable because of size, sensitive data or read access.',
    bodyHidden: 'Body: hidden because it may contain sensitive data',
    diffBefore: '--- text before replacement',
    diffAfter: '+++ text after replacement',
    currentFile: '--- current file',
    contentToSaveDiff: '+++ content to save',
    diffOmitted: '@@ first {h} and last {t} common lines omitted @@',
    isolatedUses: 'Sandbox executor: {executor}. File access, networking, dependencies and process isolation are controlled by this executor.',
    isolatedUnsupported: 'Isolated run: no executor configured, isolation disabled, or unsupported command. A normal run uses your current user permissions.',
    argsHidden: 'arguments hidden because they may contain sensitive data; check the original tool call',
    argsTruncated: '(truncated; check the original call)',
    argsTooLarge: 'the arguments are too large; check the original tool call',
    bodyPage: ' (body {n}/{m})',
    scriptConfirmRequired: 'ASK: the script body and its side effects need confirmation (no confirmation UI)',
    aborted: 'the operation was aborted',
    userRejected: 'ASK: the user rejected or cancelled',
    scriptChanged: 'ASK: the reviewed script changed or its body cannot be verified; request the run again',
    uiDisconnected: 'ASK: the confirmation UI was disconnected',
    targetChanged: 'ASK: the target file changed during confirmation',
    askRejected: 'ASK: rejected, cancelled, or the confirmation UI was disconnected',
    explanationTitle: 'Explanation by the execution model (not approval)',
    explanationSummary: 'Change summary: ',
    explanationReason: 'Why confirmation is needed: ',
  },
  replies: {
    tooLarge: 'ASK: the operation is too large to hold for review; split it into smaller operations',
    safeTarget: 'the target of the operation just proposed',
    invalidExplanation: 'The explanation is invalid or contains sensitive data. Give a short summary and reason without secret values. The operation was not executed.',
    missingRequest: 'There is no pending operation, or it expired. The operation was not executed.',
    changedDuringReview: 'The user instruction, target file or script changed. The operation was not executed.',
    notExecuted: 'The operation was not executed. Do not repeat a rejected operation automatically.',
    changedDuringApproval: 'The conditions changed or the request was aborted during approval. The operation was not executed.',
    approvalFailed: 'Approval or execution failed. There is no fallback to a normal run and no automatic retry.',
    toolLabel: 'Hiraishi explanation and approval',
  },
  handler: {
    instructionChanged: 'ASK: the user instruction or session changed',
    changedDuringConfirm: 'ASK: the user instruction, session or target changed during confirmation',
    grantMismatch: 'ASK: the operation does not match the approved conditions.',
    changedWhileJudging: 'ASK: the user instruction or session changed while judging',
    settingsUnreadable: 'ASK: not executed because the settings or target state cannot be checked; check the settings and the target files',
  },
  sandbox: {
    failed: 'Hiraishi: the isolated run failed. There is no fallback to a normal run. Check the script, missing dependencies, isolation support and the execution limits.',
  },
};

const ja: Messages = {
  verdicts: {
    askDefaultRisk: '何が変わるか、元に戻せるかはまだ確認できません',
    riskLocalRead: 'ローカル情報の読み取り',
    allowAllowlist: '許可リストのコマンドに一致',
    allowInstructionRead: 'エージェント指示・Skill定義ファイルの読み取り',
    riskAllowlist: '設定で承認したコマンドの実行',
    askSensitive: '機密情報は判定サービスへ送らずローカルで確認します',
    riskSensitive: '機密情報の読み取り・変更・送信の可能性',
    askCredentialEgress: '認証情報がリモートホストへ送られます',
    riskCredentialEgress: '送信先と認証情報ファイルが依頼どおりか確認してください',
    askNoIntents: '信頼できるユーザー指示を解析できません',
    askTooLarge: '操作が大きすぎ、情報を落とさずに評価できません',
    askScriptSideEffects: 'スクリプトに書き込み・削除・通信・別の処理の実行の可能性があるか、安全に内容を調べられないため確認します',
    askApprovalExpired: '判定中に以前の承認が失効したため、確認が必要です',
    judgeInvalidConfig: '許可リストまたは判定設定が不正です',
    judgeUnavailable: '判定サービスを利用できないため確認が必要です',
    insufficient: 'ALLOWの確信度が設定した閾値未満です',
    contradiction: '判定と理由が矛盾しています',
    riskExternal: '送信先、公開範囲、変更する対象が依頼どおりか確認してください',
    riskChange: 'どのデータが変わるか、変更前に戻せるかを確認してください',
  },
  reasons: {
    authorized: 'ユーザーの明示的指示に沿った操作',
    necessary: '通常のローカル編集・ビルド・テスト',
    read: '通常の読み取り・検索・一覧表示',
    external: '明示的指示のない外部サービスの変更',
    destructive: '十分な許可がない重大な変更',
    sensitive: '機密情報・権限の利用範囲の確認',
    scope: '明示的な制限に反する操作、または作業と明らかに無関係な読み取り',
    uncertain: '重大な副作用の影響範囲を確定できません',
    improper: '認証情報の目的外送信または明確な権限逸脱',
  },
  riskLabels: { read: '読み取り', write: '書き込み', delete: '削除', network: '外部通信', execute: 'プログラムの実行', load: '読み込まれるコード' },
  script: {
    hiddenPath: '機密パスのため本文は読み取りません',
    hiddenSecrets: '機密情報の可能性があるため本文と抜粋は表示しません',
    unreadable: '本文を読めません。64 KiB を超える、通常外のファイル、文字コード、アクセス権を確認してください',
    bodyUnavailable: '本文を表示できません',
    purposeFallback: '直近の依頼を安全に表示できません',
    latestRequest: '直近の依頼：',
    scriptLabel: 'スクリプト：',
    bodyId: '本文の識別子：',
    unverified: '未確認',
    evidenceSuffix: 'の手がかり：',
    noEvidence: '本文では検出なし（動作の保証ではありません）',
    noteSimple: '注意：読み込まれるコードや実行時の値までは解析していません。',
    noteCompound: '注意：複合コマンドや実行オプションを含み、全体を解析できていません。',
  },
  concrete: {
    credentialEgress: '{target}の認証情報が{destination}へ送信されます。送信先と対象ファイルが依頼どおりか確認してください',
    unknownTarget: '対象ファイル',
    unknownDestination: '外部の送信先',
    gitResetHard: '追跡中のファイルの未コミット変更が失われます。Gitで復元できるとは限りません。',
    gitClean: 'Gitに保存されていないファイルが削除される可能性があります。削除後にGitでは戻せません。',
    rm: '指定先のファイルやディレクトリが削除されます。未保存の内容やバックアップの有無は未確認です。',
    gitPush: 'リモートのブランチに変更を送ります。共同作業者や自動デプロイに影響する可能性があります。',
    writeEdit: '対象ファイルを書き換えます。既存の内容や未コミット変更を上書きしないか確認してください。',
    network: '外部へデータを送ったり公開したり、リモートのデータや権限を変更したりする可能性があります。送信先と内容を確認してください。',
    runProgram: 'プログラムやプロジェクトのコードを実行します。読み込まれるコードによるファイル変更や外部通信は未確認です。',
    unknown: 'この操作で変更されるファイルや相手先を特定できていません。表示した引数が依頼の範囲内か確認してください。',
  },
  ui: {
    back: '確認に戻る',
    nextLines: '次の 40 行',
    previousLines: '前の 40 行',
    viewBody: '本文を見る（{n}）',
    viewBodyPrefix: '本文を見る',
    sandboxOption: '設定した隔離環境で実行',
    argsHiddenStrict: '機密情報を含むため引数を非表示（元のツール呼び出しを確認）',
    targetAndArgs: '対象・引数：',
    allowNormalRun: '通常実行を許可（隔離なし）',
    allowChange: 'この変更を許可',
    reject: '拒否する',
    viewDiff: '差分を見る',
    viewContent: '保存する本文を見る',
    changeDetails: '変更内容',
    contentToSave: '保存する本文',
    titleScriptReview: 'Hiraishi: 生成スクリプトの確認',
    titleFileReview: 'Hiraishi: ファイル変更の確認',
    titleConfirm: 'Hiraishi: 実行の確認',
    operationLabel: '操作：',
    targetLabel: '対象：',
    contentLabel: '内容：',
    checkLabel: '確認すること：',
    reasonLabel: '理由：',
    riskLabel: 'リスク：',
    decisionReasonLabel: '判定理由：',
    operationEdit: '指定箇所の置換',
    operationOverwrite: 'ファイルを上書き',
    operationCreate: 'ファイルを新規作成',
    contentUnits: '行 / ',
    localSaveNote: '今回はローカルファイルの保存です。',
    workflowKind: '種類：GitHub Actions ワークフロー（CI 実行時に手順と権限が適用されます）',
    mainSteps: '主な手順：',
    andMore: ' ほか {n} 件',
    permissions: '権限の設定：',
    existingContentUnavailable: '既存内容：大きさ・機密情報・読み取り可否のため差分を表示できません。',
    bodyHidden: '本文：機密情報の可能性があるため非表示',
    diffBefore: '--- 置換前の指定テキスト',
    diffAfter: '+++ 置換後の指定テキスト',
    currentFile: '--- 現在のファイル',
    contentToSaveDiff: '+++ 保存する内容',
    diffOmitted: '@@ 共通する先頭 {h} 行・末尾 {t} 行を省略 @@',
    isolatedUses: '隔離コマンド：{executor}。ファイルアクセス、通信、依存関係、プロセスの隔離はこのコマンドの設定に従います。',
    isolatedUnsupported: '隔離実行：コマンド未設定、隔離無効、または対象の実行形式に未対応です。通常実行は現在のユーザー権限で行われます。',
    argsHidden: '機密情報を含む可能性があるため引数を非表示。元のツール呼び出しを確認してください。',
    argsTruncated: '（以降省略。元の呼び出しを確認）',
    argsTooLarge: '引数が大きいため元のツール呼び出しを確認',
    bodyPage: '（本文 {n}/{m}）',
    scriptConfirmRequired: 'ASK: スクリプトの本文と副作用の確認が必要です（確認 UI なし）',
    aborted: '操作が中断されました',
    userRejected: 'ASK: ユーザーが拒否またはキャンセルしました',
    scriptChanged: 'ASK: 確認したスクリプトが変更されたか、本文を検証できません。再度実行を依頼してください。',
    uiDisconnected: 'ASK: 確認 UI が切断されました',
    targetChanged: 'ASK: 確認中に対象ファイルが変わりました',
    askRejected: 'ASK: 拒否・キャンセル・確認 UI の切断',
    explanationTitle: '実行モデルによる説明（承認とは扱いません）',
    explanationSummary: '変更の概要：',
    explanationReason: '確認が必要な理由：',
  },
  replies: {
    tooLarge: 'ASK: 操作が大きすぎるため保留できません。小さな操作に分けてください。',
    safeTarget: '直前に提案した操作の対象',
    invalidExplanation: '説明が不正か機密情報を含みます。秘密値を除いた短い概要と確認理由が必要です。操作は実行していません。',
    missingRequest: '保留中の操作がないか期限切れです。操作は実行していません。',
    changedDuringReview: 'ユーザー指示、対象ファイル、またはスクリプトが変更されました。操作は実行していません。',
    notExecuted: '操作は実行していません。拒否された操作を自動で繰り返さないでください。',
    changedDuringApproval: '承認中に条件が変わったか中断されました。操作は実行していません。',
    approvalFailed: '承認処理または実行に失敗しました。通常実行への切り替えや自動再試行は行いません。',
    toolLabel: 'Hiraishi の説明と承認',
  },
  handler: {
    instructionChanged: 'ASK: ユーザー指示またはセッションが変更されました',
    changedDuringConfirm: 'ASK: 確認中にユーザー指示、セッション、または対象が変更されました',
    grantMismatch: 'ASK: 承認した操作の条件と一致しません。',
    changedWhileJudging: 'ASK: 判定中にユーザー指示またはセッションが変更されました',
    settingsUnreadable: 'ASK: 設定または対象の状態を確認できないため実行していません。設定と対象ファイルを確認してください。',
  },
  sandbox: {
    failed: 'Hiraishi: 隔離実行に失敗しました。通常実行へは切り替えません。スクリプト変更、依存不足、隔離機能、実行上限を確認してください。',
  },
};

export const messages: Record<Locale, Messages> = { en, ja };

let active: Locale = 'en';
export function activeLocale(): Locale { return active; }
export function setLocale(locale: Locale): void { active = locale; }
export function isLocale(value: unknown): value is Locale { return value === 'en' || value === 'ja'; }
export function detectLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  const tag = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  return /^ja([-_.@]|$)/i.test(tag) ? 'ja' : 'en';
}
export function applyLocale(config: { locale?: Locale } | undefined, env: NodeJS.ProcessEnv = process.env): Locale {
  const locale = config?.locale ?? detectLocale(env);
  setLocale(locale);
  return locale;
}
export function fmt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
