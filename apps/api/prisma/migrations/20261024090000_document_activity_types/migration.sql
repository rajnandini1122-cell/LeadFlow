-- Timeline entries for files attached to (and removed from) a lead.
--
-- One statement, so it is atomic by itself. ADD VALUE is kept out of an
-- explicit transaction and made replayable with IF NOT EXISTS, the convention
-- of every earlier enum extension in this history. Appending values changes
-- no stored row and no existing value's meaning.
ALTER TYPE "activity_type" ADD VALUE IF NOT EXISTS 'DOCUMENT_ATTACHED';
ALTER TYPE "activity_type" ADD VALUE IF NOT EXISTS 'DOCUMENT_REMOVED';
