ALTER TABLE quotes ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'paypal' CHECK (payment_method IN ('paypal', 'card'));
