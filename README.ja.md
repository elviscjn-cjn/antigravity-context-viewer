# Antigravity 会話コンテキストビューア & トークン使用量ダッシュボード (Antigravity Context & Token Viewer)

<p align="center">
  <img src="https://img.shields.io/badge/Version-2.7.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18.x-brightgreen?logo=node.js" alt="Node Version">
  <img src="https://img.shields.io/badge/Dependencies-Zero-success" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform Support">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
  <a href="https://linux.do/"><img src="https://img.shields.io/badge/LINUX%20DO-Community-2563EB?logo=linux&logoColor=white" alt="LINUX DO"></a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <a href="README.en.md">English</a> | <b>日本語</b> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a>
</p>

**Google Antigravity デスクトップアプリ (2.x)** 専用に設計された、純正デザイン準拠の **「単一セッション・コンテキスト＆生成監視 ＋ アカウント全体のトークン消費・52週ヒートマップ ＋ リアルタイム生成速度ベンチマーク」** 統合可視化スイート。`antigravity-chinese` と同様の **ASAR 直接注入 ＋ CDP による再起動不要の動的マウント** アーキテクチャを採用し、**外部 npm 依存ゼロ**。ワンクリックでの手動導入はもちろん、AI エージェント（Antigravity / Codex / Claude Code / Cursor）に指示するだけで自動セットアップが可能です。

> [!NOTE]
> **ダーク・ライトテーマへの適応について**：  
> 作者が怠け者のため、ライトモード画面のスクリーンショットやデモ動画は用意されていませんが、ライトモードにも完全に適応・最適化されています（Antigravity のテーマに応じて自然に背景・カプセル・パネルが切り替わります）。

---

## 🎬 インターフェース＆操作デモ動画 (Video & Animation Previews)

v2.7 では、すべての操作と機能レイヤーを網羅した 4 本のデモ動画を提供しています：

### 1. セッションコンテキスト監視と詳細監査
> デモ動画ファイル：`01-セッションコンテキスト監視と詳細監査.mp4`

右上タイトルバーのリングカプセルをクリックして「現在の会話コンテキスト」パネルを表示。核心使用量サマリー、リアルタイム生成速度、サーバー返却値とクライアント推定値、画像サイズ（例：`561×179 px`）を含む添付ファイル監査をスクロール確認：

<p align="center">
  <a href="assets/demo-01-context-audit.mp4">
    <img src="assets/demo-01-context-audit.gif" alt="セッションコンテキスト監視と詳細監査" width="760">
  </a>
  <br>
  <sub>🎬 デモアニメーション：コンテキストパネル・速度測定・詳細パラメータ監査 (<a href="assets/demo-01-context-audit.mp4">高画質動画：01-セッションコンテキスト監視と詳細監査.mp4</a>)</sub>
</p>

---

### 2. Token 履歴統計と 52 週ヒートマップ操作
> デモ動画ファイル：`02-Token履歴統計と52週ヒートマップ操作.mp4`

Token 累計カプセルをクリックして「Token 使用量一覧」パネルを開き、累計/本日/当月/年間の4大指標カードや 52 週ヒートマップを確認。マス目間のホバー移動で Prompt / Output / Cache や未来日付ステータスを即座にツールチップ表示：

<p align="center">
  <a href="assets/demo-02-token-heatmap.mp4">
    <img src="assets/demo-02-token-heatmap.gif" alt="Token 履歴統計と 52 週ヒートマップ操作" width="760">
  </a>
  <br>
  <sub>🎬 デモアニメーション：4大使用量カードと 52 週ヒートマップのホバー対話 (<a href="assets/demo-02-token-heatmap.mp4">高画質動画：02-Token履歴統計と52週ヒートマップ操作.mp4</a>)</sub>
</p>

---

### 3. 独立デュアルパネルの切り替えと位置自動調整
> デモ動画ファイル：`03-独立デュアルパネルの切り替えと位置自動調整.mp4`

右側補助バー（レビュー / ファイル / ターミナル）を開いた複雑な画面レイアウトでも、パネルが右端を自動検知して吸着し見切れを防止。上部カプセルをクリックするだけで、2つの独立パネルをスムーズに相互切り替え：

<p align="center">
  <a href="assets/demo-03-panel-switching.mp4">
    <img src="assets/demo-03-panel-switching.gif" alt="独立デュアルパネルの切り替えと位置自動調整" width="760">
  </a>
  <br>
  <sub>🎬 デモアニメーション：右側バー見切れ防止と独立デュアルパネルの切り替え (<a href="assets/demo-03-panel-switching.mp4">高画質動画：03-独立デュアルパネルの切り替えと位置自動調整.mp4</a>)</sub>
</p>

---

### 4. 上部カプセル多段階レスポンシブ折りたたみ
> デモ動画ファイル：`04-上部カプセル多段階レスポンシブ折りたたみ.mp4`

左右両方のサイドバーが展開され中央の表示領域が狭くなった際、タイトルバー右上のカプセル群が自動で 4 段階の滑らかな折りたたみ（テキスト完全表示 → 数値のみ → アイコンリング＋その他メニュー）を実行し、レイアウト崩れを防ぎます：

<p align="center">
  <a href="assets/demo-04-responsive-collapse.mp4">
    <img src="assets/demo-04-responsive-collapse.gif" alt="上部カプセル多段階レスポンシブ折りたたみ" width="760">
  </a>
  <br>
  <sub>🎬 デモアニメーション：タイトルバーカプセル 4 段階折りたたみとコンパクト起動 (<a href="assets/demo-04-responsive-collapse.mp4">高画質動画：04-上部カプセル多段階レスポンシブ折りたたみ.mp4</a>)</sub>
</p>

---

## 📸 スクリーンショットと機能詳細 (Screenshots)

| 01. 会話コンテキストと生成速度 メイン画面 | 02. コンテキスト全展開：外観カスタムと詳細監査 |
| :---: | :---: |
| <img src="assets/panel-context-main.png" alt="会話コンテキストメインビュー" width="460"> | <img src="assets/panel-context-audit-expanded.png" alt="コンテキスト全展開パネル" width="460"> |
| 最上部に **「⭐ 核心使用量サマリー」**（使用済み・上限・残り）と **「⚡ 最新生成速度と所要時間」**（87.6 tok/s、10.12s、TTFT 8.72s、886 tok）を配置。下部には折りたたみ引き出し。 | **「🎨 指標と背景色カスタム」**（0級ダーク背景と各色カスタム）と **「📋 詳細技術パラメータと添付ファイル監査」**（実測値、画像解像度 `561×179 px`、再スキャンボタン）を展開。 |

| 03. タイトルバーリングカプセル・速度とツールチップ | 04. Token 使用量一覧と 5 段階ヒートマップ個別カスタム |
| :---: | :---: |
| <img src="assets/capsule-speed-and-tooltip.png" alt="タイトルバーカプセルとツールチップ" width="460"> | <img src="assets/panel-token-heatmap-customizer.png" alt="Token 使用量一覧とヒートマップ" width="460"> |
| タイトルバーに常駐する進行リングカプセルと ⚡ 速度カプセル（87.6 tok/s）。ホバー時にネイティブ3層ツールチップでパーセントと数値を表示。 | **累計 (Total)・本日 (Today)・当月 (Month)・年間 (Year)** の4大カード。52週ヒートマップ（日別/週別/累計）。下部に **5系統プリセット**、**5段階の単一マス直接カスタム**、**線形補間** を搭載。 |

---

## ✨ 主な機能一覧

1. **タイトルバーリング指標と高速モデル性能監視**：
   - ネイティブダークに溶け込む上部カプセルとホバー展開；
   - 単一会話のコンテキスト消費を可視化する円形リング (`#badge-context`)；
   - TTFT レイテンシ・純ストリーミング速度 (tok/s)・総所要時間を計測する速度カプセル (`#badge-speed`)；
   - 狭小幅でも崩れない 4 段階レスポンシブ折りたたみ。
2. **完全分離型デュアルパネルと見切れ防止吸着**：
   - 会話コンテキストパネルと Token 統計パネルを独立化し、カプセルから即座に切り替え；
   - 右側補助バー展開時に自動で位置を再計算し、画面外へのはみ出しを防止。
3. **会話コンテキスト＆添付ファイル監査 (Panel A)**：
   - 核心使用量速覧（使用済み / 上限 / 残り）；
   - 速度・TTFT・生成時間の測定と効率評価；
   - 画像解像度（例：`561×179 px`）を含むオフィス・PDF・コード添付ファイルの詳細監査；
   - 会話全体の再スキャン機能。
4. **アカウント Token 記録＆ 52 週ヒートマップ (Panel B)**：
   - 累計・本日・当月・年間の4指標（M/B 単位表示）；
   - GitHub スタイルの 52 週ヒートマップと日別・週別・累計推移の切り替え；
   - 5色プリセット、マス目直接クリックによる 5 段階個別カラーピッカー、両端線形補間。
5. **多言語化保護＆再起動不要の CDP 動的マウント**：
   - 既存の漢化パッチや多言語リソースを 100% 保持；
   - Antigravity プロセスを強制終了することなく、CDP 経由で即座にホットリロード。

---

## 🌐 UI 言語の多言語翻訳について (UI Localization)

本プラグインの既定表示は **簡体字中国語** です。UI を日本語や英語などお好みの言語に変更したい場合：

> [!TIP]
> AI エージェントに次のように伝えるだけで自動翻訳・適用されます：  
> **「AGENTS.md を読み込んでインストールし、meter-renderer.js 内の UI テキストを日本語に翻訳してください」**

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
node --test meter-core.test.js meter-renderer.test.js
```
38 件の単体テストすべて合格。

---

## 🤝 コミュニティ

- **[LINUX DO](https://linux.do/)**: LINUX DO コミュニティを応援・支持しています。
