/** Recognize supervisor admission only at its fixed argument position and shared lock path. */
export const hasPublicationAdmission = (body) =>
  /editor-view-supervisor\.py" (?:\d+|none) 5\s+\\\s+--(?:deferred-)?lock "\$root\/\.devenv\/editor-view-publication\.lock"/u.test(
    body,
  )
