/** A failure with a message meant for the user. */
export class RecordingError extends Error {}

/** Nothing was captured: there is nothing to keep or retry. */
export class EmptyRecordingError extends RecordingError {}
