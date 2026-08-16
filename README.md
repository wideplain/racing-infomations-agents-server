# リアルタイム文字起こし・AI解析システム

Pixel（Android）でオンデバイス音声認識した会話テキストを **音声は送らずテキストだけ** Tailscale 経由で Mac 上のサーバーに蓄積し、必要なタイミングで `codex exec` を実行して要約・解釈・アドバイス・返答案を返すシステム。

```
Pixel (オンデバイスSTT) → Tailscale → Mac (Fastify + SQLite) → codex exec → 解析結果を返却
                                          ↕
                                    ブラウザ（操作UI / 閲覧専用ビュワー）
```

## 主な機能

- **オンデバイス文字起こし**（Android `SpeechRecognizer`、連続認識ループ、音声は端末外に出さない）
- **オフライン耐性**: 電波が悪くても文字起こしは端末に保存され消えない。送信キューは自動リトライ、復帰後に同期
- **AI解析の2モード**
  - 通常モード: 要約 / 解釈 / アドバイス / 返答案
  - **ピットウォールモード**: レース無線のクルーのように「事実・変化・確認質問・軽い提案」を分離。推測で数値を補わず、曖昧なら警告に出して信頼度を下げる。話者に命令しない
- **手動解析 + 自動解析**（時間間隔 / 文字数しきい値でトリガー、別カラムに蓄積）
- **手入力メモを添えた解析**（その回だけ AI に追加コンテキストを渡す）
- **行ごとの編集・アーカイブ**（誤認識の修正、AI解析から除外）
- **閲覧専用ビュワー**（別端末のブラウザから同じセッションをリアルタイムに追える）

## 構成

| ディレクトリ | 内容 |
|---|---|
| `server/` | Node.js + TypeScript + Fastify 5 + better-sqlite3。REST API、Web UI、`codex exec` 連携 |
| `android/` | Kotlin + Jetpack Compose。連続音声認識、セグメント送信、解析 UI |

---

## 必要なもの

- **Mac**: Node.js 20+ / [Codex CLI](https://github.com/openai/codex)（ChatGPT サブスクでログイン済み）/ Tailscale
- **Android**: Pixel など日本語のオンデバイス音声認識が使える端末（Android 12 / API 31 以上）/ Tailscale アプリ
- **Android ビルド用**: JDK 17+、Android SDK、Gradle 8.x 以上

---

## 1. Tailscale のセットアップ

サーバーをインターネットに公開せず、自分のデバイス間だけで繋ぐために Tailscale を使います。

1. [Tailscale](https://tailscale.com/) にサインアップし、管理画面の **DNS タブで MagicDNS を有効化**
2. **Mac**:
   ```bash
   brew install tailscale   # または App Store 版
   tailscale up             # ブラウザが開くのでログイン
   tailscale status         # 自分のマシン名と 100.x.x.x のIPを確認
   ```
   出力例:
   ```
   100.x.y.z   my-mac   you@   macOS   -
   ```
   → MagicDNS 名は `<マシン名>.<tailnet名>.ts.net`、IP は `100.x.y.z`
3. **Android**: Play ストアから Tailscale アプリを入れて同じアカウントでログイン。VPN 常時接続を許可し、バッテリー最適化から除外しておく

### 接続先の指定方法（MagicDNS 名 と IP）

| 方法 | 例 | 備考 |
|---|---|---|
| MagicDNS 名 | `http://my-mac.tailXXXX.ts.net:8787` | 読みやすい。DNS 設定が反映されている必要あり |
| **tailnet IP** | `http://100.x.y.z:8787` | **名前解決を経由しないので確実**。MagicDNS が効かない端末（iOS で稀に発生）はこちら |

`ERR_NAME_NOT_RESOLVED` が出る場合は、まず Tailscale アプリの VPN を OFF→ON して MagicDNS の名前解決をやり直してください（IP フォールバックは HTTPS では使えないため、下記の HTTPS 経路を使う場合は名前解決を直すのが正攻法です）。

> ⚠️ 素の HTTP（`https` ではない）でアクセスする場合、ブラウザのアドレスバーには **必ず `http://` を明示**してください。省略すると HTTPS で接続を試みて失敗します。

### HTTPS でのアクセス（推奨・ブラウザのビュワーはこちら）

tailnet には最初から HTTPS 証明書が発行されています（`tailscale status --json` の `CertDomains` に `<マシン名>.<tailnet名>.ts.net` が出ていれば利用可能）。**ブラウザの Geolocation API は非セキュアな HTTP オリジンでは動作しない**ため、ビュワーで位置情報系の機能を使うなら HTTPS 必須です。`tailscale serve` で 8787 番のサーバーを HTTPS 化して公開します（443 番が他プロジェクトで使用中の場合は空いている番号、例えば 8443 を使う）:

```bash
tailscale serve --bg --https=8443 http://localhost:8787
```

公開されたURL: `https://<マシン名>.<tailnet名>.ts.net:8443/viewer.html?session=latest`

確認・停止:
```bash
tailscale serve status          # 公開状況を確認
tailscale serve --https=8443 off  # 停止
```

- HTTPS は tailnet 内のみに公開され、インターネットには一切露出しません。
- **HTTPS は MagicDNS 名にのみ証明書が紐づくため、`https://100.x.y.z:8787` のような tailnet IP フォールバックは使えません。** IP でしかアクセスできない端末は、上記の通り名前解決を直すか、素の HTTP（8787番、下記）を使ってください。
- Android アプリはブラウザの Geolocation 制約を受けないため、引き続き素の HTTP（`http://<tailnet-ip>:8787`）で問題ありません。

---

## 2. サーバーの起動

```bash
cd server
npm install
cp .env.example .env       # 必要に応じて編集
npm run build              # TypeScript をビルド
npm start                  # http://0.0.0.0:8787 で起動
```

開発中（ファイル変更を監視して自動再起動）:
```bash
npm run dev
```

### `.env` の設定

| 変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `8787` | 待ち受けポート |
| `HOST` | `0.0.0.0` | tailnet からアクセスするため全インターフェースで待ち受け |
| `API_KEY` | (空) | 空なら API キー認証を無効化。設定すると全 `/api` に `X-Api-Key` ヘッダーが必要 |
| `DB_PATH` | `./data/app.db` | SQLite ファイル |
| `AI_PROVIDER` | `codex` | `codex` / `claude`（Claude はスタブ） |
| `CODEX_BIN` | `codex` | codex の実行パス。**launchd 等で常駐させる場合は絶対パス推奨** |
| `ANALYZE_TIMEOUT_MS` | `120000` | 解析のタイムアウト |
| `CODEX_HOME` | (空) | codex の認証情報の場所（既定 `~/.codex`）。常駐運用時は明示推奨 |

### 動作確認

```bash
curl http://localhost:8787/healthz          # => {"ok":true}
```

ブラウザで `http://localhost:8787/` を開くと操作用 UI が使えます。Android アプリなしでもテキストを打ち込んで AI解析まで一通り試せます。

### テスト

```bash
npm test          # 全自動テスト（codex はフェイクスクリプトで代替、33件）
npm run test:live # 実 codex を1回叩くスモークテスト（手動実行）
```

---

## 3. Android アプリのビルド

```bash
cd android

# 初回のみ: Gradle wrapper を用意
mv gradle/wrapper/wrapper.properties.tmp gradle/wrapper/gradle-wrapper.properties
chmod +x gradlew
gradle wrapper --gradle-version 8.7   # システムの Gradle 8.x/9.x を使用

# ビルド
./gradlew :app:assembleDebug
# または wrapper を使わずシステムの gradle で
gradle :app:assembleDebug

# 端末にインストール
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`android/local.properties` に Android SDK のパスが必要です（Android Studio で開けば自動生成されます）:
```
sdk.dir=/Users/<あなた>/Library/Android/sdk
```

### アプリの初期設定

1. アプリを起動し、右上の⚙から**サーバーURL**を入力
   - 例: `http://100.x.y.z:8787` （IP 指定が確実）
   - `API_KEY` を設定した場合は API キー欄にも入力
2. マイクと通知の権限を許可
3. 「Start」で文字起こし開始

> HTTP 通信は `ts.net` ドメイン向けにのみ許可されています（`network_security_config.xml`）。IP 直打ちで繋がらない場合は、その IP を同ファイルの許可リストに追加してください。

---

## 4. 閲覧専用ビュワー

別の端末（PC・タブレット）から、操作せずに会話と解析だけをリアルタイムで眺められます。

- アプリの **「👁 共有」** ボタンでビュワー URL がクリップボードにコピーされます
- 操作用 UI（`http://<サーバー>:8787/`）のセッション一覧からも「👁 ビュワー」で開けます
- URL 形式（HTTP）: `http://<サーバー>:8787/viewer.html?session=<セッションID>`
- URL 形式（HTTPS・推奨、位置情報を使う場合は必須）: `https://<マシン名>.<tailnet名>.ts.net:8443/viewer.html?session=<セッションID>`（`tailscale serve` のセットアップは上記「1. Tailscale のセットアップ」参照）

PC では左右2カラム、モバイルでは上下2段（それぞれ独立スクロール）で画面いっぱいに表示され、文字起こし・解析タイムラインはアコーディオンで折りたためます。

---

## 使い方の流れ

1. アプリで「Start」→ 会話が文字起こしされ、サーバーに送信される（グレー=送信待ち、通常色=同期済み）
2. 必要なタイミングで **「AI解析」** を押す。または設定で**自動解析**を有効にすると、一定時間・一定文字数ごとに自動実行
3. 誤認識は行を**長押し**して修正、AI に見せたくない行はアーカイブ（🗄 取り消し線表示、解析対象から除外）
4. 特定の観点で見てほしいときは **「📝 メモを添えて解析」** で追加指示を渡す
5. 別端末のブラウザでビュワーを開けば、同じ内容を並走して確認できる

---

## 設計思想

音声を AI に常時聞かせるのではなく、**Listening Layer（認識・蓄積）と Reasoning Layer（解析）を分離**しています。文字起こしは常に走らせつつ、AI が動くのは必要な瞬間だけです。

ピットウォールモードは [pitwall-ai-race-radio](https://github.com/241-hub/pitwall-ai-race-radio) の思想を取り入れたもので、**AI は指揮者ではなく、事実を整理して人間の判断を支える無線係**として振る舞います。

---

## 既知の制約

- **LINE 等の通話音声は他アプリから取得できません**（Android のマイク占有・通話音声キャプチャ制限）。通話しながら使う場合は2台構成（通話端末をスピーカーにして、もう1台で周囲音を文字起こし）
- 話者分離は未対応
- 文字起こしは平文の SQLite（`server/data/app.db`）に保存されます
- サーバー自体は HTTP（8787番）で待ち受けます。ブラウザから使う場合は `tailscale serve` 経由の HTTPS（上記）が推奨、Android アプリは HTTP のままで問題ありません。どちらも tailnet 内でのみ利用する前提です

## ライセンス

MIT
