-- Slice (issue #57): reference field on watches.
--
-- The "reference" of a watch is its manufacturer-assigned reference
-- number — e.g. "3570.50" for an Omega Speedmaster, "126610LN" for a
-- Rolex Submariner. Collectors use it as the primary identifier of
-- a specific model variant, so surfacing it on the watch record (and
-- on the public /w/:id page) makes the site meaningful to the
-- audience.
--
-- Design notes:
--   * Optional — plenty of watches have no official reference
--     (vintage, microbrands, one-offs).
--   * No index: always queried together with the watch row by id.
--   * Max length is enforced at the Zod layer (50 chars). References
--     run the gamut from "2824" to "IW3777-14" to "M79030B-0001" but
--     50 handily covers all real-world formats.

ALTER TABLE watches ADD COLUMN reference TEXT;
