"""Tests for film cut tool."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

from tools.film.cut import (
    PlanValidationError,
    calculate_segment_duration,
    cut_film,
    escape_caption,
    read_length,
    validate_plan,
)


class TestFilmCut(unittest.TestCase):
    """Test suite for film cutting pipeline."""

    def test_caption_escaping(self) -> None:
        """Verify drawtext escaping for required sample texts."""
        self.assertEqual(escape_caption("$700"), r"\$700")
        self.assertEqual(escape_caption("80 cm"), "80 cm")
        self.assertEqual(escape_caption("It's"), r"It\'s")
        self.assertEqual(escape_caption("50.8 cm: 6 cm"), r"50.8 cm\: 6 cm")

    def test_segment_durations_add_up(self) -> None:
        """Verify individual segment durations and their sum."""
        seg1 = {"take": "main", "in": 0.0, "out": 10.0, "speed": 1.0}
        seg2 = {"take": "main", "in": 2.0, "out": 6.0, "speed": 2.0}
        seg3 = {"take": "main", "in": 1.0, "out": 3.0, "speed": 0.5}

        dur1 = calculate_segment_duration(seg1)
        dur2 = calculate_segment_duration(seg2)
        dur3 = calculate_segment_duration(seg3)

        self.assertAlmostEqual(dur1, 10.0)
        self.assertAlmostEqual(dur2, 2.0)
        self.assertAlmostEqual(dur3, 4.0)
        self.assertAlmostEqual(dur1 + dur2 + dur3, 16.0)

    def test_dash_checks_refuse(self) -> None:
        """Verify caption validation refuses em dash, en dash, and dash between words."""
        base_plan = {
            "takes": {"main": "fake.mp4"},
            "segments": [{"take": "main", "in": 0.0, "out": 170.0, "speed": 1.0}],
            "captions": [],
        }

        with tempfile.TemporaryDirectory() as td:
            fake_take = os.path.join(td, "fake.mp4")
            with open(fake_take, "w", encoding="utf-8") as f:
                f.write("dummy")

            plan = dict(base_plan)
            plan["takes"] = {"main": fake_take}

            invalid_captions = [
                "A renter's room\u2014The desk stays.",  # em dash
                "A renter's room\u2013The desk stays.",  # en dash
                "A renter's room - The desk stays.",  # space dash space
                "A doorway-clear room.",  # hyphen between words
            ]

            for bad_text in invalid_captions:
                plan["captions"] = [{"start": 1.0, "end": 5.0, "text": bad_text}]
                with self.assertRaises(PlanValidationError, msg=f"Should refuse: {bad_text}"):
                    validate_plan(plan, td)

            # Valid caption with minus sign in a number should pass
            plan["captions"] = [
                {"start": 1.0, "end": 5.0, "text": "Saves $40.00 and clears by -25 cm."}
            ]
            total_len = validate_plan(plan, td)
            self.assertAlmostEqual(total_len, 170.0)

    def test_length_checks_refuse(self) -> None:
        """Verify export refuses total length outside 165.0 to 175.0 s unless any_length is set."""
        with tempfile.TemporaryDirectory() as td:
            fake_take = os.path.join(td, "fake.mp4")
            with open(fake_take, "w", encoding="utf-8") as f:
                f.write("dummy")

            # Under 165.0 s
            plan_short = {
                "takes": {"main": fake_take},
                "segments": [{"take": "main", "in": 0.0, "out": 160.0, "speed": 1.0}],
                "captions": [],
            }
            with self.assertRaises(PlanValidationError):
                validate_plan(plan_short, td, any_length=False)

            # Over 175.0 s
            plan_long = {
                "takes": {"main": fake_take},
                "segments": [{"take": "main", "in": 0.0, "out": 180.0, "speed": 1.0}],
                "captions": [],
            }
            with self.assertRaises(PlanValidationError):
                validate_plan(plan_long, td, any_length=False)

            # Within range (170.0 s)
            plan_good = {
                "takes": {"main": fake_take},
                "segments": [{"take": "main", "in": 0.0, "out": 170.0, "speed": 1.0}],
                "captions": [],
            }
            dur = validate_plan(plan_good, td, any_length=False)
            self.assertAlmostEqual(dur, 170.0)

            # Short length allowed when any_length is True
            dur_short = validate_plan(plan_short, td, any_length=True)
            self.assertAlmostEqual(dur_short, 160.0)

    def test_missing_take_refuses(self) -> None:
        """Verify validation refuses when take file is missing."""
        plan = {
            "takes": {"main": "nonexistent_file_xyz123.webm"},
            "segments": [{"take": "main", "in": 0.0, "out": 170.0, "speed": 1.0}],
            "captions": [],
        }
        with self.assertRaises(PlanValidationError):
            validate_plan(plan, ".")

    def test_overlapping_and_out_of_bounds_captions_refuse(self) -> None:
        """Verify caption overlap and bounds checks."""
        with tempfile.TemporaryDirectory() as td:
            fake_take = os.path.join(td, "fake.mp4")
            with open(fake_take, "w", encoding="utf-8") as f:
                f.write("dummy")

            # Overlapping captions
            plan_overlap = {
                "takes": {"main": fake_take},
                "segments": [{"take": "main", "in": 0.0, "out": 170.0, "speed": 1.0}],
                "captions": [
                    {"start": 1.0, "end": 6.0, "text": "First caption."},
                    {"start": 5.0, "end": 10.0, "text": "Second caption."},
                ],
            }
            with self.assertRaises(PlanValidationError):
                validate_plan(plan_overlap, td)

            # Caption past film end
            plan_past_end = {
                "takes": {"main": fake_take},
                "segments": [{"take": "main", "in": 0.0, "out": 170.0, "speed": 1.0}],
                "captions": [{"start": 160.0, "end": 176.0, "text": "Late caption."}],
            }
            with self.assertRaises(PlanValidationError):
                validate_plan(plan_past_end, td)

            # Caption exceeding 90 characters
            plan_too_long = {
                "takes": {"main": fake_take},
                "segments": [{"take": "main", "in": 0.0, "out": 170.0, "speed": 1.0}],
                "captions": [{"start": 1.0, "end": 5.0, "text": "A" * 91}],
            }
            with self.assertRaises(PlanValidationError):
                validate_plan(plan_too_long, td)

    def test_cli_refuses_invalid_plan(self) -> None:
        """Verify cut.py CLI exits with code 1 and descriptive error."""
        with tempfile.TemporaryDirectory() as td:
            plan_path = os.path.join(td, "bad_plan.json")
            out_mp4 = os.path.join(td, "out.mp4")
            with open(plan_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "takes": {"main": "missing.webm"},
                        "segments": [{"take": "main", "in": 0.0, "out": 170.0}],
                    },
                    f,
                )

            cut_py = os.path.join("tools", "film", "cut.py")
            res = subprocess.run(
                [sys.executable, cut_py, plan_path, out_mp4],
                capture_output=True,
                text=True,
            )
            self.assertEqual(res.returncode, 1)
            self.assertIn("Validation error", res.stderr)

    def test_end_to_end_export(self) -> None:
        """End to end export of two 2 s test clips with one caption."""
        with tempfile.TemporaryDirectory() as td:
            clip1 = os.path.join(td, "clip1.mp4")
            clip2 = os.path.join(td, "clip2.mp4")

            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=duration=2:size=1920x1080:rate=30",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    clip1,
                ],
                check=True,
                capture_output=True,
            )

            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=duration=2:size=1280x720:rate=30",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    clip2,
                ],
                check=True,
                capture_output=True,
            )

            plan_path = os.path.join(td, "plan.json")
            out_mp4 = os.path.join(td, "out.mp4")

            plan_data = {
                "takes": {"main": clip1, "secondary": clip2},
                "segments": [
                    {
                        "take": "main",
                        "in": 0.0,
                        "out": 2.0,
                        "speed": 1.0,
                        "label": "2 s later",
                        "pip": None,
                    },
                    {
                        "take": "secondary",
                        "in": 0.0,
                        "out": 2.0,
                        "speed": 1.0,
                        "label": "",
                        "pip": None,
                    },
                ],
                "captions": [
                    {
                        "start": 0.5,
                        "end": 2.5,
                        "text": "A renter's room. The desk stays.",
                    }
                ],
                "clicks": [1.0],
                "endCard": {
                    "start": 3.0,
                    "end": 4.0,
                    "name": "RoomWeft",
                    "line": "Keep what you love. Fit the rest.",
                    "link": "roomweft.midknight-labs.workers.dev",
                },
            }

            with open(plan_path, "w", encoding="utf-8") as f:
                json.dump(plan_data, f)

            cut_py = os.path.join("tools", "film", "cut.py")
            res = subprocess.run(
                [sys.executable, cut_py, plan_path, out_mp4, "--any-length"],
                capture_output=True,
                text=True,
            )
            self.assertEqual(res.returncode, 0, f"CLI export failed: {res.stderr}")
            self.assertIn("Exported length:", res.stdout)
            self.assertIn("Integrated loudness:", res.stdout)

            self.assertTrue(os.path.exists(out_mp4), "Exported MP4 must exist")
            duration = read_length(out_mp4)
            self.assertAlmostEqual(duration, 4.0, delta=0.2)

            sheet_path = os.path.join(td, "out.sheet.png")
            self.assertTrue(os.path.exists(sheet_path), "Contact sheet must exist")
            self.assertGreater(os.path.getsize(sheet_path), 0, "Contact sheet must not be empty")

    def test_pip_export(self) -> None:
        """Verify segment picture in picture inset renders properly."""
        with tempfile.TemporaryDirectory() as td:
            main_clip = os.path.join(td, "main.mp4")
            pip_clip = os.path.join(td, "phone.mp4")

            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=duration=2:size=1920x1080:rate=30",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    main_clip,
                ],
                check=True,
                capture_output=True,
            )

            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=duration=2:size=390x844:rate=30",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    pip_clip,
                ],
                check=True,
                capture_output=True,
            )

            plan_path = os.path.join(td, "pip_plan.json")
            out_mp4 = os.path.join(td, "pip_out.mp4")

            plan_data = {
                "takes": {"main": main_clip, "phone": pip_clip},
                "segments": [
                    {
                        "take": "main",
                        "in": 0.0,
                        "out": 2.0,
                        "speed": 1.0,
                        "label": "",
                        "pip": {
                            "take": "phone",
                            "in": 0.0,
                            "out": 2.0,
                            "x": 100,
                            "y": 100,
                            "w": 390,
                        },
                    }
                ],
                "captions": [],
                "clicks": [],
            }

            with open(plan_path, "w", encoding="utf-8") as f:
                json.dump(plan_data, f)

            cut_film(plan_path, out_mp4, any_length=True)
            self.assertTrue(os.path.exists(out_mp4))
            self.assertAlmostEqual(read_length(out_mp4), 2.0, delta=0.2)


if __name__ == "__main__":
    unittest.main()
