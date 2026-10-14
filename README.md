# sat-logger

SAT の勉強の記録を自動で取る道具です。2 つあります。

| 何 | どこで動く | 何を記録するか |
|---|---|---|
| `bluebook/` | Mac(Bluebook の練習テスト中) | 1 問ごとの **かかった時間・選んだ答え・見直した回数**、問題文と選択肢 |
| `extension/` | Chrome(College Board の Question Bank、Ascent、MyPractice) | 解いた問題と正誤、模試の結果の取り込み |

## 最初に読んでください

- **記録はあなたの分だけ、あなたの場所に入ります。** 記録は `https://teru.page` の受け口に送られ、登録したあなたのアカウントの中にだけ保存されます。ほかの人(作った本人を含む)には見えません。
- **本番の試験では動きません。** Bluebook は本番の試験中に画面を外から読めないようにします。この道具はそれを回避しません。練習テスト(Practice Test)だけが対象です。
- **読むだけです。** クリック、入力、画面の撮影はしません。読むのは「Question 4 of 27」の表示、選択肢の選択状態、問題文の文字です。
- 手元にも記録が残ります(`~/Library/Application Support/sat-logger/visits.jsonl`)。消したければそのファイルを消すだけです。

## 使い始めるまで(Mac の Bluebook の記録)

### 0. 要るもの

- macOS 13 以降の Mac(Apple Silicon でも Intel でも可)
- Command Line Tools(`python3` と `clang`)。ターミナルで次を実行して、ダイアログが出たら「インストール」:
  ```
  xcode-select --install
  ```
- Bluebook(College Board の公式アプリ)

### 1. 受け口に登録して合言葉をもらう

`https://teru.page/sat` を開き、名前・パスワード・招待コード(Teru からもらう)で登録します。登録した直後に **合言葉** が一度だけ表示されるので、控えておきます(あとから見られません。失くしたら登録し直し)。合言葉は他の人に教えないでください。

> Bluebook の記録の受け口(`https://teru.page/sat/bluebook`)は **まだ公開前** です(2026-10-14)。公開されるまで、Bluebook の記録は手元の `visits.jsonl` とキューに溜まり、公開後に自動で送られます。Chrome 拡張の方(下の「Chrome 拡張」)はもう使えます。

### 2. このフォルダを置く

```
cd ~
git clone https://github.com/teru150/sat-logger.git
```

(git が無ければ、GitHub のページの「Code → Download ZIP」で落として `~/sat-logger` という名前で置いても同じです。)

### 3. 設定を書く

```
mkdir -p ~/Library/Application\ Support/sat-logger
cp ~/sat-logger/bluebook/config.example.json ~/Library/Application\ Support/sat-logger/config.json
open -t ~/Library/Application\ Support/sat-logger/config.json
```

開いたファイルの 2 か所を書き換えて保存します。

- `"token"`: 手順 1 でもらった合言葉
- `"src"`: この Mac の呼び名(半角英数とハイフン。例 `my-mac`)

### 4. 一度手で動かして、許可を出す

```
/usr/bin/python3 ~/sat-logger/bluebook/tracker.py
```

初回は画面を読む部品を組み立てる(`clang` が動く)ので 1〜2 分かかります。そのあと `bluebook tracker started` と出ます。

ここで Bluebook を開いて練習テストの問題画面にすると、ターミナルに `bluebook: NOAX` と出ます。これは「画面を読む許可がない」という意味で、最初は必ず出ます。次のとおり許可を出します:

1. システム設定 → プライバシーとセキュリティ → **アクセシビリティ**
2. 鍵を外して `+` を押し、ファイル選択の画面で `⌘⇧G` を押して次を貼る → 開く
   ```
   ~/sat-logger/bluebook/ax_probe
   ```
3. 一覧に `ax_probe` が出て、スイッチがオンになっていることを確かめる

ターミナルに戻って `Ctrl-C` で止め、もう一度同じコマンドで動かします。問題を 1 つ進めると `visit s1 q1 v1 32.0s B` のような行が出れば成功です。`Ctrl-C` で止めます。

> 画面を読む部品(`ax_probe`)を作り直すと、この許可は外れます(macOS の仕様)。`git pull` で更新したあと `NOAX` が出たら、手順 4 の 2 で `−` で消してから `+` で入れ直してください。

### 5. 自動で動くようにする

```
sed -e "s|__ABSOLUTE_HOME__|$HOME|g" -e "s|__USER__|$USER|g" \
  ~/sat-logger/bluebook/jp.sat-logger.bluebook.plist.example \
  > ~/Library/LaunchAgents/jp.sat-logger.bluebook.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/jp.sat-logger.bluebook.plist
```

これで Mac にログインしているあいだは常に動き、Bluebook を前に出したときだけ読みます。動いているかは次で確かめます:

```
launchctl print "gui/$(id -u)/jp.sat-logger.bluebook" | grep state
tail -n 5 ~/Library/Application\ Support/sat-logger/tracker.log
```

### 止めたいとき

- しばらく止める: `launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/jp.sat-logger.bluebook.plist`
- 送るのだけ止める: 設定の `"send": true` を `false` に(手元の記録は続く)
- 完全に消す: 上の bootout のあと、`~/sat-logger`、`~/Library/LaunchAgents/jp.sat-logger.bluebook.plist`、`~/Library/Application Support/sat-logger` を消す。アクセシビリティの一覧から `ax_probe` も消す

## Chrome 拡張(Question Bank・Ascent・MyPractice の記録)

`extension/` が Chrome の拡張機能(v0.7.0)です。

1. `https://teru.page/sat` で登録し、合言葉を控える(上の手順 1 と同じ合言葉です)
2. Chrome で `chrome://extensions` を開き、右上の「デベロッパーモード」をオン → 「パッケージ化されていない拡張機能を読み込む」→ `~/sat-logger/extension` を選ぶ
3. ツールバーの拡張のアイコンを押し、設定に URL = `https://teru.page` と合言葉を貼る
4. Question Bank / Ascent で問題を解くと記録されます。MyPractice の模試の Details を開き「この模試を全部記録」を押すと、模試の結果(正誤・分野)が取り込まれます
5. `https://teru.page/sat` に名前とパスワードで入ると、自分の一覧と模試の結果が見られます

Google Sheet などを自分で作る必要はありません。

## 何が記録されるか(1 行の中身)

問題を 1 回開いて離れるごとに 1 行です。

| 項目 | 意味 |
|---|---|
| `session_start` | そのテストを始めた時刻 |
| `section_index` / `section_kind` / `module` | 何番目のセクションか、RW か Math か、画面の見出し(例 `Section 1, Module 2: Reading and Writing`) |
| `question` / `visit` | 問題番号と、その問題を何回目に開いたか |
| `entered_at` / `seconds` | 開いた時刻と、画面に出ていた秒数(ほかのアプリを見ていた時間は入らない) |
| `choice` / `typed` | 選んだ選択肢(A〜D)、または記述式に打った数 |
| `passage` / `stem` / `choices` | 本文、設問、4 つの選択肢の文字 |

解いた順番は `entered_at` を並べれば分かります(例: 1→4 を解いてから 27→17 に飛ぶ、といった戦略が残ります)。

## よくある質問

- **Bluebook の画面が変わったら?** 読めなくなることがあります。`tracker.log` に `visit` の行が出なくなったら知らせてください。
- **Windows は?** 今は Mac だけです(macOS のアクセシビリティ API を使っているため)。
- **ネットが無いときは?** 行は手元のキューに残り、つながったときに送られます。
- **設定の `reader`?** `probe`(1 秒ごとに読む)が既定です。`watch`(0.15 秒で答えの変更を拾う)は `ax_watch` にも手順 4 と同じ許可が要ります。

## 開発者向け

```
cd ~/sat-logger && /usr/bin/python3 -m unittest discover -s tests
```

画面を読む部品は `bluebook/ax_probe.c`(1 回読み切り)と `bluebook/ax_watch.c`(常駐して答えの変更を即時に拾う)。どちらも初回に `clang` で自動ビルドされます。

## ライセンスと連絡

Teru Iriyama(teru150)が作ったものを、友人向けに試験公開しています。問題は GitHub の Issue か、Teru に直接。
