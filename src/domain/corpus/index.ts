// Public surface of the corpus-collection domain module. Slice #81
// of PRD #73.
//
// Importers reach for `maybeIngest` (the gate that decides whether
// the photo + sidecar should be copied into the training corpus
// bucket) and `deleteUserCorpusObjects` (the retroactive-cleanup
// path for the consent_corpus 1→0 toggle on PATCH /api/v1/me).
export {
  maybeIngest,
  CORPUS_HIGH_CONFIDENCE_THRESHOLD,
  type MaybeIngestInput,
} from "./maybeIngest";
export {
  deleteUserCorpusObjects,
  type DeleteUserCorpusObjectsInput,
} from "./deleteUserCorpusObjects";
