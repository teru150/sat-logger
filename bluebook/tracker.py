#!/usr/bin/env python3
"""sat-logger / bluebook: Bluebook の練習テストで、1 問ごとの「かかった時間」と「選んだ答え」を記録する。

Bluebook の練習テスト(Practice Test)は画面がロックされないので、macOS の
アクセシビリティ API で「Question 4 of 27」の表示と選択肢の選択状態が読める。
この道具はそれを読むだけで、クリックも入力も画面の撮影もしない。本番の試験では
動かない(ロックされる)し、動かそうとしない。

- 1 問を開いてから離れるまでが 1 行(visit)。離れる = 番号が変わる、Bluebook が
  後ろに行く、問題画面でなくなる。秒数は画面に出ていた時間だけ。
- 行は config.json の url へ POST する(Authorization: Bearer <合言葉>)。失敗した
  行はキューに残して後で送り直す。手元の記録は visits.jsonl に全部残る。
- セクション: 総数が変わった時(27 = Reading and Writing、22 = Math)か、問題画面で
  ない画面のあとに問題 1 が出た時に +1。セッション: 15 分問題を見なければ終わり。

設定 ~/Library/Application Support/sat-logger/config.json(config.example.json を参照):
  url, token, src, reader ("watch" か "probe"), send, poll_seconds, session_gap_minutes
起動は LaunchAgent(jp.sat-logger.bluebook.plist.example)。手動なら
  /usr/bin/python3 bluebook/tracker.py
  tracker.py --summary FILE.jsonl  1 問ごとの表 / --flush 今すぐ送る / --resend FILE.jsonl
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path


# --------------------------------------------------------------------------- #
# small helpers (time, lid, sending)
# --------------------------------------------------------------------------- #

PERMANENT_REJECTIONS = ("server_error=invalid_input",)
CLAMSHELL_RE = re.compile(r'"AppleClamshellState"\s*=\s*(Yes|No)')


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value):
    try:
        return datetime.strptime(str(value), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def lid_closed():
    """True when the MacBook lid is shut (nothing is read then); None if unknown."""
    try:
        result = subprocess.run(["/usr/sbin/ioreg", "-r", "-k", "AppleClamshellState", "-d", "1"],
                                capture_output=True, text=True, timeout=8, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    match = CLAMSHELL_RE.search(result.stdout)
    return None if match is None else match.group(1) == "Yes"


def post_row(url: str, token: str, payload: dict) -> tuple:
    """POST one row. The token travels in a header read from stdin, never in argv.
    Only a 2xx with a body {"ok": true} counts as delivered."""
    try:
        result = subprocess.run(
            ["/usr/bin/curl", "--silent", "--show-error", "--fail-with-body",
             "--connect-timeout", "10", "--max-time", "25",
             "--header", "Content-Type: application/json; charset=utf-8",
             "--header", "@-", "--data-binary", json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
             url],
            input=f"Authorization: Bearer {token}", text=True, capture_output=True, timeout=35, check=False)
    except subprocess.TimeoutExpired:
        return False, "curl_timeout"
    except OSError as exc:
        return False, f"curl_spawn_failed={str(exc)[:60]}"
    if result.returncode != 0:
        return False, f"curl_exit={result.returncode}"
    try:
        body = json.loads(result.stdout)
    except (TypeError, ValueError):
        return False, "bad_response"
    if isinstance(body, dict) and body.get("ok") is True:
        return True, "ok"
    reason = body.get("reason") or body.get("error") if isinstance(body, dict) else None
    code = reason if isinstance(reason, str) and re.fullmatch(r"[a-z_]{1,40}", reason) else "unknown"
    return False, f"server_error={code}"

HERE = Path(__file__).resolve().parent
PROBE_SRC = HERE / "ax_probe.c"
PROBE_BIN = HERE / "ax_probe"
WATCH_SRC = HERE / "ax_watch.c"
WATCH_BIN = HERE / "ax_watch"
RUNTIME = Path.home() / "Library/Application Support/sat-logger"
CONFIG = RUNTIME / "config.json"
STATE = RUNTIME / "state.json"
QUEUE = RUNTIME / "queue.jsonl"
BAD = RUNTIME / "queue.bad.jsonl"
RECORDING = RUNTIME / "visits.jsonl"

DEFAULT_CONFIG = {
    "url": "https://teru.page/sat/bluebook",
    "token": "",                # teru.page/sat で登録してもらう合言葉
    "src": "",                  # この Mac の呼び名(例: "my-mac")
    "send": True,
    "reader": "probe",          # "watch" = streaming ax_watch (answers caught within 0.15 s)
    "poll_seconds": 2.0,
    "idle_poll_seconds": 5.0,
    "session_gap_minutes": 15,
    "flush_every_seconds": 30,
}
SECTION_KINDS = {27: "RW", 22: "Math"}
MAX_SECONDS = 3600                      # the receiver rejects longer visits
NAV_RE = re.compile(r"Question Navigator Question (\d+) of (\d+)")
OPTION_RE = re.compile(r"option ([A-D])\b\s*(.*)$")
# Screen furniture that is not part of the question (seen 2026-10-13).
CHROME_RE = re.compile(
    r"^(?:[A-D]|\d{1,3}|:|\d{1,2}:\d\d(?::\d\d)?|Question(?: \d+)?(?: of \d+)?|Next|Back|More|Directions|Hide|Show"
    r"|Section \d+(?:, Module \d+)?:.*|THIS IS A (?:TEST PREVIEW|PRACTICE TEST)|Passage, image, or other source content|Bluebook Exams"
    r"|Terumasa Iriyama|Mark for Review|Highlights & Notes|Calculator|Reference)$", re.I)
PASSAGE_MAX = 1400         # sent row: the receiver's whole body must stay under 4096 bytes
STEM_MAX = 700
TYPED_RE = re.compile(r"^-?\d+(?:\.\d+)?$|^-?\d+/\d+$")   # what the receiver accepts
US = "\x1f"


# --------------------------------------------------------------------------- #
# reading the screen
# --------------------------------------------------------------------------- #

def ensure_built(src: Path, binary: Path) -> None:
    """Build once. NOTE: a rebuilt binary loses its Accessibility grant until it
    is removed and re-added in System Settings, so the sources are not edited
    casually (2026-10-13)."""
    if binary.exists() and binary.stat().st_mtime >= src.stat().st_mtime:
        return
    subprocess.run(["clang", "-O2", "-framework", "ApplicationServices",
                    "-o", str(binary), str(src)], check=True)


def ensure_probe() -> None:
    ensure_built(PROBE_SRC, PROBE_BIN)


def probe() -> str:
    """Raw element lines, or one of NOPROC / BACK / NOWIN / NOAX / ERROR ..."""
    pid = subprocess.run(["/usr/bin/pgrep", "-x", "Bluebook"], capture_output=True,
                         text=True, check=False).stdout.split()
    if not pid:
        return "NOPROC"
    try:
        result = subprocess.run([str(PROBE_BIN), pid[0]], text=True,
                                capture_output=True, timeout=10, check=False)
    except subprocess.TimeoutExpired:
        return "ERROR probe timed out"
    if result.returncode != 0:
        return "ERROR " + result.stderr.strip()[:200]
    return result.stdout


def parse(raw: str):
    """None when Bluebook is not showing a question (or not in front);
    otherwise {'question', 'total', 'choice', 'typed'}."""
    if raw.startswith(("NOPROC", "BACK", "NOWIN", "NOAX", "ERROR")):
        return None
    snap = {"question": None, "total": None, "choice": None, "typed": None,
            "choices": {}, "texts": []}
    for line in raw.splitlines():
        parts = line.split(US)
        if len(parts) != 3:
            continue
        role, desc, value = parts
        nav = NAV_RE.search(desc)
        if nav:
            snap["question"], snap["total"] = int(nav.group(1)), int(nav.group(2))
        elif role == "AXRadioButton":
            opt = OPTION_RE.match(desc)
            if opt:
                if opt.group(2).strip():
                    snap["choices"][opt.group(1)] = opt.group(2).strip()[:400]
                if value.strip() in ("1", "true"):
                    snap["choice"] = opt.group(1)
        elif role == "AXStaticText":
            text = (value or desc).strip()
            if text:
                snap["texts"].append(text)
        elif role == "AXTextField":
            text = value.strip().replace(" ", "")
            if TYPED_RE.match(text):
                snap["typed"] = text[:20]       # Math student-produced response
    return snap if snap["question"] is not None else None


class Watch:
    """ax_watch as a child process: full snapshot blocks (S … E) about once a
    second and D lines the moment an answer or the question number changes."""

    def __init__(self):
        self.proc = None
        self.lines = []
        self.lock = __import__("threading").Lock()

    def start(self, pid: str) -> None:
        self.stop()
        self.proc = subprocess.Popen([str(WATCH_BIN), pid], stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, bufsize=1)
        thread = __import__("threading").Thread(target=self._pump, daemon=True)
        thread.start()

    def _pump(self) -> None:
        proc = self.proc
        for line in proc.stdout:
            with self.lock:
                self.lines.append(line.rstrip("\n"))
        with self.lock:
            self.lines.append("EXIT")

    def drain(self) -> list:
        with self.lock:
            out, self.lines = self.lines, []
        return out

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None


def apply_delta(tracker, line: str, at: datetime) -> None:
    """A D line from ax_watch: option radio / text field / navigator change."""
    parts = line.split(US)
    if len(parts) != 3 or tracker.current is None:
        return
    _, desc, value = parts
    if desc == "nav":
        nav = NAV_RE.search(value)
        if nav and int(nav.group(1)) != tracker.current["question"]:
            tracker.close(at)             # the next snapshot opens the new visit
        return
    opt = OPTION_RE.match(desc)
    if opt:
        if value.strip() in ("1", "true"):
            tracker.current["choice"] = opt.group(1)
        return
    text = value.strip().replace(" ", "")
    if TYPED_RE.match(text):
        tracker.current["typed"] = text[:20]


# --------------------------------------------------------------------------- #
# files
# --------------------------------------------------------------------------- #

def load_json(path: Path, default):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, type(default)) else default
    except (OSError, ValueError):
        return default


def save_json(path: Path, value) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def load_config() -> dict:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    os.chmod(RUNTIME, 0o700)
    if not CONFIG.exists():
        save_json(CONFIG, DEFAULT_CONFIG)
    config = dict(DEFAULT_CONFIG)
    config.update(load_json(CONFIG, {}))
    return config


def append_jsonl(path: Path, row: dict) -> None:
    with path.open("a", encoding="utf-8") as out:
        out.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        out.flush()
        os.fsync(out.fileno())
    os.chmod(path, 0o600)


def read_jsonl(path: Path) -> list:
    rows = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    append_jsonl(BAD, {"bad_line": line[:500]})
    except OSError:
        pass
    return rows


def write_jsonl(path: Path, rows: list) -> None:
    tmp = path.with_suffix(".jsonl.tmp")
    with tmp.open("w", encoding="utf-8") as out:
        for row in rows:
            out.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        out.flush()
        os.fsync(out.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def now() -> datetime:
    return datetime.now(timezone.utc)


def parse_any_iso(value):
    """ISO time with Z or an offset (the first version wrote +00:00); None otherwise."""
    moment = parse_iso(value)
    if moment is not None:
        return moment
    try:
        moment = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return moment.astimezone(timezone.utc) if moment.tzinfo else None


def log(message: str) -> None:
    print(f"{iso(now())} {message}", flush=True)


# --------------------------------------------------------------------------- #
# sessions, sections, visits
# --------------------------------------------------------------------------- #

class Tracker:
    """Turns snapshots into rows. `state` is a plain dict that the caller
    persists, so a restarted daemon continues the same session."""

    def __init__(self, state: dict, emit, gap_minutes: int = 15):
        self.state = state
        self.emit = emit
        self.gap = timedelta(minutes=gap_minutes)
        self.current = None     # {"section_index","question","entered_at","choice","typed"}
        self.gap_seen = True    # a screen without a question was seen since the last question

    def feed(self, snap, at: datetime) -> None:
        last_seen = parse_iso(self.state.get("last_seen_at"))
        if snap is None:
            self.close(at)
            self.gap_seen = True
            if last_seen and at - last_seen > self.gap:
                self.end_session()
            return

        if not self.state.get("session_start") or (last_seen and at - last_seen > self.gap):
            self.end_session()
            self.state.update({"session_start": iso(at), "section_index": 0,
                               "section_total": None, "last_question": None, "visits": {}})
            log(f"session_start {self.state['session_start']}")

        new_section = (snap["total"] != self.state.get("section_total")
                       or (snap["question"] == 1 and self.gap_seen
                           and (self.state.get("last_question") or 0) >= 2))
        if new_section:
            self.close(at)
            self.state["section_index"] = (self.state.get("section_index") or 0) + 1
            self.state["section_total"] = snap["total"]
            log(f"section {self.state['section_index']} of {snap['total']} "
                f"({SECTION_KINDS.get(snap['total']) or '?'})")

        key = (self.state["section_index"], snap["question"])
        if self.current is None or (self.current["section_index"], self.current["question"]) != key:
            self.close(at)
            self.current = {"section_index": key[0], "question": key[1], "entered_at": at,
                            "choice": None, "typed": None, "texts": [], "choices": {}}
        self.current["choice"] = snap["choice"]
        self.current["typed"] = snap["typed"]
        # Keep the fullest reading of the screen seen during the visit.
        if len(snap.get("texts") or []) > len(self.current["texts"]):
            self.current["texts"] = list(snap["texts"])
        if len(snap.get("choices") or {}) > len(self.current["choices"]):
            self.current["choices"] = dict(snap["choices"])
        self.state["last_question"] = snap["question"]
        self.state["last_seen_at"] = iso(at)
        self.gap_seen = False

    def close(self, at: datetime) -> None:
        if self.current is None:
            return
        cur, self.current = self.current, None
        seconds = min(round((at - cur["entered_at"]).total_seconds(), 1), MAX_SECONDS)
        if seconds < 0.5:
            return
        counts = self.state.setdefault("visits", {}).setdefault(str(cur["section_index"]), {})
        visit = counts.get(str(cur["question"]), 0) + 1
        counts[str(cur["question"])] = visit
        total = self.state.get("section_total")
        passage, stem = question_text(cur["texts"], cur["choices"])
        self.emit({
            "kind": "bluebook", "event_id": str(uuid.uuid4()),
            "session_start": self.state.get("session_start"),
            "section_index": cur["section_index"], "section_total": total,
            "section_kind": SECTION_KINDS.get(total),
            "question": cur["question"], "visit": visit,
            "entered_at": iso(cur["entered_at"]), "seconds": seconds,
            "choice": cur["choice"], "typed": cur["typed"],
            # Question text (Teru 16:3x). Underline / bold / italic ranges are not
            # read yet, so the position of an underlined sentence is unknown.
            "module": module_label(cur["texts"]),
            "passage": passage, "stem": stem,
            "choices": cur["choices"] or None,
            "underline_lost": True,
        })

    def end_session(self) -> None:
        if self.state.get("session_start"):
            log(f"session_end {self.state['session_start']}")
        for key in ("session_start", "section_index", "section_total", "last_question",
                    "last_seen_at", "visits"):
            self.state.pop(key, None)


# --------------------------------------------------------------------------- #
# sending
# --------------------------------------------------------------------------- #

MODULE_RE = re.compile(r"^Section \d+(?:, Module \d+)?: .+$")


def module_label(texts: list):
    """'Section 1, Module 2: Reading and Writing' when the screen shows it."""
    for text in texts:
        if MODULE_RE.match(text.strip()):
            return text.strip()[:80]
    return None


def question_text(texts: list, choices: dict) -> tuple:
    """(passage, stem) from the static texts of one question screen.
    Everything before the "Question" / number marker is the passage; after it is
    the question stem. Screen furniture and the four choice texts are dropped,
    fragments are joined with spaces, and the blank in a fill-in reads ______."""
    choice_texts = {v.strip() for v in (choices or {}).values()}
    marker = None
    for i, text in enumerate(texts):
        if text.strip().lower() == "question" and i + 1 < len(texts) and texts[i + 1].strip().isdigit():
            marker = i
            break
    before = texts if marker is None else texts[:marker]
    after = [] if marker is None else texts[marker + 2:]

    def clean(parts):
        kept = []
        for text in parts:
            text = text.strip()
            if not text or CHROME_RE.match(text) or NAV_RE.search(text) or text in choice_texts:
                continue
            kept.append("______" if text.lower() == "blank" else text)
        joined = " ".join(kept)
        return re.sub(r"\s+([,.;:!?)])", r"\1", re.sub(r"\s{2,}", " ", joined)).strip()
    passage, stem = clean(before), clean(after)
    if marker is None:                   # no marker: keep everything as the stem
        passage, stem = "", passage
    return passage, stem


def trim_for_send(row: dict) -> dict:
    """Same row with the stem cut to STEM_MAX characters (flag set when cut)."""
    out = dict(row)
    passage, stem = out.get("passage") or "", out.get("stem") or ""
    out["stem_truncated"] = len(stem) > STEM_MAX or len(passage) > PASSAGE_MAX
    out["passage"], out["stem"] = passage[:PASSAGE_MAX], stem[:STEM_MAX]
    return out


def flush(config: dict) -> None:
    """Send queued rows oldest first with the current token; stop at the first
    failure. A row the receiver rejects as invalid_input is moved to queue.bad."""
    if not config.get("send"):
        return
    rows = read_jsonl(QUEUE)
    if not rows:
        return
    url, token, src = config.get("url") or "", config.get("token") or "", config.get("src") or "mac"
    if not url.startswith("https://") or not token:
        return                                 # not set up yet: rows wait in the queue
    sent, remaining = 0, list(rows)
    for row in rows:
        ok, detail = post_row(url, token, dict(row, src=src))
        if not ok and detail not in PERMANENT_REJECTIONS:
            log(f"send_stopped sent={sent} remaining={len(remaining)} {detail}")
            break
        if not ok:
            append_jsonl(BAD, row)
            log(f"rejected s{row.get('section_index')} q{row.get('question')} {detail}")
        remaining.pop(0)
        sent += 1
    if sent:
        write_jsonl(QUEUE, remaining)
        log(f"sent {sent} remaining {len(remaining)}")


def legacy_rows(rows: list) -> list:
    """Rows from a first-version recording: {question, of, seconds, answer, left_at}."""
    out, section_index, section_total, last_q, counts = [], 0, None, None, {}
    session_start = None
    for r in rows:
        left = parse_any_iso(r.get("left_at"))
        if left is None or r.get("question") is None:
            continue
        entered = left - timedelta(seconds=float(r.get("seconds") or 0))
        session_start = session_start or entered
        q, total = int(r["question"]), r.get("of")
        if total != section_total or (q == 1 and (last_q or 0) >= 2):
            section_index += 1
            section_total = total
        visit = counts.get((section_index, q), 0) + 1
        counts[(section_index, q)] = visit
        out.append({
            "kind": "bluebook", "event_id": str(uuid.uuid4()),
            "session_start": iso(session_start), "section_index": section_index,
            "section_total": total, "section_kind": SECTION_KINDS.get(total),
            "question": q, "visit": visit, "entered_at": iso(entered),
            "seconds": min(float(r.get("seconds") or 0), MAX_SECONDS),
            "choice": r.get("answer") if r.get("answer") in ("A", "B", "C", "D") else None,
            "typed": None,
        })
        last_q = q
    return out


def summary(rows: list) -> str:
    """Per section and question: total seconds over all visits, last answer, visits."""
    per = {}
    for r in rows:
        key = (r.get("section_index") or 0, r.get("question") or 0)
        row = per.setdefault(key, {"kind": r.get("section_kind"), "seconds": 0.0, "answer": None, "visits": 0})
        row["seconds"] += float(r.get("seconds") or 0)
        row["answer"] = r.get("choice") or r.get("typed") or row["answer"]
        row["visits"] += 1
    lines = ["sec kind   q  seconds  answer  visits"]
    for (s, q), row in sorted(per.items()):
        lines.append(f"{s:>3} {row['kind'] or '?':<4} {q:>3}  {row['seconds']:>7.1f}  "
                     f"{row['answer'] or '-':>6}  {row['visits']:>6}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def run_watch(config: dict, tracker, state: dict, stopping: dict) -> None:
    """Main loop with the streaming reader."""
    ensure_built(WATCH_SRC, WATCH_BIN)
    watch, block, last_flush, last_status = Watch(), None, 0.0, None
    while not stopping["now"]:
        at = now()
        if lid_closed():
            watch.stop()
            tracker.feed(None, at)
            time.sleep(float(config["idle_poll_seconds"]))
            continue
        if not watch.alive():
            pid = subprocess.run(["/usr/bin/pgrep", "-x", "Bluebook"], capture_output=True,
                                 text=True, check=False).stdout.split()
            if not pid:
                tracker.feed(None, at)
                save_json(STATE, state)
                time.sleep(float(config["idle_poll_seconds"]))
                continue
            watch.start(pid[0])
        for line in watch.drain():
            at = now()
            if line == "S":
                block = []
            elif line == "E" and block is not None:
                tracker.feed(parse("\n".join(block) + "\n"), at)
                block = None
            elif block is not None:
                block.append(line)
            elif line.startswith("D" + US):
                apply_delta(tracker, line, at)
            elif line in ("BACK", "NOWIN"):
                tracker.feed(None, at)
            elif line in ("NOAX", "NOPROC", "EXIT"):
                if line == "NOAX" and last_status != "NOAX":
                    log("bluebook: NOAX (grant Accessibility to ax_watch)")
                last_status = line
                tracker.feed(None, at)
                watch.stop()
                time.sleep(30 if line == "NOAX" else float(config["idle_poll_seconds"]))
        save_json(STATE, state)
        if time.time() - last_flush > float(config["flush_every_seconds"]):
            flush(config)
            last_flush = time.time()
        time.sleep(0.1)
    watch.stop()


def run_probe(config: dict, tracker, state: dict, stopping: dict) -> None:
    """Main loop with the one-shot reader (ax_probe every poll_seconds)."""
    ensure_probe()
    last_status, last_flush = None, 0.0
    while not stopping["now"]:
        at = now()
        raw = "BACK" if lid_closed() else probe()
        status = next((m for m in ("NOPROC", "BACK", "NOWIN", "NOAX", "ERROR") if raw.startswith(m)), "OK")
        if status != last_status and status in ("NOAX", "ERROR", "NOWIN"):
            log(f"bluebook: {raw.strip()[:120]}")
        last_status = status
        tracker.feed(parse(raw), at)
        save_json(STATE, state)
        if time.time() - last_flush > float(config["flush_every_seconds"]):
            flush(config)
            last_flush = time.time()
        time.sleep(float(config["idle_poll_seconds"] if status == "NOPROC" else config["poll_seconds"]))


def run_daemon(config: dict) -> int:
    state = load_json(STATE, {})

    def emit(row):
        append_jsonl(RECORDING, row)             # full text stays here
        append_jsonl(QUEUE, trim_for_send(row))  # the receiver takes < 4096 bytes
        log(f"visit s{row['section_index']} q{row['question']} v{row['visit']} "
            f"{row['seconds']}s {row['choice'] or row['typed'] or '-'}")

    tracker = Tracker(state, emit, int(config["session_gap_minutes"]))
    stopping = {"now": False}
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stopping.update(now=True))
    log(f"bluebook tracker started reader={config.get('reader')}")
    if config.get("reader") == "watch":
        run_watch(config, tracker, state, stopping)
    else:
        run_probe(config, tracker, state, stopping)
    tracker.close(now())
    save_json(STATE, state)
    flush(config)
    log("bluebook tracker stopped")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Bluebook practice-test tracker")
    parser.add_argument("--upload", metavar="FILE", help="queue a first-version recording for sending")
    parser.add_argument("--summary", metavar="FILE", help="print a per-question table of a recording")
    parser.add_argument("--flush", action="store_true", help="send the queue now and exit")
    parser.add_argument("--resend", metavar="FILE", help="queue the rows of a visits.jsonl again (same event_id)")
    args = parser.parse_args(argv)
    config = load_config()
    if args.summary:
        rows = read_jsonl(Path(args.summary))
        if rows and "left_at" in rows[0]:
            rows = legacy_rows(rows)
        print(summary(rows))
        return 0
    if args.upload:
        rows = legacy_rows(read_jsonl(Path(args.upload)))
        for row in rows:
            append_jsonl(QUEUE, row)
        log(f"queued {len(rows)} rows from {args.upload}")
        flush(config)
        return 0
    if args.resend:
        rows = [r for r in read_jsonl(Path(args.resend)) if r.get("kind") == "bluebook" and r.get("event_id")]
        for row in rows:
            if not row.get("module"):          # recorded before the module field existed
                head = re.match(r"^(Section \d+(?:, Module \d+)?: [^:]+?)(?:\s+THIS IS A|\s*$)", row.get("passage") or "")
                if head:
                    row = dict(row, module=head.group(1).strip()[:80])
            append_jsonl(QUEUE, trim_for_send(row))
        log(f"queued {len(rows)} rows again from {args.resend}")
        flush(config)
        return 0
    if args.flush:
        flush(config)
        return 0
    return run_daemon(config)


if __name__ == "__main__":
    sys.exit(main())
