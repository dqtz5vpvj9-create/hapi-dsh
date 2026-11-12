# Transactional Conversation registry rebuilding

A plugin registration change currently resets live view state and clears removed group stores before replacement builders and grouping validate. A thrown replacement therefore destroys accepted reads without a new source window.

Build the complete next registry generation in an independent official ConversationNodeAssembler. Capture the registry entries and event routing tables at construction; retain the last accepted generation for ordinary source updates after a rejected rebuild. Reuse the existing opt-in independent grouping fork contract. Defer candidate publication until all active targets build and all group records validate.

Commit validated context maps, location index, builders, views and dependency state to the original public assembler. Keep unchanged definitions' keyed group-source identities by installing their validated replacement in the original store. Clear replaced/removed stores only after the new view state is installed. Discarded candidates cannot publish or clear the live stores. Keep failures isolated per reader and binding; default-enabled internal diagnostics retain causes, and the next registration change retries rebuilding. No additional renderer, user control, protocol or source operation is introduced.

Builder create() must return a new isolated Session-owned builder and optional grouping fork() must return independently mutable state, as their existing SDK contracts specify. Ordinary accepted event updates and their cadence remain unchanged. SDK publication is a separate integration step. This fixes a proven conditional publication defect and does not establish the cause of the original user screenshot.
