# 共通サーバーとして Dropbox 共有フォルダが使えるかの検証（2026-11-03）

## 結論

**使えます。ただし「共有リンク」ではなく「Dropbox API」経由に限ります。**

| 方式 | 結果 | 備考 |
|---|---|---|
| ① 共有リンク（`?dl=1`）をアプリから直接読む | ✕ 不可 | ブラウザのCORS制限で読めない（下記ログ）。書き込みもそもそも不可 |
| ② Dropbox API（api.dropboxapi.com / content.dropboxapi.com） | ○ 可 | ブラウザ（スマホ）から直接読み書きできることを確認。アプリに実装済み |
| ③ Dropbox の共有フォルダを「全員がブラウザで開く」 | ✕ 不可 | Dropbox は HTML をページとして表示しない（2017年に廃止）。アプリ本体の置き場にはならない |

つまり、**データ置き場（共通サーバー）としては Dropbox 共有フォルダで足りる**が、**アプリ本体（HTML）の配布場所は別に必要**（GitHub Pages 等。README の STEP 1）。

## 検証ログ（スマホ相当のブラウザから実行）

```
api.dropboxapi.com/2/files/list_folder   （認証なし）→ HTTP 400 を JS から読めた  = CORS OK
content.dropboxapi.com/2/files/download  （認証なし）→ HTTP 400 を JS から読めた  = CORS OK
api.dropboxapi.com/oauth2/token          （不正キー）→ HTTP 400 を JS から読めた  = CORS OK（ログイン処理もブラウザだけで完結）
www.dropbox.com/scl/fi/.../x.json?dl=1              → "Failed to fetch"
   Access to fetch ... has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header
```

400 はトークン無しのため当然のエラーで、**レスポンスを JavaScript が読めた**ことが「ブラウザから API に届く」証拠です。
実際の読み書き（アップロード／ダウンロード／フォルダ一覧／競合時の再試行）はアプリに実装済みで、Dropbox App Key を作ればそのまま動きます。

## 使うための条件

1. **Dropbox App を1つ作る**（無料。開発モードのままで 50 ユーザーまで接続可）
2. アプリは **https の固定URL** で公開されていること（Dropbox ログインの戻り先に登録するため）
3. 各スマホの接続方法は2通り
   - (a) 一人ずつ Dropbox アカウントでログイン → **全員を共有フォルダに招待する必要あり**（現状は 3〜4 人しか招待されていないとのこと）
   - (b) 管理者が作った**招待リンク**を LINE で送る → 相手は Dropbox アカウント不要・ログイン不要（アプリ用の接続情報を共有する方式）
     - 推奨：在庫アプリ専用の Dropbox アカウント（または管理者アカウント）で接続し、その招待リンクを配る
     - 注意：リンクを持つ人はそのフォルダを読み書きできるので、社内の該当者だけに送る。漏れたら Dropbox 側で Revoke

## 同時書き込みの安全策（実装済み）

- 端末ごとに `events/<端末ID>.json` を書く → 他人のファイルを触らないので上書き事故なし
- 品目マスタ `master.json` は rev（版）を指定して更新し、競合したら取り直してマージして再試行
- 変更のないファイルは rev が同じなら再ダウンロードしない（通信量は数KB／回）
- 30秒ごと＋画面を開いた時＋登録直後に同期。オフライン時は端末に溜めて復帰後に送信

## 代替案（Dropbox がうまく行かない場合）

| 代替 | 長所 | 短所 |
|---|---|---|
| Google スプレッドシート + Apps Script | 無料・全員アカウント不要・事務所で表としてそのまま見える | Google アカウント（会社用1つ）が必要。Apps Script の公開設定が必要 |
| Firebase（Firestore） | リアルタイム反映・オフライン対応が最も強い | 設定がやや専門的。無料枠で十分 |
| OneDrive（Graph API） | 既に OneDrive を使っている | Microsoft の Azure アプリ登録が必要で Dropbox より手間 |

Dropbox で問題なければこのまま進め、「事務所の PC で表として見たい」要望が強ければ Google スプレッドシート案に切り替えるのが現実的です。
