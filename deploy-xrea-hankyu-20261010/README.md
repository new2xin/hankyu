# XREAでの車両位置表示

公開ページは [阪急 車両位置](https://xn--c5r.jp/hankyu/) です。PHP 8.2以降、cURL拡張、Apacheの `.htaccess` を使用する構成です。

## 表示と通信

車両位置画面は `html`・`head`・`body` の明示的な開始タグと終了タグを含めず、DOCTYPE付きのHTMLとして記述しています。CSSとJavaScriptは相対URLで読み込むため、サイトのサブディレクトリに置いたときも同じ場所を参照します。

ブラウザーから利用するAPIは次の通りです。

- `GET api.php?route=lines`
- `GET api.php?route=positions&line_id=1`（路線IDは1〜10）

PHPが阪急APIへHTTPS接続し、APKに含まれる共通トークンを `x-auth-token` リクエストヘッダーに設定します。トークンはブラウザー向けの画面やAPI応答へは含めません。

## 保存データ

PHPは成功した阪急APIの応答JSONとAPIアクセス記録を保存します。ログは日付ごとのJSON Lines、車両位置は取得ごとに1ファイルのJSONです。保存先へのHTTPアクセスを拒否し、PHP実行ユーザーが書き込めるようにしてください。保存データの自動削除は行いません。

アプリ内部のWebView URL、API認証方式、応答JSONの実例、位置と方向の判定は[解析ノート](../docs/analysis.md)にあります。
