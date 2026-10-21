# Voice provenance

The protocol, personality, context-formatting and browser speech modules in this directory and `src/client/source-voice` are adapted from the original HAPI commit `0f8ef6970884c92fb2ddca3070be2ec56cb50333`. Their individual source paths are recorded in file headers. HAPI is distributed under AGPL-3.0-only; the project LICENSE and NOTICE retain that attribution.

The adapters retain the original provider wire protocols and prompt fixtures. Changes bind each operation to its explicit source session, use the official DSH composer and submission owner, avoid permanent provider keys in browser storage, and add cancellation, bounded audio/context buffering and per-workspace microphone ownership. They do not replace any DSH source or renderer. Model-provider and microphone fixtures verify protocol/lifecycle behavior; they do not certify an external provider account or audio recognition quality.
