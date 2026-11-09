-- The measured room of each design (RoomSpec JSON). Old rows get today's sample room.
ALTER TABLE designs ADD COLUMN room_spec TEXT NOT NULL DEFAULT '{"width":380,"depth":320,"door":{"left":220,"width":80},"owned":{"desk":{"w":120,"d":60,"h":75},"deskChair":{"w":55,"d":55,"h":90},"bookshelf":{"w":80,"d":30,"h":180}}}';
