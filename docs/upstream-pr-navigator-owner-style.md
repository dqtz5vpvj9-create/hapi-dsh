# Scope file-navigator coverage to its mounted owner

Appending unrelated Chat nodes currently makes the file navigator's two unqualified `:has()` selectors invalidate ancestor subtrees through BODY and HTML, even with no file navigator mounted. A bounded real-browser trace attributes 54 subtree invalidations to those exact rules; merely placing an owner `:is()` guard before `:has()` does not remove them.

Publish the navigator's existing fill mode on its actual layout row and mark the navigator's direct seat. Reuse the face's existing layout-parent lookup, which skips `display: contents` Factory wrappers. Cover other row children through ordinary class selectors, keep the narrow-viewport rule in CSS, and withdraw the classes on mode changes, hiding or unmount. The navigator's public Factory props and source APIs stay unchanged.

The source component contracts check publication and cleanup without disturbing consumer classes. The compiled real stylesheet checks its file/preview coverage and unrelated parents. A Chromium fixture additionally checks narrow/wide viewport rules, transparent seats and keyboard focus. An exact single-page style diagnostic removes the attributed ancestor invalidations; complete installed-reader geometry and performance are evaluated separately.
