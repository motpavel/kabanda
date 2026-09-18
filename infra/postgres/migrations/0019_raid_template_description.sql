ALTER TABLE raid_templates ADD COLUMN description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 3000);
