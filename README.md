# MCP Apps Cloud Logging Viewer

Claude Desktop のチャット画面に GCP Cloud Logging のログビューアを埋め込む MCP Apps サーバーです。

## 機能

- Cloud Logging のログをインタラクティブなビューアで表示
- ログエントリをクリックして選択し、Claude に質問できる
- 期間・severity・リソースタイプでフィルタ可能

## セットアップ

### 前提条件

- Node.js 20+
- Claude Desktop（最新版）
- GCP プロジェクトへのアクセス権（`roles/logging.viewer` 以上）

### インストール

```bash
npm install
npm run build
```

### GCP 認証

```bash
gcloud auth application-default login
```

### Claude Desktop の設定

`claude_desktop_config.json` に以下を追加:

```json
{
  "mcpServers": {
    "cloud-logging": {
      "command": "node",
      "args": ["/path/to/dist/index.js", "--stdio"]
    }
  }
}
```

Claude Desktop を再起動後、「プロジェクト名のログを表示して」と話しかけてください。

## 注意事項

- 本ソースコードは AI（Claude Code）による実装を多く含んでいます。特に認証周りやセキュリティ要件については、ご自身の環境に合わせて十分にご確認のうえご利用ください。
- ログの選択機能は実験的な実装であり、選択/解除の操作が正しく反映されない場合があります。

## 関連記事

- [MCP Apps で GCP のログを Claude のチャットに埋め込む](https://qiita.com/sshima__/items/f56f23f9aaccae0fde8a)
