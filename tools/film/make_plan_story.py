"""Build out/film/plan.json for the one renter cut from the takes' beats.json.

python tools/film/make_plan_story.py <beats.json> <plan.json>

Each beat with a screen box becomes a close up (crop) of that box, after a short wide shot, so numbers are readable.
Captions are written from what the takes really show. The length is fitted to 2:45 to 2:55 by speed changes on the
walk and plan shots and by the hold lengths.
"""
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


def main(beats_path, plan_path):
    data = json.load(open(beats_path, encoding="utf-8"))
    beats = {(b["take"], b["name"]): b for b in data["beats"]}
    takes = {k: os.path.relpath(v, os.path.dirname(os.path.abspath(plan_path))).replace(os.sep, "/") for k, v in data["takes"].items()}
    has = lambda take, name: (take, name) in beats and beats[(take, name)]["end"] > beats[(take, name)]["t"]

    # (take, beat, wide seconds before the close up, close up?, speed, label, caption)
    shots = []
    add = lambda *a: shots.append(a)
    add("story", "load", 0, False, 1.0, "", "A renter needs a reading corner. The desk stays.")
    if has("story", "room"):
        add("story", "room", 0, True, 1.0, "", "Enter your room and furniture sizes. This film uses the 380 by 320 cm sample.")
    if has("brief", "understood"):
        add("brief", "typed", 0, True, 1.0, "A separate live design", "Say it in words. The model turns it into a budget and search words.")
        add("brief", "understood", 0, True, 1.0, "Wait removed", "Code checks every word before it is searched.")
    add("story", "door-room", 0, False, 1.0, "", "This chair looks right. In this corner it blocks the door swing.")
    add("story", "door-card", 0, True, 1.0, "", "Sizes come from the listing, shown beside the finding.")
    add("story", "swap", 0, True, 1.0, "", "One click swaps in a chair that passes. The note gives the numbers.")
    add("story", "swap-card", 0, True, 1.0, "", "One click swaps in a chair that passes. The note gives the numbers.")
    add("story", "plan-path", 0, False, 1.0, "", "Plan view draws the walkway from the door to each chair.")
    add("story", "plan-fail", 2.5, False, 1.0, "", "Move the shelf into the path and the 76 cm walkway check fails.")
    add("story", "plan-pass", 0, False, 1.0, "", "Put it back and it passes.")
    if has("story", "unverified-option"):
        add("story", "unverified-option", 0, True, 1.0, "", "This rug's listing has no usable size.")
    add("story", "unverified-card", 0, True, 1.0, "", "RoomWeft never guesses. Its fit stays unverified.")
    add("story", "unverified-room", 0, False, 1.0, "", "RoomWeft never guesses. Its fit stays unverified.")
    add("story", "walk", 0, False, 1.35, "", "Walk the room before you pay. The models stand in for the real products.")
    add("story", "summary", 0, True, 1.0, "", "The total, the budget and any open checks stay in view.")
    add("story", "basket", 0, True, 1.0, "", "Freeze the quote. The room and the prices are locked together.")
    if has("story", "reprice"):
        add("story", "reprice", 0, True, 1.0, "", "A shop changed its price, so RoomWeft asks for a new quote.")
    add("story", "quote", 0, False, 1.0, "", "Pay with PayPal's sandbox test card. Test money only. Nothing ships.")
    add("story", "pay", 0, True, 1.0, "", "A real sandbox order and capture, with both ids on the receipt.")
    add("story", "thread", 0, False, 1.0, "", "Each paid line points to its piece in the room.")
    add("story", "events", 0, True, 1.0, "", "This PayPal event passed the signature check before it was stored.")
    add("story", "refund", 0, True, 1.0, "", "Refund one piece. The receipt line shows it returned.")
    add("story", "returned-room", 0, False, 1.0, "", "The room shows the same piece as returned.")
    if has("story", "replacement-quote"):
        add("story", "replacement-quote", 0, True, 1.0, "", "Replace it with a new quote for that one piece only.")
        if has("story", "replacement-reprice"):
            add("story", "replacement-reprice", 0, True, 1.0, "", "The shop price changed, so the replacement is quoted again.")
        add("story", "replacement-paid", 0, True, 1.0, "", "Paid with a PayPal sandbox buyer. The first receipt is unchanged.")
    if has("phone", "phone-picks"):
        add("phone", "phone-picks", 0, False, 1.0, "", "The same room on a phone.")
    add("story", "status", 0, True, 1.0, "", "Live search, AI and sandbox are labelled. A spent search cap uses a saved run.")

    segments, captions = [], []
    t = 0.0
    for take, name, wide, close, speed, label, text in shots:
        if not has(take, name):
            continue
        b = beats[(take, name)]
        start, end = b["t"], b["end"]
        start_cap = t
        if close and b.get("box"):
            if wide > 0:
                segments.append({"take": take, "in": round(start - wide, 2), "out": round(start, 2), "speed": 1.0, "label": label})
                t += wide
                label = ""
            seg = {"take": take, "in": round(start, 2), "out": round(end, 2), "speed": speed, "label": label, "crop": crop_for(b["box"])}
        else:
            seg = {"take": take, "in": round(start - wide, 2) if wide else round(start, 2), "out": round(end, 2), "speed": speed, "label": label}
        if seg["label"]:
            seg["labelHold"] = 2.5
        segments.append(seg)
        t += (seg["out"] - seg["in"]) / seg["speed"]
        if captions and captions[-1]["text"] == text:
            captions[-1]["end"] = round(t - 0.15, 2)
        else:
            captions.append({"start": round(start_cap + 0.25, 2), "end": round(t - 0.15, 2), "text": text})

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
    json.dump(plan, open(plan_path, "w", encoding="utf-8"), indent=1)
    print(f"segments {len(segments)}, captions {len(captions)}, length {t + end_len:.2f} s, hold factor {factor:.3f}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
