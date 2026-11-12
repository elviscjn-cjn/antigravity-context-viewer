# Antigravity コンテキスト・トークンビューアー

[简体中文](README.md) · [English](README.en.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md)

Google Antigravity 2.x のツールバーで、会話のコンテキスト使用量、モデルの応答速度、デスクトップと CLI のトークン使用量を確認できます。

## デモ

https://github.com/user-attachments/assets/46e3a6f9-5127-4470-a2ef-01525736ec5b

[高画質 MP4 をダウンロード](https://raw.githubusercontent.com/elviscjn-cjn/antigravity-context-viewer/main/assets/demo.mp4)

## 機能

- **コンテキストと応答速度**. 使用量、モデルの上限、最初のトークンまでの時間（TTFT）、出力速度、生成時間を表示します。サーバーの実測値とローカルの推定値を分けて表示します。
- **会話の詳細**. プロンプト、応答、思考、ツール、添付ファイルの内訳を確認できます。添付ファイルの推定値や読み取り範囲、取得できる画像の寸法も表示します。コンテキスト超過、レート制限、通信エラーなどを区別します。
- **トークン履歴**. 読み取れるローカルのデスクトップと CLI の使用量を集計し、利用元で絞り込めます。日・週・月・年・累計のグラフを切り替えられます。
- **API 参考額とサブスクリプション**. 対応する料金で入力・キャッシュ・出力の費用を推定し、算出できない使用量も表示します。地域別参考価格や実際の支払額との比較、通貨選択、人民元換算に対応します。推定額は比較用です。実際の請求はサービス提供元で確認してください。
- **外観**. ツールバーは空き幅に合わせて縮まり、各パネルを個別に開けます。ライト・ダークテーマやヒートマップの配色を変更できます。
- **CLI とアップデート**. インストール済みの CLI をツールバーから起動します。利用できる場合は現在の作業フォルダとプロキシを引き継ぎます。パネルで更新を確認でき、インストーラーはバックアップ、整合性検証、復元に対応します。

## 表示言語

メーターのパネルは簡体字中国語です。インストーラーは Antigravity クライアント本体（UI、システムメニュー、トレイ、読み込み画面）も簡体字・繁体字中国語に翻訳できます。既定は簡体字中国語で、英語のまま使う場合は次のコマンドで戻せます。「系统增强」タブでも切り替えられます。

```bash
node cli.js install --locale zh-TW          # zh-CN / zh-TW / en
node cli.js i18n --locale en                # 英語の原文に戻す
node cli.js i18n --brand-title translated   # english / hidden / translated
```

クライアント翻訳エンジンと辞書は [qqxpee/antigravity2-cn](https://github.com/qqxpee/antigravity2-cn) に由来します。5つの言語版は README の翻訳です。パネルを他の言語にするには、[AGENTS.md](AGENTS.md) に従って `src/renderer/` の文言を翻訳し、再ビルドしてインストールしてください。

---

## 🤖 AI エージェント向け導入コマンド

```bash
node cli.js install
node cli.js status
```

---

## 🚀 クイックスタート

- **Windows**: [`install.bat`](install.bat) / [`uninstall.bat`](uninstall.bat)
- **macOS / Linux**: `./install.sh` / `./uninstall.sh`
- **CLI**: `node cli.js check` / `install` / `status` / `restore`

---

## 🧪 テスト実行

```bash
npm test
```
コンテキスト集計、ストレージ、プロキシ設定、UI 状態、購読設定をテストします。

---

## 🤝 コミュニティ

- **[LINUX DO](https://linux.do/)**: LINUX DO コミュニティを応援・支持しています。
