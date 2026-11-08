import json
# (take, in, out, speed, label, captions[(src_start, src_end, text)], clicks[src_t])
S = [
 ("main", 2.0, 8.7, 1.0, "", [(2.3, 8.6, "A renter's room. The desk stays.")], []),
 ("main", 8.7, 17.5, 1.0, "", [(9.0, 17.4, "This chair looks right. It blocks the door.")], []),
 ("main", 17.5, 27.0, 1.0, "", [(18.0, 26.9, "One click. Real size from the listing. The maths is in code.")], [19.3]),
 ("main", 27.0, 52.6, 1.6, "", [(27.5, 52.4, "Door swing and a 76 cm walkway are checked on every move.")], [26.9, 33.6, 44.2]),
 ("main", 52.5, 63.5, 1.0, "", [(53.0, 63.4, "Say it in words. The model writes the search.")], [53.2, 62.6]),
 ("main", 71.5, 78.5, 1.0, "8 s later", [(71.6, 78.4, "Code checks every word before it is searched.")], []),
 ("main", 78.5, 90.5, 1.0, "", [(79.0, 90.4, "Sizes come from the listing. A missing size stays unknown.")], [81.2]),
 ("main", 90.5, 114.0, 1.35, "", [(90.6, 100.5, "A shop changed its price, so RoomWeft asks for a new quote."), (100.6, 113.9, "Test money to our own PayPal sandbox merchant. Nothing ships.")], [91.5, 94.2, 101.2, 103.4]),
 ("paypal", 11.0, 25.5, 1.6, "", [(11.2, 25.4, "Or pay with a PayPal sandbox buyer.")], [12.0]),
 ("main", 114.0, 134.5, 1.15, "", [(114.2, 126.4, "Every paid line is tied to an object in the room."), (126.6, 134.4, "Every PayPal event is checked before it is stored.")], []),
 ("main", 134.5, 148.0, 1.0, "", [(134.8, 147.9, "Refund one piece. The room and the receipt part ways, on purpose.")], [135.6]),
 ("walk", 12.5, 26.5, 1.0, "", [(12.8, 26.4, "Walk it before you pay for it.")], []),
 ("walk", 0.8, 11.8, 1.0, "", [(1.0, 6.2, "Live search, live AI and live sandbox are each labelled."), (6.3, 11.7, "When a cap is spent, a labelled saved run takes over.")], [5.6]),
 ("phone", 0.5, 9.5, 1.0, "", [(0.8, 9.4, "The same room on a phone.")], [6.0]),
 ("main", 2.0, 9.0, 1.0, "", [], []),
]
segments, captions, clicks = [], [], []
t = 0.0
for take, a, b, sp, label, caps, cl in S:
    segments.append({"take": take, "in": a, "out": b, "speed": sp, "label": label, "pip": None})
    for s0, s1, text in caps:
        captions.append({"start": round(t + (s0 - a) / sp, 2), "end": round(t + (s1 - a) / sp, 2), "text": text})
    for c in cl:
        if a <= c <= b: clicks.append(round(t + (c - a) / sp, 2))
    t += (b - a) / sp
total = round(t, 2)
plan = {"takes": {k: f"out/film/{k}.webm" for k in ["main", "paypal", "phone", "walk"]},
        "segments": segments, "captions": captions, "clicks": clicks,
        "endCard": {"start": round(total - 7.0, 2), "end": total, "name": "RoomWeft", "line": "Keep what you love. Fit the rest.", "link": "roomweft.midknight-labs.workers.dev"}}
json.dump(plan, open("out/film/plan.json", "w", encoding="utf-8"), indent=1)
print("total", total, "captions", len(captions), "clicks", len(clicks))
for c in captions: print(c["start"], c["end"], len(c["text"]), c["text"])
