# Antigravity コンテキスト・トークンビューアー

[简体中文](README.md) · [English](README.en.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md)

Google Antigravity 2.x のツールバーで、会話のコンテキスト使用量、モデルの応答速度、デスクトップと CLI のトークン使用量を確認できます。

## 機能

- **コンテキストと応答速度**. 使用量、モデルの上限、最初のトークンまでの時間（TTFT）、出力速度、生成時間を表示します。サーバーの実測値とローカルの推定値を分けて表示します。
- **会話の詳細**. プロンプト、応答、思考、ツール、添付ファイルの内訳を確認できます。添付ファイルの推定値や読み取り範囲、取得できる画像の寸法も表示します。コンテキスト超過、レート制限、通信エラーなどを区別します。
- **トークン履歴**. 読み取れるローカルのデスクトップと CLI の使用量を集計し、利用元で絞り込めます。日・週・月・年・累計のグラフを切り替えられます。
- **API 参考額とサブスクリプション**. 対応する料金で入力・キャッシュ・出力の費用を推定し、算出できない使用量も表示します。地域別参考価格や実際の支払額との比較、通貨選択、人民元換算に対応します。推定額は比較用です。実際の請求はサービス提供元で確認してください。
- **外観**. ツールバーは空き幅に合わせて縮まり、各パネルを個別に開けます。ライト・ダークテーマやヒートマップの配色を変更できます。
- **CLI とアップデート**. インストール済みの CLI をツールバーから起動します。利用できる場合は現在の作業フォルダとプロキシを引き継ぎます。パネルで更新を確認でき、インストーラーはバックアップ、整合性検証、復元に対応します。

## 表示言語

5つの言語版は README の翻訳です。UI の既定言語は簡体字中国語で、アプリ内に言語切替はありません。他の言語で使うには、[AGENTS.md](AGENTS.md) に従って `src/renderer/` の表示文言を翻訳し、再ビルドしてインストールしてください。

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

---

## 🙌 コントリビューター

GitHub Release でクレジットされた 35 名のコミュニティコントリビューターです。バージョン別の一覧は [CONTRIBUTORS.md](CONTRIBUTORS.md) にまとめています。

<p align="left">
  <a href="https://github.com/elviscjn-cjn" title="elviscjn-cjn · 作者 / author"><img src="https://github.com/elviscjn-cjn.png?size=96" width="48" height="48" alt="@elviscjn-cjn"></a>
  <a href="https://github.com/Tswatery" title="Tswatery · v0.8.8-rc.1"><img src="https://github.com/Tswatery.png?size=96" width="48" height="48" alt="@Tswatery"></a>
  <a href="https://github.com/Kisaragi-Mio-0127" title="Kisaragi-Mio-0127 · v0.8.9"><img src="https://github.com/Kisaragi-Mio-0127.png?size=96" width="48" height="48" alt="@Kisaragi-Mio-0127"></a>
  <a href="https://github.com/feizaodemon" title="feizaodemon · v0.8.9"><img src="https://github.com/feizaodemon.png?size=96" width="48" height="48" alt="@feizaodemon"></a>
  <a href="https://github.com/yuanyang749" title="yuanyang749 · v0.8.9"><img src="https://github.com/yuanyang749.png?size=96" width="48" height="48" alt="@yuanyang749"></a>
  <a href="https://github.com/JYPYYy" title="JYPYYy · v0.8.6"><img src="https://github.com/JYPYYy.png?size=96" width="48" height="48" alt="@JYPYYy"></a>
  <a href="https://github.com/Nymph-Beta" title="Nymph-Beta · v0.8.9"><img src="https://github.com/Nymph-Beta.png?size=96" width="48" height="48" alt="@Nymph-Beta"></a>
  <a href="https://github.com/Fengsuid" title="Fengsuid · v0.9.0"><img src="https://github.com/Fengsuid.png?size=96" width="48" height="48" alt="@Fengsuid"></a>
  <a href="https://github.com/lllhhhh" title="lllhhhh · v0.9.0"><img src="https://github.com/lllhhhh.png?size=96" width="48" height="48" alt="@lllhhhh"></a>
  <a href="https://github.com/Staaaying" title="Staaaying · v0.9.0"><img src="https://github.com/Staaaying.png?size=96" width="48" height="48" alt="@Staaaying"></a>
  <a href="https://github.com/XiangZheng2283" title="XiangZheng2283 · v0.9.0"><img src="https://github.com/XiangZheng2283.png?size=96" width="48" height="48" alt="@XiangZheng2283"></a>
  <a href="https://github.com/x1051445024" title="x1051445024 · v0.8.1"><img src="https://github.com/x1051445024.png?size=96" width="48" height="48" alt="@x1051445024"></a>
  <a href="https://github.com/Hirasawa8" title="Hirasawa8 · v0.9.0"><img src="https://github.com/Hirasawa8.png?size=96" width="48" height="48" alt="@Hirasawa8"></a>
  <a href="https://github.com/shixin08052" title="shixin08052 · v0.9.0"><img src="https://github.com/shixin08052.png?size=96" width="48" height="48" alt="@shixin08052"></a>
  <a href="https://github.com/Xuhang0607" title="Xuhang0607 · v0.9.0"><img src="https://github.com/Xuhang0607.png?size=96" width="48" height="48" alt="@Xuhang0607"></a>
  <a href="https://github.com/Jemiking" title="Jemiking · v0.8.10"><img src="https://github.com/Jemiking.png?size=96" width="48" height="48" alt="@Jemiking"></a>
  <a href="https://github.com/awu5425" title="awu5425 · v0.9.0"><img src="https://github.com/awu5425.png?size=96" width="48" height="48" alt="@awu5425"></a>
  <a href="https://github.com/LC9999216" title="LC9999216 · v0.9.0"><img src="https://github.com/LC9999216.png?size=96" width="48" height="48" alt="@LC9999216"></a>
  <a href="https://github.com/locking-main-163" title="locking-main-163 · v0.8.10"><img src="https://github.com/locking-main-163.png?size=96" width="48" height="48" alt="@locking-main-163"></a>
  <a href="https://github.com/Lopution" title="Lopution · v0.8.8"><img src="https://github.com/Lopution.png?size=96" width="48" height="48" alt="@Lopution"></a>
  <a href="https://github.com/huron09280" title="huron09280 · v0.8.8-rc.1"><img src="https://github.com/huron09280.png?size=96" width="48" height="48" alt="@huron09280"></a>
  <a href="https://github.com/kyrie21z" title="kyrie21z · v0.8.8"><img src="https://github.com/kyrie21z.png?size=96" width="48" height="48" alt="@kyrie21z"></a>
  <a href="https://github.com/startips" title="startips · v0.8.8-rc.1"><img src="https://github.com/startips.png?size=96" width="48" height="48" alt="@startips"></a>
  <a href="https://github.com/nokiy" title="nokiy · v0.8.4"><img src="https://github.com/nokiy.png?size=96" width="48" height="48" alt="@nokiy"></a>
  <a href="https://github.com/Azreal2021" title="Azreal2021 · v0.8.4"><img src="https://github.com/Azreal2021.png?size=96" width="48" height="48" alt="@Azreal2021"></a>
  <a href="https://github.com/MoiraToki" title="MoiraToki · v0.8.4"><img src="https://github.com/MoiraToki.png?size=96" width="48" height="48" alt="@MoiraToki"></a>
  <a href="https://github.com/yinshengphy" title="yinshengphy · v0.8.4"><img src="https://github.com/yinshengphy.png?size=96" width="48" height="48" alt="@yinshengphy"></a>
  <a href="https://github.com/Andrew-liu" title="Andrew-liu · v0.8.4"><img src="https://github.com/Andrew-liu.png?size=96" width="48" height="48" alt="@Andrew-liu"></a>
  <a href="https://github.com/nocoo" title="nocoo · v0.8.4"><img src="https://github.com/nocoo.png?size=96" width="48" height="48" alt="@nocoo"></a>
  <a href="https://github.com/U1tr0n-Lee" title="U1tr0n-Lee · v0.8.4"><img src="https://github.com/U1tr0n-Lee.png?size=96" width="48" height="48" alt="@U1tr0n-Lee"></a>
  <a href="https://github.com/zhao33079-zhao" title="zhao33079-zhao · v0.8.4"><img src="https://github.com/zhao33079-zhao.png?size=96" width="48" height="48" alt="@zhao33079-zhao"></a>
  <a href="https://github.com/git-aa12138" title="git-aa12138 · v0.8.4"><img src="https://github.com/git-aa12138.png?size=96" width="48" height="48" alt="@git-aa12138"></a>
  <a href="https://github.com/anyu0804" title="anyu0804 · v0.8.3"><img src="https://github.com/anyu0804.png?size=96" width="48" height="48" alt="@anyu0804"></a>
  <a href="https://github.com/Jia131313" title="Jia131313 · v0.8.3"><img src="https://github.com/Jia131313.png?size=96" width="48" height="48" alt="@Jia131313"></a>
  <a href="https://github.com/joyshan1986" title="joyshan1986 · v0.8.3"><img src="https://github.com/joyshan1986.png?size=96" width="48" height="48" alt="@joyshan1986"></a>
  <a href="https://github.com/riandycandra" title="riandycandra · v0.8.4"><img src="https://github.com/riandycandra.png?size=96" width="48" height="48" alt="@riandycandra"></a>
</p>
