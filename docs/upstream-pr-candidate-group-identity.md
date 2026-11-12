# Preserve opted-in grouping identity when validating history candidates

A complete-window candidate is assembled privately before publication. When an earlier page extends a Chat process group, the live assembler preserves the existing group key, while a fresh candidate assembler derives its key from the newly loaded first member. A reader on the collapsed group header can therefore fail the visible-anchor check even though the page retains that entire group.

Add optional `ConversationGroupDefinition.fork(context)` and use it to initialize independent candidate grouping state. Chat's process-group implementation copies its mutable state and keeps the existing member-run identity rule. Other group definitions keep their current behavior. Window capacity, real owner-eviction rejection, source positions, and reader correction remain unchanged.

Validation covers the actual Conversation candidate/publication path, candidate mutation isolation, Chat prefix extension, group splitting, and refusal to publish a window that removes the visible owner. Physical scrolling and performance remain separate browser acceptance checks.
