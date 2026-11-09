"""Build out/film/plan.json for the one renter cut from the takes' beats.json.

python tools/film/make_plan_story.py <beats.json> <plan.json> [--voice <lines.json> <durations.json>]

Each beat with a screen box becomes a close up (crop) of that box, after a short wide shot, so numbers are readable.
Captions are written from what the takes really show. The length is fitted to 2:45 to 2:55 by speed changes on the
walk and plan shots and by the hold lengths.
"""
import argparse
import json
import os
import sys

W, H = 1920, 1080
TARGET = 170.0


def crop_for(box, pad=40):
    """A 16:9 region around a screen box, clamped to the frame, at least 800 x 450."""
    if not box:
        return None
    # A box taller than the screen (a long card) is cut to its top part.
    x, y, w, h = box["x"] - pad, max(0, box["y"]) - pad, box["w"] + 2 * pad, min(box["h"], 560) + 2 * pad
    cw = max(w, h * 16 / 9, 800)
    ch = cw * 9 / 16
    cx, cy = x + w / 2, y + min(h, ch) / 2
    left = min(max(0, cx - cw / 2), W - cw)
    top = min(max(0, cy - ch / 2), H - ch)
    return {"x": int(left), "y": int(top), "w": int(cw), "h": int(ch)}


def main(beats_path, plan_path, voice_args=None):
    with open(beats_path, "r", encoding="utf-8") as f_beats:
        data = json.load(f_beats)
    beats = {(b["take"], b["name"]): b for b in data["beats"]}
    plan_dir = os.path.dirname(os.path.abspath(plan_path))
    takes = {}
    for k, v in data["takes"].items():
        try:
            rel = os.path.relpath(v, plan_dir).replace(os.sep, "/")
        except ValueError:
            rel = v.replace(os.sep, "/")
        takes[k] = rel
    has = lambda take, name: (take, name) in beats and beats[(take, name)]["end"] > beats[(take, name)]["t"]

    # (take, beat, wide seconds before the close up, close up?, speed, label, caption)
    shots = []
    add = lambda *a: shots.append(a)
    add("story", "load", 0, False, 1.0, "", "RoomWeft checks real furniture against your real room, before you buy.")
    if has("story", "room"):
        add("story", "room", 0, True, 1.0, "", "Start with your room and the furniture you keep. This sample is 380 by 320.")
    if has("brief", "understood"):
        add("brief", "typed", 0, True, 1.0, "A separate live design", "Then just say what you want.")
        add("brief", "understood", 0, True, 1.0, "Wait removed", "AI turns it into a budget and search words. Code checks every word first.")
    add("story", "door-room", 0, False, 1.0, "", "This chair looks great. But it blocks the door.")
    add("story", "door-card", 0, True, 1.0, "", "The sizes come straight from the listing, right beside the problem.")
    add("story", "swap", 0, True, 1.0, "", "One click swaps in a chair that fits. The note shows the numbers.")
    add("story", "swap-card", 0, True, 1.0, "", "One click swaps in a chair that fits. The note shows the numbers.")
    add("story", "plan-path", 0, False, 1.0, "", "Plan view draws the walkway from the door.")
    add("story", "plan-fail", 2.5, False, 1.0, "", "Push the shelf into the path, and the 76 centimetre walkway check fails.")
    add("story", "plan-pass", 0, False, 1.0, "", "Put it back. It passes.")
    if has("story", "unverified-option"):
        add("story", "unverified-option", 0, True, 1.0, "", "This rug has no usable size.")
    add("story", "unverified-card", 0, True, 1.0, "", "So RoomWeft never guesses. It marks the fit unverified.")
    add("story", "unverified-room", 0, False, 1.0, "", "So RoomWeft never guesses. It marks the fit unverified.")
    add("story", "walk", 0, False, 1.35, "", "Now walk through your room before you pay. Every model stands in for a real product you can buy.")
    add("story", "summary", 0, True, 1.0, "", "The total, the budget and open checks stay in view.")
    add("story", "basket", 0, True, 1.0, "", "Freeze the quote. The room and the prices lock together.")
    if has("story", "reprice"):
        add("story", "reprice", 0, True, 1.0, "", "A shop changed its price, so RoomWeft asks for a new quote.")
    add("story", "quote", 0, False, 1.0, "", "Now pay by card through PayPal.")
    add("story", "pay", 0, True, 1.0, "", "A real PayPal order and capture, with both IDs on the receipt.")
    add("story", "thread", 0, False, 1.0, "", "Each paid line points to its piece in the room.")
    add("story", "events", 0, True, 1.0, "", "PayPal's event passed the signature check before we stored it.")
    add("story", "refund", 0, True, 1.0, "", "Refund one piece. The receipt shows it returned.")
    add("story", "returned-room", 0, False, 1.0, "", "And the room shows it returned too.")
    if has("story", "replacement-quote"):
        add("story", "replacement-quote", 0, True, 1.0, "", "Replace it with a new quote for just that piece.")
        if has("story", "replacement-reprice"):
            add("story", "replacement-reprice", 0, True, 1.0, "", "The shop price changed, so the replacement gets quoted again.")
        add("story", "replacement-paid", 0, True, 1.0, "", "Paid with a PayPal account. The first receipt stays the same.")
    if has("phone", "phone-picks"):
        add("phone", "phone-picks", 0, False, 1.0, "", "The same room works on your phone.")
    add("story", "status", 0, True, 1.0, "", "Live search and AI are labelled. If search runs out, a saved run takes over.")

    segments, captions = [], []
    t = 0.0
    cap_to_seg_indices = []
    for take, name, wide, close, speed, label, text in shots:
        if not has(take, name):
            continue
        b = beats[(take, name)]
        start, end = b["t"], b["end"]
        start_cap = t
        shot_segs = []
        if close and b.get("box"):
            if wide > 0:
                segments.append({"take": take, "in": round(start - wide, 2), "out": round(start, 2), "speed": 1.0, "label": label})
                shot_segs.append(len(segments) - 1)
                t += wide
                label = ""
            seg = {"take": take, "in": round(start, 2), "out": round(end, 2), "speed": speed, "label": label, "crop": crop_for(b["box"])}
        else:
            seg = {"take": take, "in": round(start - wide, 2) if wide else round(start, 2), "out": round(end, 2), "speed": speed, "label": label}
        if seg["label"]:
            seg["labelHold"] = 2.5
        segments.append(seg)
        shot_segs.append(len(segments) - 1)
        t += (seg["out"] - seg["in"]) / seg["speed"]
        if captions and captions[-1]["text"] == text:
            captions[-1]["end"] = round(t - 0.15, 2)
            if cap_to_seg_indices:
                cap_to_seg_indices[-1].extend(shot_segs)
        else:
            captions.append({"start": round(start_cap + 0.25, 2), "end": round(t - 0.15, 2), "text": text})
            cap_to_seg_indices.append(list(shot_segs))

    if not voice_args:
        # End card over a held wide shot of the first room.
        first = beats[("story", "load")]
        end_len = 6.0
        body = t
        # Fit the body to TARGET minus the end card by one common speed factor on the holds.
        want = TARGET - end_len
        factor = body / want
        t = 0.0
        for seg, cap_index in zip(segments, range(len(segments))):
            seg["speed"] = round(seg["speed"] * factor, 4)
        for seg in segments:
            seg["speed"] = min(max(seg["speed"], 0.6), 3.5)
        # Recompute caption times from the scaled segments.
        scale_times = []
        t = 0.0
        for seg in segments:
            d = (seg["out"] - seg["in"]) / seg["speed"]
            scale_times.append((t, t + d, (seg["out"] - seg["in"])))
            t += d
        ratio = t / body
        for cap in captions:
            cap["start"] = round(cap["start"] * ratio, 2)
            cap["end"] = round(cap["end"] * ratio, 2)
        segments.append({"take": "story", "in": round(first["t"], 2), "out": round(first["t"] + end_len, 2), "speed": 1.0, "label": ""})
        end_card = {"start": round(t, 2), "end": round(t + end_len, 2), "name": "RoomWeft", "line": "Keep what you love. Fit the rest.", "link": "roomweft.midknight-labs.workers.dev"}
        clicks = []
        plan = {"takes": takes, "segments": segments, "captions": captions, "clicks": clicks, "endCard": end_card}
        with open(plan_path, "w", encoding="utf-8") as f_plan:
            json.dump(plan, f_plan, indent=1)
        print(f"segments {len(segments)}, captions {len(captions)}, length {t + end_len:.2f} s, hold factor {factor:.3f}")
        return

    # Voice mode enabled
    lines_path, durations_path = voice_args
    with open(lines_path, "r", encoding="utf-8") as f_lines:
        lines_data = json.load(f_lines)
    with open(durations_path, "r", encoding="utf-8") as f_durations:
        durations_data = json.load(f_durations)
    text_to_line = {item["text"]: item["id"] for item in lines_data.get("lines", [])}

    # Match captions: each caption whose text equals a line's text exactly gets "voice": <id>.
    matched_line_ids = set()
    for cap in captions:
        text = cap["text"]
        if text in text_to_line:
            v_id = text_to_line[text]
            cap["voice"] = v_id
            matched_line_ids.add(v_id)
        else:
            print(f"Caption with no line: {text}")

    for item in lines_data.get("lines", []):
        if item["id"] not in matched_line_ids:
            print(f"Line with no caption: {item['id']}: {item['text']}")

    first = beats[("story", "load")]
    end_len = 6.0
    body = t
    want = TARGET - end_len
    factor = body / want
    for seg in segments:
        seg["speed"] = round(seg["speed"] * factor, 4)
    for seg in segments:
        seg["speed"] = min(max(seg["speed"], 0.6), 3.5)

    def update_timeline():
        cur_t = 0.0
        seg_times = []
        for s in segments:
            d = (s["out"] - s["in"]) / s["speed"]
            seg_times.append((cur_t, cur_t + d))
            cur_t += d
        for c_idx, s_idxs in enumerate(cap_to_seg_indices):
            s_start = seg_times[s_idxs[0]][0]
            s_end = seg_times[s_idxs[-1]][1]
            captions[c_idx]["start"] = round(s_start + 0.25, 2)
            captions[c_idx]["end"] = round(s_end - 0.15, 2)
        return cur_t

    body = update_timeline()

    # A voiced caption must last at least its voice length plus 0.4 s.
    # Where a caption is too short, lower the speed of the segments under that caption (never under 0.5) until it fits.
    # If 0.5 is not enough, print that caption and exit 1.
    for cap_idx, cap in enumerate(captions):
        if "voice" not in cap:
            continue
        v_id = cap["voice"]
        if v_id not in durations_data:
            continue
        v_len = float(durations_data[v_id])
        min_cap_dur = v_len + 0.4
        cur_cap_dur = cap["end"] - cap["start"]

        if cur_cap_dur < min_cap_dur:
            s_idxs = cap_to_seg_indices[cap_idx]
            needed_seg_dur = min_cap_dur + 0.40

            max_seg_dur = sum((segments[i]["out"] - segments[i]["in"]) / 0.5 for i in s_idxs)
            if max_seg_dur < needed_seg_dur - 1e-4:
                print(f"Caption too short even at speed 0.5: {cap['text']}")
                sys.exit(1)

            cur_seg_dur = sum((segments[i]["out"] - segments[i]["in"]) / segments[i]["speed"] for i in s_idxs)
            stretch = needed_seg_dur / cur_seg_dur
            for i in s_idxs:
                segments[i]["speed"] = max(0.5, round(segments[i]["speed"] / stretch, 4))

            # Ensure rounding does not leave it slightly short
            update_timeline()
            if (cap["end"] - cap["start"]) < min_cap_dur:
                for i in s_idxs:
                    if segments[i]["speed"] > 0.5:
                        segments[i]["speed"] = max(0.5, round(segments[i]["speed"] - 0.001, 4))
                update_timeline()

    # The whole film (end card included) must stay at or under 178 s.
    # If stretching pushes it over, raise the speed of segments under captions with room to spare (never over 3.5),
    # and repeat up to 20 times. If it still does not fit, print the numbers and exit 1.
    for _ in range(20):
        body = update_timeline()
        total_len = body + end_len
        if total_len <= 178.0:
            break

        excess = total_len - 177.8
        spare_segs = []
        spare_cur_dur = 0.0

        for c_idx, cap in enumerate(captions):
            cur_cap_dur = cap["end"] - cap["start"]
            s_idxs = cap_to_seg_indices[c_idx]
            if "voice" in cap:
                v_id = cap["voice"]
                if v_id in durations_data:
                    v_len = float(durations_data[v_id])
                    min_cap_dur = v_len + 0.4
                    room = cur_cap_dur - min_cap_dur
                    if room > 0.05:
                        for i in s_idxs:
                            if segments[i]["speed"] < 3.5:
                                spare_segs.append((i, c_idx, min_cap_dur))
                                spare_cur_dur += (segments[i]["out"] - segments[i]["in"]) / segments[i]["speed"]
            else:
                for i in s_idxs:
                    if segments[i]["speed"] < 3.5:
                        spare_segs.append((i, c_idx, None))
                        spare_cur_dur += (segments[i]["out"] - segments[i]["in"]) / segments[i]["speed"]

        if spare_cur_dur <= 0 or not spare_segs:
            break

        desired_dur = max(spare_cur_dur - excess, spare_cur_dur * 0.75)
        factor = spare_cur_dur / desired_dur

        for seg_i, c_idx, min_cap_dur in spare_segs:
            cur_s = segments[seg_i]["speed"]
            max_s = 3.5
            if min_cap_dur is not None:
                needed_seg_dur = min_cap_dur + 0.40
                raw = sum(segments[j]["out"] - segments[j]["in"] for j in cap_to_seg_indices[c_idx])
                max_s = min(3.5, raw / needed_seg_dur)
            new_s = min(max_s, cur_s * factor)
            if new_s > cur_s:
                segments[seg_i]["speed"] = round(new_s, 4)

    body = update_timeline()
    total_len = body + end_len
    if total_len > 178.0:
        print(f"Total film length {total_len:.2f} s exceeds 178 s: body {body:.2f} s, end card {end_len:.2f} s")
        sys.exit(1)

    segments.append({"take": "story", "in": round(first["t"], 2), "out": round(first["t"] + end_len, 2), "speed": 1.0, "label": ""})
    end_card = {"start": round(body, 2), "end": round(body + end_len, 2), "name": "RoomWeft", "line": "Keep what you love. Fit the rest.", "link": "roomweft.midknight-labs.workers.dev"}
    clicks = []
    plan = {"takes": takes, "segments": segments, "captions": captions, "clicks": clicks, "endCard": end_card}
    with open(plan_path, "w", encoding="utf-8") as f_plan:
        json.dump(plan, f_plan, indent=1)
    print(f"segments {len(segments)}, captions {len(captions)}, length {total_len:.2f} s")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build plan.json from beats.json")
    parser.add_argument("beats", help="Path to beats.json")
    parser.add_argument("plan", help="Path to plan.json")
    parser.add_argument(
        "--voice",
        nargs=2,
        metavar=("LINES", "DURATIONS"),
        help="Path to lines.json and durations.json",
    )
    args = parser.parse_args()
    main(args.beats, args.plan, voice_args=args.voice)
