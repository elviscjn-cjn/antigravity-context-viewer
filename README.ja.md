# Antigravity 会話コンテキストビューア & トークン使用量ダッシュボード (Antigravity Context & Token Viewer)

<p align="center">
  <img src="https://img.shields.io/badge/Version-2.3.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18.x-brightgreen?logo=node.js" alt="Node Version">
  <img src="https://img.shields.io/badge/Dependencies-Zero-success" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform Support">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <a href="README.en.md">English</a> | <b>日本語</b> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a>
</p>

**Google Antigravity デスクトップアプリ (2.x)** 専用に設計された、純正デザイン準拠の **「単一セッション・コンテキスト進行バー ＋ アカウント全体のトークン消費・7×52 ヒートマップ監視」** 統合可視化スイート。`antigravity-chinese` と同様の **ASAR 直接注入 ＋ CDP による再起動不要の動的マウント** アーキテクチャを採用し、**外部 npm 依存ゼロ**。ワンクリックでの手動導入はもちろん、AI エージェント（Antigravity / Codex / Claude Code / Cursor）に指示するだけで自動セットアップが可能です。

---

## 🎬 インターフェース＆操作プレビュー

### 1. 2大機能の統合デモ (Combined Full Demo)

<p align="center">
  <a href="assets/demo.mp4">
    <img src="assets/demo.gif" alt="Antigravity コンテキスト＆トークン監視 フルデモ" width="760">
  </a>
  <br>
  <sub>🎬 デモアニメーション：コンテキストビューア ＋ トークンヒートマップのビュー切り替え (<a href="assets/demo.mp4">Full Demo Animation</a>)</sub>
</p>

### 2. タイトルバーのデュアルカプセル：状態とアニメーション

右上タイトルバーに枠線なしのカプセルが常駐します。通常時は `#1e1e1e` で背景に自然に溶け込み、マウスホバー時には `cubic-bezier(0.16, 1, 0.3, 1)` のイージングカーブで `#343434` へ滑らかに色を遷移させながら詳細を展開します：

| 機能モジュール | 単独デモアニメーション | 通常時 (`#1e1e1e`) | ホバー展開時 (`#343434`) |
| :--- | :---: | :---: | :---: |
| **💬 現在の会話コンテキスト**<br>*(Session Context)* | <a href="assets/demo-context.mp4"><img src="assets/demo-context.gif" alt="コンテキストカプセル デモ" width="320"></a><br><sub><a href="assets/demo-context.mp4">🎬 コンテキスト動作デモ</a></sub> | <img src="assets/context-badge-default.png" alt="コンテキスト通常時" height="34"><br><sub>進行バー＋使用率のみ表示</sub> | <img src="assets/context-badge-hover.png" alt="コンテキストホバー時" height="34"><br><sub>予算上限とセッション推定を展開</sub> |
| **🔥 アカウントのトークン記録**<br>*(Account Token Tracker)* | <a href="assets/demo-token.mp4"><img src="assets/demo-token.gif" alt="トークンカプセル デモ" width="320"></a><br><sub><a href="assets/demo-token.mp4">🎬 トークン動作デモ</a></sub> | <img src="assets/token-badge-default.png" alt="トークン通常時" height="34"><br><sub>パルス点＋累計総消費のみ表示</sub> | <img src="assets/token-badge-hover.png" alt="トークンホバー時" height="34"><br><sub>当日のリアルタイム消費を展開</sub> |

### 3. デュアルタブ詳細パネルの比較

カプセルをクリックすると `#1e1e1e` のダークパネルがポップアップし、**「💬 現在の会話コンテキスト」** と **「🔥 アカウント トークン活動」** をシームレスに切り替えられます：

| 💬 タブ1：現在の会話コンテキスト | 🔥 タブ2：トークン活動＆ヒートマップ |
| :---: | :---: |
| <img src="assets/panel-detail.png" alt="コンテキスト詳細パネル" width="430"> | <img src="assets/panel-activity.png" alt="トークン活動パネル" width="460"> |
| 最上部に **「⭐ 核心使用量サマリー」** を固定し、**使用済み / 予算上限 / 残り容量** と健康状態を一目で把握。下部にはモデル返却値、1M制限警告、添付ファイル内訳を表示。 | 上部4枚のカードで **累計総消費、本日、当月、年間** を集計。下部には **7×52週ヒートマップ** を備え、「日別 / 週別 / 累計推移」の切り替えや日別詳細ツールチップに対応。 |

---

## 🌐 UI 言語の多言語翻訳について (UI Localization)

本プラグインの既定の表示言語は **中国語（簡体字）** です。UI の文字（タイトルバーのカプセル、詳細パネル、ヒートマップ）をお好みの言語（**日本語 / English / 한국어 / Español** など）に変更したい場合：

> [!TIP]
> **追加のパッケージ導入や複雑な設定ファイルの書き換えは不要です！**  
> AI エージェント（Antigravity / Claude Code / Codex / Cursor）に本リポジトリを渡して導入させる際、次のように一言指示するだけです：  
> **「AGENTS.md を読み込んでプラグインを導入し、UIの表示文言を [希望の言語、例：日本語 / English] に翻訳してください」**  
> 
> AI が自動的に `meter-renderer.js` 内の表示文言を対象言語へ翻訳し、そのままホットインジェクション（動的反映）を行います。再起動なしですぐにローカライズされた UI が適用されます。

---

## 🤖 AI エージェント向け導入コマンド

AI に向けて：**「`AGENTS.md` を読み込んで、このコンテキスト＆トークンビューアを導入してください」** と伝えてください。

エージェントはリポジトリ直下で次のコマンドを実行します：

```bash
# 1. ASAR パッチの適用 ＋ 起動中 Antigravity への無停止ホットリロード
node cli.js install

# 2. 稼働状態の確認
node cli.js status
```

---

## 🚀 手動クイックスタート

- **Windows**: [`install.bat`](install.bat) をダブルクリック（アンインストール: [`uninstall.bat`](uninstall.bat)）
- **macOS / Linux**: `./install.sh` を実行（アンインストール: `./uninstall.sh`）
