"""Cut film from a plan file.

Combines video takes, music, clicks, captions, and end card into an export.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import struct
import subprocess
import sys
import tempfile
import wave
from typing import Any


class PlanValidationError(Exception):
    """Raised when a film plan fails validation checks."""
    pass


def escape_caption(text: str) -> str:
    """Escape text for drawtext filter."""
    out = []
    for ch in text:
        if ch == "\\":
            out.append(r"\\")
        elif ch in ("'", '"', ":", ",", "%", "$"):
            out.append("\\" + ch)
        else:
            out.append(ch)
    return "".join(out)


escape_drawtext = escape_caption


def get_font_path() -> str:
    """Find font file path."""
    current_dir = os.path.dirname(os.path.abspath(__file__))
    inter_path = os.path.join(current_dir, "Inter.ttf")
    if os.path.exists(inter_path):
        return inter_path.replace("\\", "/")
    segoe_path = "C:/Windows/Fonts/segoeui.ttf"
    if os.path.exists(segoe_path):
        return segoe_path
    return "segoeui.ttf"


def resolve_path(path: str, plan_dir: str) -> str:
    """Resolve file path relative to plan dir or working dir."""
    if os.path.isabs(path) and os.path.exists(path):
        return path
    candidate = os.path.join(plan_dir, path)
    if os.path.exists(candidate):
        return os.path.abspath(candidate)
    if os.path.exists(path):
        return os.path.abspath(path)
    return os.path.abspath(candidate)


def calculate_segment_duration(seg: dict[str, Any]) -> float:
    """Calculate segment duration: (out - in) / speed."""
    in_time = float(seg["in"])
    out_time = float(seg["out"])
    speed = float(seg.get("speed", 1.0))
    if speed <= 0:
        raise PlanValidationError("Segment speed must be positive.")
    if out_time <= in_time:
        raise PlanValidationError("Segment out time must be greater than in time.")
    return (out_time - in_time) / speed


def read_frame_size(take_path: str) -> tuple[int, int]:
    """Read video width and height using ffprobe."""
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "json",
        take_path,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise PlanValidationError(
            f"Could not read frame size for {take_path}: {res.stderr.strip()}"
        )
    try:
        data = json.loads(res.stdout)
        streams = data.get("streams", [])
        if not streams:
            raise PlanValidationError(f"No video streams found in {take_path}.")
        return int(streams[0]["width"]), int(streams[0]["height"])
    except (json.JSONDecodeError, KeyError, IndexError, ValueError) as err:
        raise PlanValidationError(f"Could not parse frame size for {take_path}: {err}")


def validate_plan(plan: dict[str, Any], plan_dir: str, any_length: bool = False) -> float:
    """Validate film plan and return total duration."""
    takes = plan.get("takes", {})
    if not isinstance(takes, dict):
        raise PlanValidationError("Plan takes must be an object.")

    # Check each take file
    for name, take_path in takes.items():
        resolved = resolve_path(take_path, plan_dir)
        if not os.path.exists(resolved):
            raise PlanValidationError(f"Take file not found: {take_path} for take '{name}'.")

    segments = plan.get("segments", [])
    if not segments or not isinstance(segments, list):
        raise PlanValidationError("Plan segments must be a non empty list.")

    total_length = 0.0
    frame_sizes: dict[str, tuple[int, int]] = {}
    for idx, seg in enumerate(segments):
        take_name = seg.get("take")
        if not take_name or take_name not in takes:
            raise PlanValidationError(f"Segment {idx} references unknown take '{take_name}'.")

        speed = float(seg.get("speed", 1.0))
        if speed < 0.5 or speed > 4.0:
            raise PlanValidationError(f"Segment {idx} speed {speed} is outside 0.5 to 4.0.")

        seg_dur = calculate_segment_duration(seg)
        total_length += seg_dur

        pip = seg.get("pip")
        if pip:
            pip_take = pip.get("take")
            if not pip_take or pip_take not in takes:
                raise PlanValidationError(f"PIP in segment {idx} references unknown take '{pip_take}'.")
            pip_resolved = resolve_path(takes[pip_take], plan_dir)
            if not os.path.exists(pip_resolved):
                raise PlanValidationError(f"PIP take file not found: {takes[pip_take]}.")
            if float(pip.get("out", 0.0)) <= float(pip.get("in", 0.0)):
                raise PlanValidationError(f"PIP out time must be greater than in time in segment {idx}.")

        crop = seg.get("crop")
        if crop is not None:
            if not isinstance(crop, dict):
                raise PlanValidationError(f"Segment {idx} crop must be an object.")
            for key in ("x", "y", "w", "h"):
                if key not in crop:
                    raise PlanValidationError(f"Segment {idx} crop missing required key '{key}'.")
            try:
                cx = int(crop["x"])
                cy = int(crop["y"])
                cw = int(crop["w"])
                ch = int(crop["h"])
            except (ValueError, TypeError):
                raise PlanValidationError(f"Segment {idx} crop coordinates must be integers.")

            if cw < 320 or ch < 180:
                raise PlanValidationError(
                    f"Segment {idx} crop {cw}x{ch} is smaller than 320x180."
                )

            resolved_take = resolve_path(takes[take_name], plan_dir)
            if resolved_take not in frame_sizes:
                frame_sizes[resolved_take] = read_frame_size(resolved_take)
            take_w, take_h = frame_sizes[resolved_take]

            if cx < 0 or cy < 0 or (cx + cw) > take_w or (cy + ch) > take_h:
                raise PlanValidationError(
                    f"Segment {idx} crop [{cx}, {cy}, {cw}, {ch}] is outside take frame size {take_w}x{take_h}."
                )

        label_hold = seg.get("labelHold")
        if label_hold is not None:
            try:
                lh = float(label_hold)
                if lh <= 0:
                    raise PlanValidationError(f"Segment {idx} labelHold must be positive.")
            except (ValueError, TypeError):
                raise PlanValidationError(f"Segment {idx} labelHold must be a positive number.")

    if not any_length:
        if total_length < 165.0 or total_length > 175.0:
            raise PlanValidationError(
                f"Total length {total_length:.2f} s is outside required range 165.0 to 175.0 s."
            )

    captions = plan.get("captions", [])
    sorted_captions = sorted(captions, key=lambda c: float(c.get("start", 0.0)))
    last_end = -1.0

    for idx, cap in enumerate(sorted_captions):
        text = cap.get("text", "")
        if "\u2014" in text:
            raise PlanValidationError(f"Caption {idx} contains an em dash.")
        if "\u2013" in text:
            raise PlanValidationError(f"Caption {idx} contains an en dash.")
        if " - " in text:
            raise PlanValidationError(f"Caption {idx} contains ' - ' between words.")
        if re.search(r"[a-zA-Z]\s*-\s*[a-zA-Z]", text):
            raise PlanValidationError(f"Caption {idx} contains a dash between words.")

        if len(text) > 90:
            raise PlanValidationError(f"Caption {idx} exceeds 90 characters.")

        start = float(cap.get("start", 0.0))
        end = float(cap.get("end", 0.0))
        if start < 0.0 or end > total_length or start >= end:
            raise PlanValidationError(
                f"Caption {idx} time range {start} to {end} s is outside film duration {total_length:.2f} s."
            )

        if start < last_end:
            raise PlanValidationError(f"Caption {idx} overlaps with previous caption.")
        last_end = end

    return total_length


def midi_to_freq(midi_note: float) -> float:
    """Convert MIDI note number to frequency in Hertz."""
    return 440.0 * (2.0 ** ((midi_note - 69.0) / 12.0))


def generate_pad_music(total_length: float, sample_rate: int = 48000) -> list[float]:
    """Generate four chord ambient pad track with tremolo and fades."""
    chords_midi = [
        [48, 55, 59, 64],  # C major 7: C3, G3, B3, E4
        [45, 52, 55, 60],  # A minor 7: A2, E3, G3, C4
        [41, 48, 52, 57],  # F major 7: F2, C3, E3, A3
        [43, 47, 50, 52],  # G 6: G2, B2, D3, E3
    ]
    chords_freq = [[midi_to_freq(m) for m in c] for c in chords_midi]

    chord_duration = 8.0
    samples_per_chord = int(chord_duration * sample_rate)
    cycle_samples = samples_per_chord * len(chords_midi)
    cycle_buffer = [0.0] * cycle_samples
    fade_len = int(0.5 * sample_rate)
    tremolo_rate = 2.5
    tremolo_depth = 0.15

    for ch_idx, freqs in enumerate(chords_freq):
        chord_start = ch_idx * samples_per_chord
        for i in range(samples_per_chord):
            t = i / sample_rate
            if i < fade_len:
                env = 0.5 * (1.0 - math.cos(math.pi * i / fade_len))
            elif i > samples_per_chord - fade_len:
                rem = samples_per_chord - i
                env = 0.5 * (1.0 - math.cos(math.pi * rem / fade_len))
            else:
                env = 1.0

            trem = 1.0 + tremolo_depth * math.sin(2.0 * math.pi * tremolo_rate * t)
            sample_val = sum(math.sin(2.0 * math.pi * f * t) for f in freqs) / len(freqs)
            cycle_buffer[chord_start + i] = sample_val * env * trem

    total_samples = int(total_length * sample_rate)
    num_cycles = (total_samples // cycle_samples) + 1
    full_buffer = (cycle_buffer * num_cycles)[:total_samples]

    fade_in_samples = min(total_samples, int(2.0 * sample_rate))
    fade_out_samples = min(total_samples, int(3.0 * sample_rate))

    if fade_in_samples > 0:
        for i in range(fade_in_samples):
            full_buffer[i] *= 0.5 * (1.0 - math.cos(math.pi * i / fade_in_samples))

    if fade_out_samples > 0:
        for i in range(fade_out_samples):
            rem = fade_out_samples - i
            target_idx = total_samples - fade_out_samples + i
            full_buffer[target_idx] *= 0.5 * (1.0 - math.cos(math.pi * rem / fade_out_samples))

    # Scale to roughly 18 dB under full scale
    gain = 10.0 ** (-18.0 / 20.0)
    return [s * gain for s in full_buffer]


def mix_clicks(
    audio_buffer: list[float],
    clicks: list[float],
    sample_rate: int = 48000,
    click_path: str | None = None,
) -> None:
    """Mix click audio into buffer at specified timestamps."""
    if not clicks:
        return

    if click_path is None:
        current_dir = os.path.dirname(os.path.abspath(__file__))
        click_path = os.path.join(current_dir, "select_002.wav")

    if not os.path.exists(click_path):
        return

    with wave.open(click_path, "rb") as wf:
        num_channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        wf_rate = wf.getframerate()
        raw_bytes = wf.readframes(wf.getnframes())

    if sample_width != 2:
        return

    total_frames = len(raw_bytes) // (num_channels * sample_width)
    click_floats: list[float] = []

    for i in range(total_frames):
        offset = i * num_channels * sample_width
        val = struct.unpack("<h", raw_bytes[offset : offset + 2])[0]
        click_floats.append(val / 32768.0)

    soft_level = 0.25
    buffer_len = len(audio_buffer)

    for click_time in clicks:
        start_idx = int(click_time * sample_rate)
        for i, s in enumerate(click_floats):
            idx = start_idx + i
            if 0 <= idx < buffer_len:
                audio_buffer[idx] += s * soft_level


def write_wav(path: str, buffer: list[float], sample_rate: int = 48000) -> None:
    """Write float audio buffer to 16 bit PCM stereo WAV file."""
    with wave.open(path, "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for s in buffer:
            clamped = max(-1.0, min(1.0, s))
            int_val = int(clamped * 32767.0)
            frames.extend(struct.pack("<hh", int_val, int_val))
        wf.writeframes(frames)


def two_pass_loudnorm(raw_wav: str, norm_wav: str) -> None:
    """Normalize audio to -16 LUFS and -1.5 dB true peak in two passes."""
    cmd_pass1 = [
        "ffmpeg",
        "-y",
        "-i",
        raw_wav,
        "-af",
        "loudnorm=I=-16:TP=-1.5:print_format=json",
        "-f",
        "null",
        "-",
    ]
    p1 = subprocess.run(cmd_pass1, capture_output=True, text=True)
    if p1.returncode != 0:
        raise RuntimeError(f"Audio loudnorm analysis failed: {p1.stderr}")

    match = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", p1.stderr)
    if not match:
        raise RuntimeError(f"Could not parse loudnorm analysis output: {p1.stderr}")

    stats = json.loads(match.group(0))

    filter_pass2 = (
        f"loudnorm=I=-16:TP=-1.5:"
        f"measured_I={stats['input_i']}:"
        f"measured_TP={stats['input_tp']}:"
        f"measured_LRA={stats['input_lra']}:"
        f"measured_thresh={stats['input_thresh']}:"
        f"offset={stats['target_offset']}:linear=true"
    )

    cmd_pass2 = [
        "ffmpeg",
        "-y",
        "-i",
        raw_wav,
        "-af",
        filter_pass2,
        "-c:a",
        "pcm_s16le",
        norm_wav,
    ]
    p2 = subprocess.run(cmd_pass2, capture_output=True, text=True)
    if p2.returncode != 0:
        raise RuntimeError(f"Audio normalization failed: {p2.stderr}")


def build_video_filtergraph(
    plan: dict[str, Any],
    take_indices: dict[str, int],
    temp_dir: str,
    font_path: str,
) -> tuple[str, str]:
    """Build ffmpeg filtergraph string for segments, captions, and end card."""
    segments = plan.get("segments", [])
    filter_parts: list[str] = []
    segment_outputs: list[str] = []
    escaped_font = font_path.replace(":", r"\:")

    for idx, seg in enumerate(segments):
        take_name = seg["take"]
        in_idx = take_indices[take_name]
        in_time = float(seg["in"])
        out_time = float(seg["out"])
        speed = float(seg.get("speed", 1.0))
        seg_dur = (out_time - in_time) / speed

        crop = seg.get("crop")
        crop_filter = ""
        if crop:
            cx = int(crop["x"])
            cy = int(crop["y"])
            cw = int(crop["w"])
            ch = int(crop["h"])
            crop_filter = f"crop={cw}:{ch}:{cx}:{cy},"

        base_label = f"s_base_{idx}"
        base_filter = (
            f"[{in_idx}:v]trim=start={in_time:.3f}:end={out_time:.3f},"
            f"setpts=(PTS-STARTPTS)/{speed:.6f},"
            f"{crop_filter}"
            f"scale=1920:1080:force_original_aspect_ratio=decrease,"
            f"pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0xF6F1E7,"
            f"setsar=1,fps=30[{base_label}]"
        )
        filter_parts.append(base_filter)
        current_stream = base_label

        pip = seg.get("pip")
        if pip:
            pip_take = pip["take"]
            pip_idx = take_indices[pip_take]
            pip_in = float(pip["in"])
            pip_out = float(pip["out"])
            pip_dur = pip_out - pip_in
            pip_x = int(pip["x"])
            pip_y = int(pip["y"])
            pip_w = int(pip["w"])

            pip_label = f"s_pip_{idx}"
            speed_mult = seg_dur / pip_dur if pip_dur > 0 else 1.0
            pip_filter = (
                f"[{pip_idx}:v]trim=start={pip_in:.3f}:end={pip_out:.3f},"
                f"setpts=(PTS-STARTPTS)*{speed_mult:.6f},"
                f"scale={pip_w}:-2,"
                f"pad=w=iw+8:h=ih+8:x=4:y=4:color=0xF6F1E7,fps=30[{pip_label}]"
            )
            filter_parts.append(pip_filter)

            over_label = f"s_over_{idx}"
            filter_parts.append(
                f"[{current_stream}][{pip_label}]overlay=x={pip_x}:y={pip_y}:eof_action=repeat[{over_label}]"
            )
            current_stream = over_label

        label = seg.get("label")
        if label:
            label_hold = float(seg.get("labelHold", 1.5))
            hold_str = f"{label_hold:g}"
            esc_label = escape_caption(label)
            lbl_stream = f"s_lbl_{idx}"
            draw_lbl = (
                f"[{current_stream}]drawtext="
                f"fontfile='{escaped_font}':"
                f"text='{esc_label}':"
                f"fontsize=28:fontcolor=white:"
                f"box=1:boxcolor=0x1F2A44@0.88:boxborderw=10:"
                f"x=40:y=40:enable=lte(t\\,{hold_str})[{lbl_stream}]"
            )
            filter_parts.append(draw_lbl)
            current_stream = lbl_stream

        segment_outputs.append(f"[{current_stream}]")

    concat_inputs = "".join(segment_outputs)
    concat_filter = f"{concat_inputs}concat=n={len(segments)}:v=1:a=0[v_base]"
    filter_parts.append(concat_filter)
    v_last = "v_base"

    # End card overlay
    end_card = plan.get("endCard")
    if end_card:
        ec_start = float(end_card.get("start", 0.0))
        ec_end = float(end_card.get("end", 0.0))
        ec_name = escape_caption(str(end_card.get("name", "")))
        ec_line = escape_caption(str(end_card.get("line", "")))
        ec_link = escape_caption(str(end_card.get("link", "")))

        v_ec = "v_endcard"
        timing = f"between(t\\,{ec_start:.3f}\\,{ec_end:.3f})"
        ec_filters = (
            f"[{v_last}]"
            f"drawbox=x=360:y=310:w=1200:h=460:color=0xFFFDF8@0.96:t=fill:enable={timing},"
            f"drawtext=fontfile='{escaped_font}':text='{ec_name}':fontsize=96:fontcolor=0x1F2A44:x=(w-text_w)/2:y=370:enable={timing},"
            f"drawtext=fontfile='{escaped_font}':text='{ec_line}':fontsize=44:fontcolor=0x1F2A44:x=(w-text_w)/2:y=520:enable={timing},"
            f"drawtext=fontfile='{escaped_font}':text='{ec_link}':fontsize=36:fontcolor=0xC2553A:x=(w-text_w)/2:y=620:enable={timing}"
            f"[{v_ec}]"
        )
        filter_parts.append(ec_filters)
        v_last = v_ec

    # Burn captions
    captions = plan.get("captions", [])
    for c_idx, cap in enumerate(captions):
        start = float(cap.get("start", 0.0))
        end = float(cap.get("end", 0.0))
        text = cap.get("text", "")

        cap_txt_path = os.path.join(temp_dir, f"cap_{c_idx}.txt")
        with open(cap_txt_path, "w", encoding="utf-8") as f:
            f.write(text)

        esc_txt_path = cap_txt_path.replace("\\", "/").replace(":", r"\:")
        v_next = f"v_cap_{c_idx}"
        cap_timing = f"between(t\\,{start:.3f}\\,{end:.3f})"
        cap_filter = (
            f"[{v_last}]drawtext="
            f"fontfile='{escaped_font}':"
            f"textfile='{esc_txt_path}':"
            f"fontsize=48:fontcolor=white:"
            f"box=1:boxcolor=0x1F2A44@0.88:boxborderw=22:"
            f"x=(w-text_w)/2:y=h-text_h-80:"
            f"enable={cap_timing}[{v_next}]"
        )
        filter_parts.append(cap_filter)
        v_last = v_next

    return ";".join(filter_parts), v_last


def generate_contact_sheet(
    out_mp4: str,
    captions: list[dict[str, Any]],
    sheet_path: str,
    font_path: str,
    temp_dir: str,
) -> None:
    """Generate contact sheet grid with mid caption frames and text labels."""
    if not captions:
        return

    escaped_font = font_path.replace(":", r"\:")
    cell_files: list[str] = []

    for idx, cap in enumerate(captions, 1):
        start = float(cap.get("start", 0.0))
        end = float(cap.get("end", 0.0))
        mid_time = (start + end) / 2.0
        text = cap.get("text", "")

        txt_file = os.path.join(temp_dir, f"sheet_text_{idx}.txt")
        with open(txt_file, "w", encoding="utf-8") as f:
            f.write(f"#{idx}: {text}")
        esc_txt_file = txt_file.replace("\\", "/").replace(":", r"\:")

        cell_file = os.path.join(temp_dir, f"sheet_cell_{idx}.png")
        cell_files.append(cell_file)

        filter_cell = (
            f"scale=640:360,"
            f"pad=w=640:h=430:x=0:y=0:color=0xF6F1E7,"
            f"drawtext=fontfile='{escaped_font}':textfile='{esc_txt_file}':"
            f"fontsize=18:fontcolor=0x1F2A44:x=12:y=380"
        )

        cmd = [
            "ffmpeg",
            "-y",
            "-ss",
            f"{mid_time:.3f}",
            "-i",
            out_mp4,
            "-frames:v",
            "1",
            "-vf",
            filter_cell,
            cell_file,
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            raise RuntimeError(f"Failed to generate contact sheet cell {idx}: {res.stderr}")

    rows = (len(captions) + 2) // 3
    list_file = os.path.join(temp_dir, "sheet_inputs.txt")
    with open(list_file, "w", encoding="utf-8") as f:
        for cf in cell_files:
            escaped_cf = cf.replace("\\", "/")
            f.write(f"file '{escaped_cf}'\n")

    cmd_tile = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list_file,
        "-vf",
        f"tile=3x{rows}:color=0xF6F1E7",
        "-frames:v",
        "1",
        sheet_path,
    ]
    p_tile = subprocess.run(cmd_tile, capture_output=True, text=True)
    if p_tile.returncode != 0:
        raise RuntimeError(f"Failed to tile contact sheet: {p_tile.stderr}")

    # If sheet_path has a sister convention, write to it too
    if sheet_path.endswith(".mp4.sheet.png"):
        sister = sheet_path.replace(".mp4.sheet.png", ".sheet.png")
        try:
            import shutil
            shutil.copyfile(sheet_path, sister)
        except OSError:
            pass
    elif sheet_path.endswith(".sheet.png") and not sheet_path.endswith(".mp4.sheet.png"):
        sister = sheet_path.replace(".sheet.png", ".mp4.sheet.png")
        try:
            import shutil
            shutil.copyfile(sheet_path, sister)
        except OSError:
            pass


def read_length(out_mp4: str) -> float:
    """Read media length using ffprobe."""
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        out_mp4,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return float(res.stdout.strip())


def read_integrated_loudness(out_mp4: str) -> float:
    """Read integrated loudness using ebur128 filter."""
    cmd = ["ffmpeg", "-i", out_mp4, "-af", "ebur128", "-f", "null", "-"]
    res = subprocess.run(cmd, capture_output=True, text=True)
    match = re.search(r"Integrated loudness:\s+I:\s+([-\d\.]+)\s+LUFS", res.stderr)
    if not match:
        raise RuntimeError("Could not find integrated loudness in ebur128 output.")
    return float(match.group(1))


def cut_film(plan_path: str, out_path: str, any_length: bool = False) -> None:
    """Run full film cutting pipeline."""
    with open(plan_path, "r", encoding="utf-8") as f:
        plan = json.load(f)

    plan_dir = os.path.dirname(os.path.abspath(plan_path))
    total_length = validate_plan(plan, plan_dir, any_length=any_length)

    out_dir = os.path.dirname(os.path.abspath(out_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    with tempfile.TemporaryDirectory() as td:
        # Generate music
        audio_buf = generate_pad_music(total_length, sample_rate=48000)

        # Mix clicks
        clicks = [float(c) for c in plan.get("clicks", [])]
        mix_clicks(audio_buf, clicks, sample_rate=48000)

        # Write raw wav
        raw_wav = os.path.join(td, "audio_raw.wav")
        write_wav(raw_wav, audio_buf, sample_rate=48000)

        # Loudnorm
        norm_wav = os.path.join(td, "audio_norm.wav")
        two_pass_loudnorm(raw_wav, norm_wav)

        # Gather inputs
        takes = plan.get("takes", {})
        take_names = sorted(takes.keys())
        take_indices = {name: idx for idx, name in enumerate(take_names)}

        input_args: list[str] = []
        for name in take_names:
            resolved_take = resolve_path(takes[name], plan_dir)
            input_args.extend(["-i", resolved_take])

        audio_input_idx = len(take_names)
        input_args.extend(["-i", norm_wav])

        font_path = get_font_path()
        filter_graph, out_label = build_video_filtergraph(plan, take_indices, td, font_path)

        cmd_render = [
            "ffmpeg",
            "-y",
            *input_args,
            "-filter_complex",
            filter_graph,
            "-map",
            f"[{out_label}]",
            "-map",
            f"{audio_input_idx}:a",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            "18",
            "-r",
            "30",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            out_path,
        ]

        p_render = subprocess.run(cmd_render, capture_output=True, text=True)
        if p_render.returncode != 0:
            raise RuntimeError(f"Video render failed: {p_render.stderr}")

        # Post export verification
        length_read = read_length(out_path)
        loudness_read = read_integrated_loudness(out_path)
        print(f"Exported length: {length_read:.2f} s")
        print(f"Integrated loudness: {loudness_read:.1f} LUFS")

        # Contact sheet
        sheet_path = (
            out_path[:-4] + ".sheet.png" if out_path.endswith(".mp4") else out_path + ".sheet.png"
        )
        generate_contact_sheet(out_path, plan.get("captions", []), sheet_path, font_path, td)


def main() -> None:
    """CLI entrypoint for cut.py."""
    parser = argparse.ArgumentParser(description="Cut film from a plan file.")
    parser.add_argument("plan", help="Path to plan JSON file.")
    parser.add_argument("out", help="Path to output MP4 file.")
    parser.add_argument(
        "--any-length",
        action="store_true",
        help="Relax the length check (used only by tests).",
    )

    args = parser.parse_args()

    try:
        cut_film(args.plan, args.out, any_length=args.any_length)
    except PlanValidationError as err:
        sys.stderr.write(f"Validation error: {err}\n")
        sys.exit(1)
    except Exception as err:
        sys.stderr.write(f"Export error: {err}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
