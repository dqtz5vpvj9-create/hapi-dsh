# Keep accepted Conversation views when registry rebuilding fails

Replacing a view or grouping definition currently mutates the live assembler before replacement builders validate. A thrown group rebuild can leave its published read accessor without Chat data while the reader still reports earlier history.

Build and validate the next registry generation privately, then install it in the existing public assembler. Preserve accepted views and event dispatch rules on failure, defer all candidate publications, retain unchanged keyed group sources, and isolate one reader/binding failure from other readers. Subsequent valid registry changes recover through the same rebuild path.

Validation: exact previous source bytes fail the four new accepted-body/atomic-target assertions. Focused assembler, registry, group-store and history contracts pass; an expanded continuation case also covers dependency replay, normal replacement and append after commit, later target activation and old lease release. A private source-event replay retains the original 27 events / 7 Chat items / 5 groups across the controlled build failure. No live source or browser operation was used. Original screenshot cause remains unknown.
