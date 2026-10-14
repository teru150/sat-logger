#!/usr/bin/env python3
"""Tests for bluebook/tracker.py: parsing, sections, visits, sending. No AX, no network."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bluebook"))
import tracker as t  # noqa: E402

T0 = datetime(2026, 10, 13, 7, 15, tzinfo=timezone.utc)
US = t.US


def screen(q, total=27, choice=None, typed=None, texts=()):
    lines = [f"AXButton{US}Question Navigator Question {q} of {total}{US}"]
    for text in texts:
        lines.append(f"AXStaticText{US}{US}{text}")
    for o in "ABCD":
        lines.append(f"AXRadioButton{US}option {o} word{o}{US}{1 if o == choice else 0}")
        lines.append(f"AXStaticText{US}option {o}{US}{o}")
    if typed is not None:
        lines.append(f"AXTextField{US}{US}{typed}")
    return "\n".join(lines) + "\n"


class TestParse(unittest.TestCase):
    def test_question_and_choice(self):
        snap = t.parse(screen(4, 27, "C"))
        self.assertEqual((snap["question"], snap["total"], snap["choice"], snap["typed"]), (4, 27, "C", None))

    def test_choices_text_and_passage_stem_split(self):
        texts = ("Section 1: Reading and Writing", "0", ":", "00", "THIS IS A TEST PREVIEW",
                 "Passage, image, or other source content", "In recommending Bao Phi\u2019s collection",
                 "S", "\u00f4ng I Sing", ", a librarian noted that pieces don\u2019t lose their", "blank",
                 "nature when printed.", "Question", "1", "Which choice completes the text?",
                 "wordA", "wordB", "wordC", "wordD", "Terumasa Iriyama", "Bluebook Exams")
        snap = t.parse(screen(2, 27, texts=texts))
        self.assertEqual(snap["choices"], {"A": "wordA", "B": "wordB", "C": "wordC", "D": "wordD"})
        passage, stem = t.question_text(snap["texts"], snap["choices"])
        self.assertEqual(passage, "In recommending Bao Phi\u2019s collection S \u00f4ng I Sing, a librarian noted that "
                                  "pieces don\u2019t lose their ______ nature when printed.")
        self.assertEqual(stem, "Which choice completes the text?")

    def test_real_test_header_is_stripped_and_kept_as_module(self):
        texts = ["Section 1, Module 2: Reading and Writing", "THIS IS A PRACTICE TEST",
                 "Scholars long thought", "blank", "by new evidence.", "Question", "1", "Which choice?"]
        self.assertEqual(t.module_label(texts), "Section 1, Module 2: Reading and Writing")
        self.assertEqual(t.question_text(texts, {}), ("Scholars long thought ______ by new evidence.", "Which choice?"))

    def test_no_question_marker_keeps_text_as_stem(self):
        self.assertEqual(t.question_text(["Solve for x.", "12:00"], {}), ("", "Solve for x."))

    def test_row_carries_stem_choices_and_trim(self):
        rows = []
        tr = t.Tracker({}, rows.append, 15)
        tr.feed(t.parse(screen(1, texts=("x" * 2000,))), T0)
        tr.close(T0 + timedelta(seconds=5))
        self.assertEqual(len(rows[0]["stem"]), 2000)
        self.assertTrue(rows[0]["underline_lost"])
        sent = t.trim_for_send(rows[0])
        self.assertEqual((len(sent["stem"]), sent["stem_truncated"], sent["choices"]["B"]), (700, True, "wordB"))

    def test_no_choice_yet(self):
        self.assertEqual(t.parse(screen(1))["choice"], None)

    def test_typed_only_numeric(self):
        self.assertEqual(t.parse(screen(3, 22, typed="-3/4"))["typed"], "-3/4")
        self.assertEqual(t.parse(screen(3, 22, typed="12.5"))["typed"], "12.5")
        self.assertEqual(t.parse(screen(3, 22, typed="missing value"))["typed"], None)
        self.assertEqual(t.parse(screen(3, 22, typed="abc"))["typed"], None)

    def test_statuses_are_none(self):
        for raw in ("BACK", "NOPROC", "NOWIN", "NOAX", "ERROR x", f"AXButton{US}Next{US}\n"):
            self.assertIsNone(t.parse(raw), raw)


class TestTracker(unittest.TestCase):
    def setUp(self):
        self.rows = []
        self.state = {}
        self.tr = t.Tracker(self.state, self.rows.append, gap_minutes=15)

    def at(self, seconds):
        return T0 + timedelta(seconds=seconds)

    def test_visit_time_choice_and_revisit(self):
        self.tr.feed(t.parse(screen(1)), self.at(0))
        self.tr.feed(t.parse(screen(1, choice="B")), self.at(30))
        self.tr.feed(t.parse(screen(2)), self.at(40))
        self.tr.feed(t.parse(screen(1, choice="B")), self.at(70))
        self.tr.feed(t.parse(screen(1, choice="A")), self.at(80))
        self.tr.close(self.at(90))
        got = [(r["question"], r["visit"], r["seconds"], r["choice"]) for r in self.rows]
        self.assertEqual(got, [(1, 1, 40.0, "B"), (2, 1, 30.0, None), (1, 2, 20.0, "A")])
        self.assertTrue(all(r["session_start"] == t.iso(T0) for r in self.rows))
        self.assertEqual(self.rows[0]["section_kind"], "RW")
        self.assertEqual(self.rows[0]["section_index"], 1)

    def test_back_ends_the_visit_so_time_away_is_not_counted(self):
        self.tr.feed(t.parse(screen(5, choice="D")), self.at(0))
        self.tr.feed(t.parse("BACK"), self.at(20))
        self.tr.feed(t.parse("BACK"), self.at(300))
        self.tr.feed(t.parse(screen(5, choice="D")), self.at(320))
        self.tr.close(self.at(330))
        self.assertEqual([(r["visit"], r["seconds"]) for r in self.rows], [(1, 20.0), (2, 10.0)])

    def test_new_section_on_total_change_and_on_question_1_after_review(self):
        self.tr.feed(t.parse(screen(26)), self.at(0))
        self.tr.feed(t.parse(screen(27)), self.at(10))
        self.tr.feed(t.parse(f"AXButton{US}Next{US}\n"), self.at(20))     # review screen
        self.tr.feed(t.parse(screen(1)), self.at(30))                      # RW module 2
        self.tr.feed(t.parse(screen(2)), self.at(40))
        self.tr.feed(t.parse(screen(1)), self.at(50))                      # Back button: same section
        self.tr.feed(t.parse(f"AXButton{US}Next{US}\n"), self.at(60))
        self.tr.feed(t.parse(screen(1, 22)), self.at(70))                  # Math
        self.tr.close(self.at(80))
        sections = [(r["section_index"], r["section_kind"], r["question"]) for r in self.rows]
        self.assertEqual(sections, [(1, "RW", 26), (1, "RW", 27), (2, "RW", 1), (2, "RW", 2), (2, "RW", 1), (3, "Math", 1)])

    def test_session_ends_after_gap_and_restarts(self):
        self.tr.feed(t.parse(screen(1)), self.at(0))
        self.tr.feed(t.parse("NOPROC"), self.at(10))
        self.tr.feed(t.parse("NOPROC"), self.at(16 * 60))
        self.assertNotIn("session_start", self.state)
        self.tr.feed(t.parse(screen(1)), self.at(17 * 60))
        self.assertEqual(self.state["session_start"], t.iso(self.at(17 * 60)))
        self.assertEqual(self.state["section_index"], 1)

    def test_state_survives_a_restart(self):
        self.tr.feed(t.parse(screen(3)), self.at(0))
        self.tr.close(self.at(5))
        saved = json.loads(json.dumps(self.state))
        tr2 = t.Tracker(saved, self.rows.append, 15)
        tr2.feed(t.parse(screen(4)), self.at(10))
        tr2.close(self.at(20))
        self.assertEqual(self.rows[-1]["session_start"], t.iso(T0))
        self.assertEqual(self.rows[-1]["section_index"], 1)

    def test_too_short_visit_is_dropped_and_long_visit_capped(self):
        self.tr.feed(t.parse(screen(1)), self.at(0))
        self.tr.feed(t.parse(screen(2)), self.at(0.2))
        self.tr.close(self.at(5000))
        self.assertEqual([(r["question"], r["seconds"]) for r in self.rows], [(2, 3600)])


class TestDelta(unittest.TestCase):
    """D lines from ax_watch change the open visit at once; a nav change closes it."""

    def setUp(self):
        self.rows = []
        self.tr = t.Tracker({}, self.rows.append, 15)
        self.tr.feed(t.parse(screen(7, 27, "A")), T0)

    def test_choice_change_lands_in_the_visit(self):
        t.apply_delta(self.tr, f"D{US}option B melodic{US}1", T0 + timedelta(seconds=20))
        t.apply_delta(self.tr, f"D{US}option A scholarly{US}0", T0 + timedelta(seconds=20))
        self.tr.close(T0 + timedelta(seconds=21))
        self.assertEqual((self.rows[0]["question"], self.rows[0]["choice"], self.rows[0]["seconds"]), (7, "B", 21.0))

    def test_nav_change_closes_with_the_latest_choice(self):
        t.apply_delta(self.tr, f"D{US}option D word{US}1", T0 + timedelta(seconds=30))
        t.apply_delta(self.tr, f"D{US}nav{US}Question Navigator Question 8 of 27", T0 + timedelta(seconds=30.4))
        self.assertEqual([(r["question"], r["choice"], r["seconds"]) for r in self.rows], [(7, "D", 30.4)])
        self.assertIsNone(self.tr.current)
        self.tr.feed(t.parse(screen(8, 27)), T0 + timedelta(seconds=31))
        self.assertEqual(self.tr.current["question"], 8)

    def test_typed_delta(self):
        t.apply_delta(self.tr, f"D{US}{US}30", T0 + timedelta(seconds=5))
        self.assertEqual(self.tr.current["typed"], "30")
        t.apply_delta(self.tr, f"D{US}{US}abc", T0 + timedelta(seconds=6))
        self.assertEqual(self.tr.current["typed"], "30")


class TestFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.patches = [mock.patch.object(t, n, root / f) for n, f in
                        (("RUNTIME", ""), ("CONFIG", "config.json"), ("STATE", "state.json"),
                         ("QUEUE", "queue.jsonl"), ("BAD", "queue.bad.jsonl"), ("RECORDING", "visits.jsonl"))]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def cfg(self, send=True):
        return {"send": send, "url": "https://example.test/sat/bluebook", "token": "TOK", "src": "my-mac"}

    def test_legacy_upload_derives_sections_and_entered_at(self):
        rows = [
            {"question": 27, "of": 27, "seconds": 10.0, "answer": "C", "left_at": "2026-10-13T06:57:54+00:00"},
            {"question": 1, "of": 27, "seconds": 30.0, "answer": "D", "left_at": "2026-10-13T06:58:30+00:00"},
            {"question": 1, "of": 22, "seconds": 5.0, "answer": None, "left_at": "2026-10-13T06:59:00+00:00"},
        ]
        out = t.legacy_rows(rows)
        self.assertEqual([(r["section_index"], r["section_kind"], r["question"], r["visit"]) for r in out],
                         [(1, "RW", 27, 1), (2, "RW", 1, 1), (3, "Math", 1, 1)])
        self.assertEqual(out[0]["entered_at"], "2026-10-13T06:57:44Z")
        self.assertTrue(all(r["session_start"] == "2026-10-13T06:57:44Z" for r in out))

    def test_flush_sends_with_token_and_keeps_failures(self):
        t.append_jsonl(t.QUEUE, {"kind": "bluebook", "event_id": "1", "question": 1, "section_index": 1})
        t.append_jsonl(t.QUEUE, {"kind": "bluebook", "event_id": "2", "question": 2, "section_index": 1})
        posted = []

        def post(url, token, payload):
            posted.append((url, token, payload))
            return (True, "ok") if payload["event_id"] == "1" else (False, "curl_exit=28")
        with mock.patch.object(t, "post_row", side_effect=post):
            t.flush(self.cfg())
        self.assertEqual(posted[0][:2], ("https://example.test/sat/bluebook", "TOK"))
        self.assertEqual(posted[0][2]["src"], "my-mac")
        self.assertNotIn("token", posted[0][2])
        self.assertEqual([r["event_id"] for r in t.read_jsonl(t.QUEUE)], ["2"])

    def test_flush_quarantines_invalid_input(self):
        t.append_jsonl(t.QUEUE, {"kind": "bluebook", "event_id": "9", "question": 99, "section_index": 1})
        with mock.patch.object(t, "post_row", return_value=(False, "server_error=invalid_input")):
            t.flush(self.cfg())
        self.assertEqual(t.read_jsonl(t.QUEUE), [])
        self.assertEqual(t.read_jsonl(t.BAD)[0]["event_id"], "9")

    def test_resend_queues_same_event_ids_trimmed(self):
        rec = Path(self.tmp.name) / "visits.jsonl"
        t.append_jsonl(rec, {"kind": "bluebook", "event_id": "e1", "question": 1, "stem": "x" * 900, "passage": ""})
        t.append_jsonl(rec, {"kind": "other", "event_id": "e2"})
        with mock.patch.object(t, "flush"):
            t.main(["--resend", str(rec)])
        queued = t.read_jsonl(t.QUEUE)
        self.assertEqual([(r["event_id"], len(r["stem"]), r["stem_truncated"]) for r in queued], [("e1", 700, True)])

    def test_resend_derives_module_from_an_old_passage(self):
        rec = Path(self.tmp.name) / "visits.jsonl"
        t.append_jsonl(rec, {"kind": "bluebook", "event_id": "e1", "question": 1,
                             "passage": "Section 1, Module 2: Reading and Writing THIS IS A PRACTICE TEST Scholars long", "stem": "s"})
        with mock.patch.object(t, "flush"):
            t.main(["--resend", str(rec)])
        self.assertEqual(t.read_jsonl(t.QUEUE)[0]["module"], "Section 1, Module 2: Reading and Writing")

    def test_send_off_leaves_queue(self):
        t.append_jsonl(t.QUEUE, {"kind": "bluebook", "event_id": "1"})
        with mock.patch.object(t, "post_row") as post:
            t.flush(self.cfg(send=False))
        post.assert_not_called()
        self.assertEqual(len(t.read_jsonl(t.QUEUE)), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
