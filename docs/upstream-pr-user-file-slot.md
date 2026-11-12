# Expose the file card as a public Chat leaf Slot

UserContent already delegates image attachments to a session Slot, while file cards are fixed inert markup. This change exposes `conversation.chat.user.file` with one FileAttachmentRef so a source integration can add authorized navigation without replacing the user-message renderer. The shipped occupant is the extracted original UserFileCard, with unchanged markup and no default action.

Validation covers the pinned public SlotTestRuntime, replacement with an explicit click action, exact file identity, removal restoring the inert card, mixed attachment order and unchanged user-content rows. No new dependency or runtime source mutation is introduced. This draft is local; no upstream PR has been sent.
